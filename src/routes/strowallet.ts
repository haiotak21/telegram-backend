import express from "express";
import axios, { AxiosError } from "axios";
import http from "http";
import https from "https";
import { z } from "zod";
import { ok, fail } from "../utils/apiResponse";

const router = express.Router();

const BITVCARD_BASE = "https://strowallet.com/api/bitvcard/";
const API_BASE = "https://strowallet.com/api/"; // for apicard-transactions
const STROWALLET_PREFER_IPV4 = String(process.env.STROWALLET_PREFER_IPV4 || "true").toLowerCase() !== "false";
const STROWALLET_HTTP_TIMEOUT_MS = Number(process.env.STROWALLET_HTTP_TIMEOUT_MS || 30000);
const httpAgent = STROWALLET_PREFER_IPV4 ? new http.Agent({ keepAlive: true, family: 4 } as any) : undefined;
const httpsAgent = STROWALLET_PREFER_IPV4 ? new https.Agent({ keepAlive: true, family: 4 } as any) : undefined;

const bitvcard = axios.create({
  baseURL: BITVCARD_BASE,
  timeout: STROWALLET_HTTP_TIMEOUT_MS,
  httpAgent,
  httpsAgent,
  headers: {
    // Some StroWallet endpoints require an auth header; allow overriding via env
    Authorization: process.env.STROWALLET_API_KEY ? `Bearer ${process.env.STROWALLET_API_KEY}` : undefined,
  },
});

function getDefaultMode() {
  return process.env.STROWALLET_DEFAULT_MODE || (process.env.NODE_ENV !== "production" ? "sandbox" : undefined);
}

function normalizeMode(mode?: string) {
  if (!mode) return undefined;
  const m = String(mode).toLowerCase();
  if (m === "live") return undefined;
  return m;
}

function applyDefaultMode<T extends { mode?: string }>(body: T): T {
  const defaultMode = normalizeMode(getDefaultMode());
  if (!body?.mode && defaultMode) return { ...body, mode: defaultMode } as T;
  return body;
}

function pickCardId(req: express.Request) {
  const v =
    (req.body as any)?.card_id ??
    (req.body as any)?.cardId ??
    req.query.card_id ??
    req.query.cardId ??
    (req.headers["x-card-id"] as any);
  if (v === undefined || v === null || v === "") {
    const err = new Error("card_id is required");
    (err as any).status = 400;
    throw err;
  }
  return String(v);
}

const api = axios.create({
  baseURL: API_BASE,
  timeout: STROWALLET_HTTP_TIMEOUT_MS,
  httpAgent,
  httpsAgent,
  headers: {
    Authorization: process.env.STROWALLET_API_KEY ? `Bearer ${process.env.STROWALLET_API_KEY}` : undefined,
  },
});

function requirePublicKey() {
  const key = process.env.STROWALLET_PUBLIC_KEY;
  if (!key) {
    const err = new Error("Missing STROWALLET_PUBLIC_KEY env");
    (err as any).status = 500;
    throw err;
  }
  return key;
}

function normalizeError(e: any) {
  // Axios error normalization
  if (typeof (axios as any).isAxiosError === "function" && (axios as any).isAxiosError(e)) {
    const ae = e as AxiosError<any>;
    const status = ae.response?.status ?? 400;
    const payload = ae.response?.data;
    const msg = payload?.message || payload?.error || ae.message || "Request failed";
    return { status, message: String(msg) };
  }
  const status = e?.status ?? 400;
  const msg = e?.message ?? "Request error";
  return { status, message: String(msg) };
}

function shouldDebugStroWallet() {
  return String(process.env.STROWALLET_DEBUG_LOGS || "").toLowerCase() === "true";
}

