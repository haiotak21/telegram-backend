"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const axios_1 = __importDefault(require("axios"));
const zod_1 = require("zod");
const router = express_1.default.Router();
const BITVCARD_BASE = "https://strowallet.com/api/bitvcard/";
const API_BASE = "https://strowallet.com/api/"; // for apicard-transactions
const bitvcard = axios_1.default.create({
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
        return { status, body: { ok: false, error: String(msg), data: payload } };
    }
    const status = e?.status ?? 400;
    const msg = e?.message ?? "Request error";
    return { status, body: { ok: false, error: String(msg) } };
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
        const resp = await bitvcard.post("create-user/", payload, {
            headers: { "Content-Type": "application/json" },
        });
        const data = resp.data;
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
        return res.status(200).json({ ok: true, data });
    }
    catch (e) {
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
    }
    catch (e) {
        const { status, body } = normalizeError(e);
        return res.status(status).json(body);
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
        });
        return res.status(200).json({ ok: true, data: resp.data });
    }
    catch (e) {
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
        });
        return res.status(200).json({ ok: true, data: resp.data });
    }
    catch (e) {
        const { status, body } = normalizeError(e);
        return res.status(status).json(body);
    }
});
// 4) Create Card
// Allow any non-empty string for card_type (not limited to visa/mastercard)
const CardTypeSchema = zod_1.z.string().min(1);
const CreateCardSchema = zod_1.z.object({
    name_on_card: zod_1.z.string().min(1),
    card_type: CardTypeSchema,
    amount: amountString,
    customerEmail: zod_1.z.string().email(),
    mode: zod_1.z.string().optional(),
    developer_code: zod_1.z.string().optional(),
});
router.post("/create-card", async (req, res) => {
    try {
        const body = applyDefaultMode(CreateCardSchema.parse(req.body || {}));
        const public_key = requirePublicKey();
        const payload = { ...body, public_key };
        const resp = await bitvcard.post("create-card/", payload);
        return res.status(200).json({ ok: true, data: resp.data });
    }
    catch (e) {
        const { status, body } = normalizeError(e);
        return res.status(status).json(body);
    }
});
// 5) Fund Card
const FundCardSchema = zod_1.z.object({
    card_id: CardIdSchema,
    amount: amountString,
    mode: zod_1.z.string().optional(),
});
router.post("/fund-card", async (req, res) => {
    try {
        const body = applyDefaultMode(FundCardSchema.parse(req.body || {}));
        const public_key = requirePublicKey();
        const payload = { ...body, public_key };
        const resp = await bitvcard.post("fund-card/", payload);
        return res.status(200).json({ ok: true, data: resp.data });
    }
    catch (e) {
        const { status, body } = normalizeError(e);
        return res.status(status).json(body);
    }
});
// 6) Get Card Details
const FetchCardDetailSchema = zod_1.z.object({
    card_id: CardIdSchema,
    mode: zod_1.z.string().optional(),
});
router.post("/fetch-card-detail", async (req, res) => {
    try {
        const body = applyDefaultMode(FetchCardDetailSchema.parse(req.body || {}));
        const public_key = requirePublicKey();
        const payload = { ...body, public_key };
        const resp = await bitvcard.post("fetch-card-detail/", payload);
        return res.status(200).json({ ok: true, data: resp.data });
    }
    catch (e) {
        const { status, body } = normalizeError(e);
        return res.status(status).json(body);
    }
});
// 7) Card Transactions (recent)
const CardTransactionsSchema = zod_1.z.object({
    card_id: CardIdSchema,
    mode: zod_1.z.string().optional(),
});
router.post("/card-transactions", async (req, res) => {
    try {
        const body = applyDefaultMode(CardTransactionsSchema.parse(req.body || {}));
        const public_key = requirePublicKey();
        const payload = { ...body, public_key };
        const resp = await bitvcard.post("card-transactions/", payload);
        return res.status(200).json({ ok: true, data: resp.data });
    }
    catch (e) {
        const { status, body } = normalizeError(e);
        return res.status(status).json(body);
    }
});
// 8) Freeze / Unfreeze Card
const ActionStatusSchema = zod_1.z.object({
    action: zod_1.z.enum(["freeze", "unfreeze"]),
    card_id: CardIdSchema,
});
router.post("/action/status", async (req, res) => {
    try {
        const body = ActionStatusSchema.parse(req.body || {});
        const public_key = requirePublicKey();
        const payload = { ...body, public_key };
        const resp = await bitvcard.post("action/status/", payload);
        return res.status(200).json({ ok: true, data: resp.data });
    }
    catch (e) {
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
        return res.status(200).json({ ok: true, data: resp.data });
    }
    catch (e) {
        const { status, body } = normalizeError(e);
        return res.status(status).json(body);
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
        return res.status(200).json({ ok: true, data: resp.data });
    }
    catch (e) {
        const { status, body } = normalizeError(e);
        return res.status(status).json(body);
    }
});
exports.default = router;
