"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const axios_1 = __importDefault(require("axios"));
const http_1 = __importDefault(require("http"));
const https_1 = __importDefault(require("https"));
const zod_1 = require("zod");
const apiResponse_1 = require("../utils/apiResponse");
const router = express_1.default.Router();
const BITVCARD_BASE = "https://strowallet.com/api/bitvcard/";
const API_BASE = "https://strowallet.com/api/"; // for apicard-transactions
const STROWALLET_PREFER_IPV4 = String(process.env.STROWALLET_PREFER_IPV4 || "true").toLowerCase() !== "false";
const httpAgent = STROWALLET_PREFER_IPV4 ? new http_1.default.Agent({ keepAlive: true, family: 4 }) : undefined;
const httpsAgent = STROWALLET_PREFER_IPV4 ? new https_1.default.Agent({ keepAlive: true, family: 4 }) : undefined;
const bitvcard = axios_1.default.create({
    baseURL: BITVCARD_BASE,
    timeout: 15000,
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
function normalizeMode(mode) {
    if (!mode)
        return undefined;
    const m = String(mode).toLowerCase();
    if (m === "live")
        return undefined;
    return m;
}
function applyDefaultMode(body) {
    const defaultMode = normalizeMode(getDefaultMode());
    if (!body?.mode && defaultMode)
        return { ...body, mode: defaultMode };
    return body;
}
function pickCardId(req) {
    const v = req.body?.card_id ??
        req.body?.cardId ??
        req.query.card_id ??
        req.query.cardId ??
        req.headers["x-card-id"];
    if (v === undefined || v === null || v === "") {
        const err = new Error("card_id is required");
        err.status = 400;
        throw err;
    }
    return String(v);
}
const api = axios_1.default.create({
    baseURL: API_BASE,
    timeout: 15000,
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
        err.status = 500;
        throw err;
    }
    return key;
}
function normalizeError(e) {
    // Axios error normalization
    if (typeof axios_1.default.isAxiosError === "function" && axios_1.default.isAxiosError(e)) {
        const ae = e;
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
function maskValue(value, showStart = 4, showEnd = 2) {
    if (!value)
        return "";
    const str = String(value);
    if (str.length <= showStart + showEnd)
        return str;
    return `${str.slice(0, showStart)}***${str.slice(-showEnd)}`;
}
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function parseRetryAfterMs(headers) {
    if (!headers)
        return null;
    const raw = headers["retry-after"] || headers["Retry-After"];
    if (!raw)
        return null;
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
async function postWithRetry(url, payload, config) {
    const maxRetries = 4;
    for (let attempt = 0; attempt < maxRetries; attempt += 1) {
        try {
            return await bitvcard.post(url, payload, config);
        }
        catch (err) {
            const status = err?.response?.status;
            if (status !== 429 || attempt === maxRetries - 1)
                throw err;
            const retryAfterMs = parseRetryAfterMs(err?.response?.headers);
            const backoffMs = retryAfterMs ?? 2000 * Math.pow(2, attempt);
            await delay(backoffMs);
        }
    }
    throw new Error("fund-card retry attempts exhausted");
}
let fundCardQueue = Promise.resolve();
function enqueueFundCard(task) {
    const run = fundCardQueue.then(task, task);
    fundCardQueue = run.then(() => undefined, () => undefined);
    return run;
}
// 1) Create Customer
const internationalPhone = zod_1.z.string().regex(/^[1-9]\d{10,14}$/); // e.g., 2348012345678 (no '+')
const mmddyyyy = zod_1.z.string().regex(/^\d{2}\/\d{2}\/\d{4}$/);
const amountString = zod_1.z
    .string()
    .regex(/^\d+(\.\d+)?$/)
    .refine((v) => Number(v) > 0, "amount must be greater than zero");
const CardIdSchema = zod_1.z.union([zod_1.z.string(), zod_1.z.number()]).transform((v) => String(v));
// Accept either a remote URL or base64/data-uri for images (idImage, userPhoto)
const UrlOrBase64 = zod_1.z
    .string()
    .refine((v) => {
    if (!v || typeof v !== "string")
        return false;
    // Data URI (e.g. data:image/png;base64,...) or raw base64 blob
    const dataUri = /^data:[^;\s]+;base64,[A-Za-z0-9+/=\s]+$/i;
    if (dataUri.test(v))
        return true;
    // Try URL
    try {
        // new URL will throw if invalid
        // accept relative/absolute http(s) urls only
        const u = new URL(v);
        return u.protocol === "http:" || u.protocol === "https:" || u.protocol === "data:";
    }
    catch (err) {
        // not a URL -> test data URI or long base64 blob heuristics
    }
    // Raw base64: require a reasonably long string to reduce false positives
    const rawBase64 = /^[A-Za-z0-9+/=\s]{50,}$/;
    return rawBase64.test(v);
}, "must be a valid URL or base64 data");
const CreateCustomerSchema = zod_1.z.object({
    houseNumber: zod_1.z.string().min(1),
    firstName: zod_1.z.string().min(1),
    lastName: zod_1.z.string().min(1),
    idNumber: zod_1.z.string().min(1),
    customerEmail: zod_1.z.string().email(),
    phoneNumber: internationalPhone,
    dateOfBirth: mmddyyyy, // MM/DD/YYYY
    idImage: UrlOrBase64,
    userPhoto: UrlOrBase64,
    line1: zod_1.z.string().min(1),
    state: zod_1.z.string().min(1),
    zipCode: zod_1.z.string().min(1),
    city: zod_1.z.string().min(1),
    country: zod_1.z.string().min(1),
    idType: zod_1.z.enum(["NIN", "PASSPORT", "DRIVING_LICENSE"]),
});
router.post("/create-user", async (req, res) => {
    try {
        const body = CreateCustomerSchema.parse(req.body || {});
        const public_key = requirePublicKey();
        const payload = { ...body, public_key };
        let data;
        try {
            const resp = await bitvcard.post("create-user/", payload, {
                headers: { "Content-Type": "application/json" },
            });
            data = resp.data;
        }
        catch (firstError) {
            // Fallback for provider deployments that only parse URL query params.
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
            };
            const fallbackResp = await bitvcard.post("create-user/", payload, {
                headers: { "Content-Type": "application/json" },
                params: queryParams,
            });
            data = fallbackResp.data;
            console.warn("[strowallet] create-user primary attempt failed, fallback succeeded", {
                firstStatus: firstError?.response?.status,
                firstMessage: firstError?.response?.data?.message || firstError?.response?.data?.error || firstError?.message,
            });
        }
        const customerId = data?.response?.customerId ||
            data?.response?.customer_id ||
            data?.customerId ||
            data?.customer_id;
        if (!customerId && body.customerEmail) {
            try {
                const lookup = await bitvcard.get("getcardholder/", {
                    params: { public_key, customerEmail: body.customerEmail },
                });
                const lookupData = lookup.data;
                const lookupId = lookupData?.data?.customerId ||
                    lookupData?.data?.customer_id ||
                    lookupData?.customerId ||
                    lookupData?.customer_id;
                if (lookupId) {
                    data.response = { ...(data.response || {}), customerId: lookupId };
                }
            }
            catch {
                // ignore lookup failures
            }
        }
        return (0, apiResponse_1.ok)(res, data, 200);
    }
    catch (e) {
        const { status, message } = normalizeError(e);
        return (0, apiResponse_1.fail)(res, message, status);
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
        return (0, apiResponse_1.ok)(res, resp.data, 200);
    }
    catch (e) {
        const { status, message } = normalizeError(e);
        return (0, apiResponse_1.fail)(res, message, status);
    }
});
// 3) Update Customer
// Allow partial updates for customer: only `customerId` is required
const UpdateCustomerSchema = zod_1.z
    .object({ customerId: zod_1.z.string().min(1) })
    .merge(zod_1.z
    .object({
    firstName: zod_1.z.string().min(1),
    lastName: zod_1.z.string().min(1),
    idImage: UrlOrBase64,
    userPhoto: UrlOrBase64,
    phoneNumber: internationalPhone,
    country: zod_1.z.string().min(1),
    city: zod_1.z.string().min(1),
    state: zod_1.z.string().min(1),
    zipCode: zod_1.z.string().min(1),
    line1: zod_1.z.string().min(1),
    houseNumber: zod_1.z.string().min(1),
})
    .partial());
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
        return (0, apiResponse_1.ok)(res, resp.data, 200);
    }
    catch (e) {
        const { status, message } = normalizeError(e);
        return (0, apiResponse_1.fail)(res, message, status);
    }
});
// PATCH variant forwards only provided fields (omits undefined)
router.patch("/updateCardCustomer", async (req, res) => {
    try {
        const parsed = UpdateCustomerSchema.parse(req.body || {});
        const public_key = requirePublicKey();
        // Build payload with only keys that were actually provided in the request body
        const providedBody = {};
        for (const [k, v] of Object.entries(req.body || {})) {
            if (v !== undefined)
                providedBody[k] = v;
        }
        // Ensure customerId exists (required)
        if (!providedBody.customerId) {
            const err = new Error("customerId is required in body");
            err.status = 400;
            throw err;
        }
        const payload = { ...providedBody, public_key };
        const resp = await bitvcard.patch("updateCardCustomer/", payload, {
            headers: { "Content-Type": "application/json" },
            params: payload,
        });
        return (0, apiResponse_1.ok)(res, resp.data, 200);
    }
    catch (e) {
        const { status, message } = normalizeError(e);
        return (0, apiResponse_1.fail)(res, message, status);
    }
});
// 4) Create NFC Card
const CreateNfcCardSchema = zod_1.z.object({
    name: zod_1.z.string().min(1),
    first_name: zod_1.z.string().min(1),
    last_name: zod_1.z.string().min(1),
    dob: mmddyyyy,
    id_type: zod_1.z.enum(["national_id", "passport", "drivers_license"]),
    id_number: zod_1.z.string().min(1),
    email: zod_1.z.string().email(),
    line1: zod_1.z.string().min(1),
    city: zod_1.z.string().min(1),
    state: zod_1.z.string().min(1),
    postal_code: zod_1.z.string().min(1),
    country: zod_1.z.string().min(3).max(3),
    amount_usd: amountString,
    phone: zod_1.z.string().min(5),
    mode: zod_1.z.string().optional(),
});
router.post("/create-card", async (req, res) => {
    try {
        const body = applyDefaultMode(CreateNfcCardSchema.parse(req.body || {}));
        const public_key = requirePublicKey();
        const params = { ...body, public_key };
        const resp = await bitvcard.post("create-nfc-card/", undefined, { params });
        return (0, apiResponse_1.ok)(res, resp.data, 200);
    }
    catch (e) {
        const { status, message } = normalizeError(e);
        return (0, apiResponse_1.fail)(res, message, status);
    }
});
// 5) Fund NFC Card
const FundCardSchema = zod_1.z.object({
    card_id: CardIdSchema,
    amount: amountString,
    mode: zod_1.z.string().optional(),
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
                return (0, apiResponse_1.ok)(res, resp.data, 200);
            }
            catch (firstError) {
                // Fallback for provider deployments that only parse URL query params.
                const queryParams = {
                    public_key,
                    card_id: body.card_id,
                    amount: String(body.amount),
                    type: "fund",
                };
                if (body.mode)
                    queryParams.mode = body.mode;
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
                return (0, apiResponse_1.ok)(res, fallbackResp.data, 200);
            }
        });
        return result;
    }
    catch (e) {
        const { status, message } = normalizeError(e);
        if (shouldDebugStroWallet()) {
            console.warn("[strowallet] fund-card error", { status, message });
        }
        return (0, apiResponse_1.fail)(res, message, status);
    }
});
// 6) Get NFC Card Details
const FetchCardDetailSchema = zod_1.z.object({
    card_id: CardIdSchema,
    mode: zod_1.z.string().optional(),
});
router.post("/fetch-card-detail", async (req, res) => {
    try {
        const body = applyDefaultMode(FetchCardDetailSchema.parse(req.body || {}));
        const public_key = requirePublicKey();
        const params = { ...body, public_key };
        const resp = await bitvcard.get("fetch-nfccard-detail/", { params });
        return (0, apiResponse_1.ok)(res, resp.data, 200);
    }
    catch (e) {
        const { status, message } = normalizeError(e);
        return (0, apiResponse_1.fail)(res, message, status);
    }
});
// 7) NFC Card Transactions (recent)
const CardTransactionsSchema = zod_1.z.object({
    card_id: CardIdSchema,
    mode: zod_1.z.string().optional(),
});
router.post("/card-transactions", async (req, res) => {
    try {
        const body = applyDefaultMode(CardTransactionsSchema.parse(req.body || {}));
        const public_key = requirePublicKey();
        const params = { ...body, public_key };
        const resp = await bitvcard.get("nfc-card-transactions/", { params });
        return (0, apiResponse_1.ok)(res, resp.data, 200);
    }
    catch (e) {
        const { status, message } = normalizeError(e);
        return (0, apiResponse_1.fail)(res, message, status);
    }
});
// 8) Freeze / Unfreeze NFC Card
const ActionStatusSchema = zod_1.z.object({
    action: zod_1.z.enum(["freeze", "unfreeze"]),
    card_id: CardIdSchema,
});
router.post("/action/status", async (req, res) => {
    try {
        const body = ActionStatusSchema.parse(req.body || {});
        const public_key = requirePublicKey();
        const status = body.action === "freeze" ? "frozen" : "active";
        const params = { card_id: body.card_id, status, public_key };
        const mode = normalizeMode(getDefaultMode());
        if (mode)
            params.mode = mode;
        const resp = await bitvcard.post("nfc-cards/status/", undefined, { params });
        return (0, apiResponse_1.ok)(res, resp.data, 200);
    }
    catch (e) {
        const { status, message } = normalizeError(e);
        return (0, apiResponse_1.fail)(res, message, status);
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
        const params = {
            card_id: cardId,
            cardId: cardId,
            page,
            take,
            public_key,
        };
        const mode = normalizeMode(typeof req.query.mode === "string" ? req.query.mode : getDefaultMode());
        const developer_code = typeof req.query.developer_code === "string" ? req.query.developer_code : undefined;
        if (mode)
            params.mode = mode;
        if (developer_code)
            params.developer_code = developer_code;
        const resp = await api.get(`apicard-transactions/`, { params });
        return (0, apiResponse_1.ok)(res, resp.data, 200);
    }
    catch (e) {
        const { status, message } = normalizeError(e);
        return (0, apiResponse_1.fail)(res, message, status);
    }
});
// 9b) Full Card History (paginated) via POST body (helps when query parsing is unreliable)
router.post("/apicard-transactions", async (req, res) => {
    try {
        const public_key = requirePublicKey();
        const cardId = pickCardId(req);
        const pageRaw = req.body?.page ?? req.query.page;
        const takeRaw = req.body?.take ?? req.query.take;
        const page = Number(pageRaw ?? 1) || 1;
        const takeParsed = Number(takeRaw ?? 50);
        const take = takeParsed > 0 ? Math.min(takeParsed, 50) : 50;
        const params = {
            card_id: cardId,
            cardId: cardId,
            page,
            take,
            public_key,
        };
        const mode = normalizeMode(req.body?.mode ?? req.query?.mode ?? getDefaultMode());
        const developer_code = req.body?.developer_code ?? req.query?.developer_code;
        if (mode)
            params.mode = mode;
        if (developer_code)
            params.developer_code = developer_code;
        const resp = await api.get(`apicard-transactions/`, { params });
        return (0, apiResponse_1.ok)(res, resp.data, 200);
    }
    catch (e) {
        const { status, message } = normalizeError(e);
        return (0, apiResponse_1.fail)(res, message, status);
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
        return (0, apiResponse_1.ok)(res, resp.data, 200);
    }
    catch (e) {
        const { status, message } = normalizeError(e);
        return (0, apiResponse_1.fail)(res, message, status);
    }
});
exports.default = router;
