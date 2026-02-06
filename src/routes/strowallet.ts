import express from "express";
import axios, { AxiosError } from "axios";
import { z } from "zod";

const router = express.Router();

const BITVCARD_BASE = "https://strowallet.com/api/bitvcard/";
const API_BASE = "https://strowallet.com/api/"; // for apicard-transactions

const bitvcard = axios.create({
  baseURL: BITVCARD_BASE,
  timeout: 15000,
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
  timeout: 15000,
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
    return { status, body: { ok: false, error: String(msg), data: payload } };
  }
  const status = e?.status ?? 400;
  const msg = e?.message ?? "Request error";
  return { status, body: { ok: false, error: String(msg) } };
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
    const resp = await bitvcard.post("create-user/", payload, {
      headers: { "Content-Type": "application/json" },
    });
    const data = resp.data;
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
    return res.status(200).json({ ok: true, data });
  } catch (e) {
    const { status, body } = normalizeError(e);
    return res.status(status).json(body);
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
    return res.status(200).json({ ok: true, data: resp.data });
  } catch (e) {
    const { status, body } = normalizeError(e);
    return res.status(status).json(body);
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
    });
    return res.status(200).json({ ok: true, data: resp.data });
  } catch (e) {
    const { status, body } = normalizeError(e);
    return res.status(status).json(body);
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
    });
    return res.status(200).json({ ok: true, data: resp.data });
  } catch (e) {
    const { status, body } = normalizeError(e);
    return res.status(status).json(body);
  }
});

// 4) Create Card
// Allow any non-empty string for card_type (not limited to visa/mastercard)
const CardTypeSchema = z.string().min(1);

const CreateCardSchema = z.object({
  name_on_card: z.string().min(1),
  card_type: CardTypeSchema,
  amount: amountString,
  customerEmail: z.string().email(),
  mode: z.string().optional(),
  developer_code: z.string().optional(),
});

router.post("/create-card", async (req, res) => {
  try {
    const body = applyDefaultMode(CreateCardSchema.parse(req.body || {}));
    const public_key = requirePublicKey();
    const payload = { ...body, public_key };
    const resp = await bitvcard.post("create-card/", payload);
    return res.status(200).json({ ok: true, data: resp.data });
  } catch (e) {
    const { status, body } = normalizeError(e);
    return res.status(status).json(body);
  }
});

// 5) Fund Card
const FundCardSchema = z.object({
  card_id: CardIdSchema,
  amount: amountString,
  mode: z.string().optional(),
});

router.post("/fund-card", async (req, res) => {
  try {
    const body = applyDefaultMode(FundCardSchema.parse(req.body || {}));
    const public_key = requirePublicKey();
    const payload = { ...body, public_key };
    const resp = await bitvcard.post("fund-card/", payload);
    return res.status(200).json({ ok: true, data: resp.data });
  } catch (e) {
    const { status, body } = normalizeError(e);
    return res.status(status).json(body);
  }
});

// 6) Get Card Details
const FetchCardDetailSchema = z.object({
  card_id: CardIdSchema,
  mode: z.string().optional(),
});

router.post("/fetch-card-detail", async (req, res) => {
  try {
    const body = applyDefaultMode(FetchCardDetailSchema.parse(req.body || {}));
    const public_key = requirePublicKey();
    const payload = { ...body, public_key };
    const resp = await bitvcard.post("fetch-card-detail/", payload);
    return res.status(200).json({ ok: true, data: resp.data });
  } catch (e) {
    const { status, body } = normalizeError(e);
    return res.status(status).json(body);
  }
});

// 7) Card Transactions (recent)
const CardTransactionsSchema = z.object({
  card_id: CardIdSchema,
  mode: z.string().optional(),
});


router.post("/card-transactions", async (req, res) => {
  try {
    const body = applyDefaultMode(CardTransactionsSchema.parse(req.body || {}));
    const public_key = requirePublicKey();
    const payload = { ...body, public_key };
    const resp = await bitvcard.post("card-transactions/", payload);
    return res.status(200).json({ ok: true, data: resp.data });
  } catch (e) {
    const { status, body } = normalizeError(e);
    return res.status(status).json(body);
  }
});

// 8) Freeze / Unfreeze Card
const ActionStatusSchema = z.object({
  action: z.enum(["freeze", "unfreeze"]),
  card_id: CardIdSchema,
});

router.post("/action/status", async (req, res) => {
  try {
    const body = ActionStatusSchema.parse(req.body || {});
    const public_key = requirePublicKey();
    const payload = { ...body, public_key };
    const resp = await bitvcard.post("action/status/", payload);
    return res.status(200).json({ ok: true, data: resp.data });
  } catch (e) {
    const { status, body } = normalizeError(e);
    return res.status(status).json(body);
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
    return res.status(200).json({ ok: true, data: resp.data });
  } catch (e) {
    const { status, body } = normalizeError(e);
    return res.status(status).json(body);
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
    return res.status(200).json({ ok: true, data: resp.data });
  } catch (e) {
    const { status, body } = normalizeError(e);
    return res.status(status).json(body);
  }
});

export default router;