function maskValue(value: string, showStart = 4, showEnd = 2) {
  if (!value) return "";
  const str = String(value);
  if (str.length <= showStart + showEnd) return str;
  return `${str.slice(0, showStart)}***${str.slice(-showEnd)}`;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(headers: any): number | null {
  if (!headers) return null;
  const raw = headers["retry-after"] || headers["Retry-After"];
  if (!raw) return null;
  const asNumber = Number(raw);
  if (Number.isFinite(asNumber) && asNumber >= 0) {
    return Math.round(asNumber * 1000);
  }
  const asDate = new Date(String(raw));
  if (Number.isFinite(asDate.getTime())) {
    const diff = asDate.getTime() - Date.now();
    return diff > 0 ? diff : 0;
  }
  return null;
}

async function postWithRetry(url: string, payload: any, config: any) {
  const maxRetries = 4;
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    try {
      return await bitvcard.post(url, payload, config);
    } catch (err: any) {
      const status = err?.response?.status;
      if (status !== 429 || attempt === maxRetries - 1) throw err;
      const retryAfterMs = parseRetryAfterMs(err?.response?.headers);
      const backoffMs = retryAfterMs ?? 2000 * Math.pow(2, attempt);
      await delay(backoffMs);
    }
  }
  throw new Error("fund-card retry attempts exhausted");
}

