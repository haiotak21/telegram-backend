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
    if (axios_1.default.isAxiosError(e)) {
        const ae = e;
        const status = ae.response?.status ?? 400;
        const msg = ae.response?.data?.error || ae.message || "Request failed";
        return { status, body: { ok: false, error: String(msg) } };
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
const CreateCustomerSchema = zod_1.z.object({
    houseNumber: zod_1.z.string().min(1),
    firstName: zod_1.z.string().min(1),
    lastName: zod_1.z.string().min(1),
    idNumber: zod_1.z.string().min(1),
    customerEmail: zod_1.z.string().email(),
    phoneNumber: internationalPhone,
    dateOfBirth: mmddyyyy, // MM/DD/YYYY
    idImage: zod_1.z.string().url(),
    userPhoto: zod_1.z.string().url(),
    line1: zod_1.z.string().min(1),
    state: zod_1.z.string().min(1),
    zipCode: zod_1.z.string().min(1),
    city: zod_1.z.string().min(1),
    country: zod_1.z.string().min(1),
    idType: zod_1.z.enum(["BVN", "NIN", "PASSPORT"]),
});
router.post("/create-user", async (req, res) => {
    try {
        const body = CreateCustomerSchema.parse(req.body || {});
        const public_key = requirePublicKey();
        const payload = { ...body, public_key };
        const resp = await bitvcard.post("create-user/", payload, {
            headers: { "Content-Type": "application/json" },
        });
        return res.status(200).json({ ok: true, data: resp.data });
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
const UpdateCustomerSchema = zod_1.z.object({
    customerId: zod_1.z.string().min(1),
    firstName: zod_1.z.string().min(1),
    lastName: zod_1.z.string().min(1),
    idImage: zod_1.z.string().url(),
    userPhoto: zod_1.z.string().url(),
    phoneNumber: internationalPhone,
    country: zod_1.z.string().min(1),
    city: zod_1.z.string().min(1),
    state: zod_1.z.string().min(1),
    zipCode: zod_1.z.string().min(1),
    line1: zod_1.z.string().min(1),
    houseNumber: zod_1.z.string().min(1),
});
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
// 4) Create Card
const CardTypeSchema = zod_1.z.enum(["visa", "mastercard"]);
const CreateCardSchema = zod_1.z.object({
    name_on_card: zod_1.z.string().min(1),
    card_type: CardTypeSchema,
    amount: amountString,
    customerEmail: zod_1.z.string().email(),
    mode: zod_1.z.enum(["sandbox"]).optional(),
    developer_code: zod_1.z.string().optional(),
});
router.post("/create-card", async (req, res) => {
    try {
        const body = CreateCardSchema.parse(req.body || {});
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
    mode: zod_1.z.enum(["sandbox"]).optional(),
});
router.post("/fund-card", async (req, res) => {
    try {
        const body = FundCardSchema.parse(req.body || {});
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
    mode: zod_1.z.enum(["sandbox"]).optional(),
});
router.post("/fetch-card-detail", async (req, res) => {
    try {
        const body = FetchCardDetailSchema.parse(req.body || {});
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
    mode: zod_1.z.enum(["sandbox"]).optional(),
});
router.post("/card-transactions", async (req, res) => {
    try {
        const body = CardTransactionsSchema.parse(req.body || {});
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
        const mode = typeof req.query.mode === "string" ? req.query.mode : undefined;
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
        const mode = req.body?.mode ?? req.query?.mode;
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