let fundCardQueue = Promise.resolve();
function enqueueFundCard<T>(task: () => Promise<T>) {
  const run = fundCardQueue.then(task, task);
  fundCardQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

// 1) Create Customer
const internationalPhone = z.string().regex(/^[1-9]\d{10,14}$/); // e.g., 2348012345678 (no '+')
const mmddyyyy = z.string().regex(/^\d{2}\/\d{2}\/\d{4}$/);
const amountString = z
  .string()
  .regex(/^\d+(\.\d+)?$/)
  .refine((v) => Number(v) > 0, "amount must be greater than zero");
const CardIdSchema = z.union([z.string(), z.number()]).transform((v) => String(v));

// Accept either a remote URL or base64/data-uri for images (idImage, userPhoto)
const UrlOrBase64 = z
  .string()
  .refine((v) => {
    if (!v || typeof v !== "string") return false;
    // Data URI (e.g. data:image/png;base64,...) or raw base64 blob
    const dataUri = /^data:[^;\s]+;base64,[A-Za-z0-9+/=\s]+$/i;
    if (dataUri.test(v)) return true;
    // Try URL
    try {
      // new URL will throw if invalid
      // accept relative/absolute http(s) urls only
      const u = new URL(v);
      return u.protocol === "http:" || u.protocol === "https:" || u.protocol === "data:";
    } catch (err) {
      // not a URL -> test data URI or long base64 blob heuristics
    }
    // Raw base64: require a reasonably long string to reduce false positives
    const rawBase64 = /^[A-Za-z0-9+/=\s]{50,}$/;
    return rawBase64.test(v);
  }, "must be a valid URL or base64 data");

const CreateCustomerSchema = z.object({
  houseNumber: z.string().min(1),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  idNumber: z.string().min(1),
  customerEmail: z.string().email(),
  phoneNumber: internationalPhone,
  dateOfBirth: mmddyyyy, // MM/DD/YYYY
  idImage: UrlOrBase64,
  userPhoto: UrlOrBase64,
  line1: z.string().min(1),
  state: z.string().min(1),
  zipCode: z.string().min(1),
  city: z.string().min(1),
  country: z.string().min(1),
  idType: z.enum(["NIN", "PASSPORT", "DRIVING_LICENSE"]),
});

router.post("/create-user", async (req, res) => {
  try {
    const body = CreateCustomerSchema.parse(req.body || {});
    const public_key = requirePublicKey();
    const payload = { ...body, public_key };
    const queryParams = {
      public_key,
      houseNumber: body.houseNumber,
      firstName: body.firstName,
      lastName: body.lastName,
      idNumber: body.idNumber,
      customerEmail: body.customerEmail,
      phoneNumber: body.phoneNumber,
      dateOfBirth: body.dateOfBirth,
      line1: body.line1,
      state: body.state,
      zipCode: body.zipCode,
      city: body.city,
      country: body.country,
      idType: body.idType,
    } as Record<string, string>;

    const tryCardUserFallback = async () => {
      try {
        const altResp = await bitvcard.post("card-user/", payload, {
          headers: { "Content-Type": "application/json" },
          params: queryParams,
        });
        return altResp.data;
      } catch {
        const altResp = await bitvcard.get("card-user/", { params: queryParams });
        return altResp.data;
      }
    };

    const tryCreateUserGet = async () => {
      const resp = await bitvcard.get("create-user/", { params: queryParams });
      return resp.data;
    };

    let data: any;
    try {
      const resp = await bitvcard.post("create-user/", payload, {
        headers: { "Content-Type": "application/json" },
      });
      data = resp.data;
      const msg = String(data?.message || data?.error || "");
      if (data?.success === false && /register card user failed/i.test(msg)) {
        data = await tryCardUserFallback();
      }
    } catch (firstError: any) {
      if (firstError?.response?.status === 405) {
        data = await tryCreateUserGet();
      } else {
        // Fallback for provider deployments that only parse URL query params.
        try {
          const fallbackResp = await bitvcard.post("create-user/", payload, {
            headers: { "Content-Type": "application/json" },
            params: queryParams,
          });
          data = fallbackResp.data;
          console.warn("[strowallet] create-user primary attempt failed, fallback succeeded", {
            firstStatus: firstError?.response?.status,
            firstMessage: firstError?.response?.data?.message || firstError?.response?.data?.error || firstError?.message,
          });
        } catch (secondError: any) {
          data = await tryCardUserFallback();
          console.warn("[strowallet] create-user attempts failed; card-user fallback used", {
            firstStatus: firstError?.response?.status,
            firstMessage: firstError?.response?.data?.message || firstError?.response?.data?.error || firstError?.message,
            secondStatus: secondError?.response?.status,
            secondMessage: secondError?.response?.data?.message || secondError?.response?.data?.error || secondError?.message,
          });
        }
      }
    }
    const customerId =
      data?.response?.customerId ||
      data?.response?.customer_id ||
      data?.customerId ||
      data?.customer_id;
    if (!customerId && body.customerEmail) {
      try {
        const lookup = await bitvcard.get("getcardholder/", {
          params: { public_key, customerEmail: body.customerEmail },
        });
        const lookupData = lookup.data;
        const lookupId =
          lookupData?.data?.customerId ||
          lookupData?.data?.customer_id ||
          lookupData?.customerId ||
          lookupData?.customer_id;
        if (lookupId) {
          data.response = { ...(data.response || {}), customerId: lookupId };
        }
      } catch {
        // ignore lookup failures
      }
    }
    return ok(res, data, 200);
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

// 2) Get Customer
router.get("/getcardholder", async (req, res) => {
  try {
    const public_key = requirePublicKey();
    const params = {
      public_key,
      customerId: req.query.customerId,
      customerEmail: req.query.customerEmail,
    };
    const resp = await bitvcard.get("getcardholder/", { params });
    return ok(res, resp.data, 200);
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

// 3) Update Customer
// Allow partial updates for customer: only `customerId` is required
const UpdateCustomerSchema = z
  .object({ customerId: z.string().min(1) })
  .merge(
    z
      .object({
        firstName: z.string().min(1),
        lastName: z.string().min(1),
        idImage: UrlOrBase64,
        userPhoto: UrlOrBase64,
        phoneNumber: internationalPhone,
        country: z.string().min(1),
        city: z.string().min(1),
        state: z.string().min(1),
        zipCode: z.string().min(1),
        line1: z.string().min(1),
        houseNumber: z.string().min(1),
      })
      .partial()
  );

// Keep existing PUT for compatibility (sends full body including undefineds)
router.put("/updateCardCustomer", async (req, res) => {
  try {
    const body = UpdateCustomerSchema.parse(req.body || {});
    const public_key = requirePublicKey();
    const payload = { ...body, public_key };
    const resp = await bitvcard.put("updateCardCustomer/", payload, {
      headers: { "Content-Type": "application/json" },
      params: payload,
    });
    return ok(res, resp.data, 200);
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

// PATCH variant forwards only provided fields (omits undefined)
router.patch("/updateCardCustomer", async (req, res) => {
  try {
    const parsed = UpdateCustomerSchema.parse(req.body || {});
    const public_key = requirePublicKey();
    // Build payload with only keys that were actually provided in the request body
    const providedBody: Record<string, any> = {};
    for (const [k, v] of Object.entries(req.body || {})) {
      if (v !== undefined) providedBody[k] = v;
    }
    // Ensure customerId exists (required)
    if (!providedBody.customerId) {
      const err: any = new Error("customerId is required in body");
      err.status = 400;
      throw err;
    }
    const payload = { ...providedBody, public_key };
    const resp = await bitvcard.patch("updateCardCustomer/", payload, {
      headers: { "Content-Type": "application/json" },
      params: payload,
    });
    return ok(res, resp.data, 200);
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

// 4) Create NFC Card
const CreateNfcCardSchema = z.object({
  name: z.string().min(1),
  first_name: z.string().min(1),
  last_name: z.string().min(1),
  dob: mmddyyyy,
  id_type: z.enum(["national_id", "passport", "drivers_license"]),
  id_number: z.string().min(1),
  email: z.string().email(),
  line1: z.string().min(1),
  city: z.string().min(1),
  state: z.string().min(1),
  postal_code: z.string().min(1),
  country: z.string().min(3).max(3),
  amount_usd: amountString,
  phone: z.string().min(5),
  mode: z.string().optional(),
});

const LegacyCreateCardSchema = z.object({
  name_on_card: z.string().min(1),
  card_type: z.string().min(1),
  amount: amountString,
  customerEmail: z.string().email().optional(),
  customer_email: z.string().email().optional(),
  mode: z.string().optional(),
});

router.post("/create-card", async (req, res) => {
  try {
    const rawBody = req.body || {};
    const useLegacy =
      rawBody?.name_on_card ||
      rawBody?.card_type ||
      rawBody?.amount ||
      rawBody?.customerEmail ||
      rawBody?.customer_email;
    const public_key = requirePublicKey();

    if (useLegacy) {
      const parsed = applyDefaultMode(LegacyCreateCardSchema.parse(rawBody));
      const payload = {
        ...parsed,
        customerEmail: parsed.customerEmail || parsed.customer_email,
        public_key,
      } as Record<string, any>;
      delete payload.customer_email;
      const resp = await bitvcard.post("create-card/", payload, {
        headers: { "Content-Type": "application/json" },
        params: payload,
      });
      return ok(res, resp.data, 200);
    }

    const body = applyDefaultMode(CreateNfcCardSchema.parse(rawBody));
    const params = { ...body, public_key };
    const resp = await bitvcard.post("create-nfc-card/", undefined, { params });
    return ok(res, resp.data, 200);
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

// 5) Fund NFC Card
const FundCardSchema = z.object({
  card_id: CardIdSchema,
  amount: amountString,
  mode: z.string().optional(),
});

router.post("/fund-card", async (req, res) => {
  try {
    const body = applyDefaultMode(FundCardSchema.parse(req.body || {}));
    const public_key = requirePublicKey();
    const payload = { ...body, public_key, type: "fund" };
    if (shouldDebugStroWallet()) {
      console.log("[strowallet] fund-card request", {
        card_id: maskValue(String(body.card_id), 3, 3),
        amount: String(body.amount),
        mode: body.mode,
        public_key: maskValue(public_key, 4, 4),
      });
    }

    const result = await enqueueFundCard(async () => {
      try {
        const resp = await postWithRetry("fund-withdraw-nfccard/", payload, {
          headers: { "Content-Type": "application/json" },
          params: payload,
        });
        if (shouldDebugStroWallet()) {
          console.log("[strowallet] fund-card response", resp.data);
        }
        return ok(res, resp.data, 200);
      } catch (firstError: any) {
        // Fallback for provider deployments that only parse URL query params.
        const queryParams: Record<string, string> = {
          public_key,
          card_id: body.card_id,
          amount: String(body.amount),
          type: "fund",
        };
        if (body.mode) queryParams.mode = body.mode;
        const fallbackResp = await postWithRetry("fund-withdraw-nfccard/", payload, {
          headers: { "Content-Type": "application/json" },
          params: queryParams,
        });
        if (shouldDebugStroWallet()) {
          console.log("[strowallet] fund-card fallback response", fallbackResp.data);
        }
        console.warn("[strowallet] fund-card primary attempt failed, fallback succeeded", {
          firstStatus: firstError?.response?.status,
          firstMessage: firstError?.response?.data?.message || firstError?.response?.data?.error || firstError?.message,
        });
        return ok(res, fallbackResp.data, 200);
      }
    });

    return result;
  } catch (e) {
    const { status, message } = normalizeError(e);
    if (shouldDebugStroWallet()) {
      console.warn("[strowallet] fund-card error", { status, message });
    }
    return fail(res, message, status);
  }
});

// 6) Get NFC Card Details
const FetchCardDetailSchema = z.object({
  card_id: CardIdSchema,
  mode: z.string().optional(),
});

router.post("/fetch-card-detail", async (req, res) => {
  try {
    const body = applyDefaultMode(FetchCardDetailSchema.parse(req.body || {}));
    const public_key = requirePublicKey();
    const params = { ...body, public_key };
    const resp = await bitvcard.get("fetch-nfccard-detail/", { params });
    return ok(res, resp.data, 200);
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

// 7) NFC Card Transactions (recent)
const CardTransactionsSchema = z.object({
  card_id: CardIdSchema,
  mode: z.string().optional(),
});


router.post("/card-transactions", async (req, res) => {
  try {
    const body = applyDefaultMode(CardTransactionsSchema.parse(req.body || {}));
    const public_key = requirePublicKey();
    const params = { ...body, public_key };
    const resp = await bitvcard.get("nfc-card-transactions/", { params });
    return ok(res, resp.data, 200);
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

// 8) Freeze / Unfreeze NFC Card
const ActionStatusSchema = z.object({
  action: z.enum(["freeze", "unfreeze"]),
  card_id: CardIdSchema,
});

router.post("/action/status", async (req, res) => {
  try {
    const body = ActionStatusSchema.parse(req.body || {});
    const public_key = requirePublicKey();
    const status = body.action === "freeze" ? "frozen" : "active";
    const params = { card_id: body.card_id, status, public_key };
    const mode = normalizeMode(getDefaultMode());
    if (mode) (params as any).mode = mode;
    const resp = await bitvcard.post("nfc-cards/status/", undefined, { params });
    return ok(res, resp.data, 200);
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

// 9) Full Card History (paginated)
router.get("/apicard-transactions", async (req, res) => {
  try {
    const public_key = requirePublicKey();
    const page = Number(req.query.page ?? 1) || 1;
    const takeRaw = Number(req.query.take ?? 50);
    const take = takeRaw > 0 ? Math.min(takeRaw, 50) : 50; // enforce max 50 per docs
    const cardId = pickCardId(req);

    const params: Record<string, any> = {
      card_id: cardId,
      cardId: cardId,
      page,
      take,
      public_key,
    };
    const mode = normalizeMode(typeof req.query.mode === "string" ? req.query.mode : getDefaultMode());
    const developer_code = typeof req.query.developer_code === "string" ? req.query.developer_code : undefined;
    if (mode) params.mode = mode;
    if (developer_code) params.developer_code = developer_code;
    const resp = await api.get(`apicard-transactions/`, { params });
    return ok(res, resp.data, 200);
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

// 9b) Full Card History (paginated) via POST body (helps when query parsing is unreliable)
router.post("/apicard-transactions", async (req, res) => {
  try {
    const public_key = requirePublicKey();
    const cardId = pickCardId(req);
    const pageRaw = (req.body as any)?.page ?? req.query.page;
    const takeRaw = (req.body as any)?.take ?? req.query.take;
    const page = Number(pageRaw ?? 1) || 1;
    const takeParsed = Number(takeRaw ?? 50);
    const take = takeParsed > 0 ? Math.min(takeParsed, 50) : 50;
    const params: Record<string, any> = {
      card_id: cardId,
      cardId: cardId,
      page,
      take,
      public_key,
    };
    const mode = normalizeMode((req.body as any)?.mode ?? (req.query as any)?.mode ?? getDefaultMode());
    const developer_code = (req.body as any)?.developer_code ?? (req.query as any)?.developer_code;
    if (mode) params.mode = mode;
    if (developer_code) params.developer_code = developer_code;

    const resp = await api.get(`apicard-transactions/`, { params });
    return ok(res, resp.data, 200);
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

// 10) Wallet Balance by currency (e.g., USD, NGN)
router.get("/wallet-balance/:currency", async (req, res) => {
  try {
    const public_key = requirePublicKey();
    const currencyRaw = String(req.params.currency || "USD").trim().toUpperCase();
    const currency = /^[A-Z]{3,5}$/.test(currencyRaw) ? currencyRaw : "USD";

    const resp = await api.get(`wallet/balance/${currency}/`, {
      params: { public_key },
    });
    return ok(res, resp.data, 200);
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

export default router;
