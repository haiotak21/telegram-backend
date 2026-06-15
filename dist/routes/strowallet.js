"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const axios_1 = __importDefault(require("axios"));
const crypto_1 = __importDefault(require("crypto"));
const http_1 = __importDefault(require("http"));
const https_1 = __importDefault(require("https"));
const mongoose_1 = __importDefault(require("mongoose"));
const zod_1 = require("zod");
const apiResponse_1 = require("../utils/apiResponse");
const User_1 = __importDefault(require("../models/User"));
const prisma_1 = __importDefault(require("../utils/prisma"));
const persistence_1 = require("../utils/persistence");
const router = express_1.default.Router();
const prismaAny = prisma_1.default;
const VIRTUAL_ACCOUNT_CREATE_TTL_MS = Number(process.env.VIRTUAL_ACCOUNT_CREATE_TTL_MS || 60000);
const USDT_ADDRESS_CREATE_TTL_MS = Number(process.env.USDT_ADDRESS_CREATE_TTL_MS || 60000);
const virtualAccountCreateLocks = new Map();
const usdtAddressCreateLocks = new Map();
function getVirtualBankAccountModel() {
    return require("../models/VirtualBankAccount").default;
}
function getUsdtAddressModel() {
    return require("../models/UsdtAddress").default;
}
function hasPrismaModel(modelName) {
    return Boolean(prismaAny?.[modelName]);
}
async function queryLatestUsdtAddressRow(userId) {
    if (!(0, persistence_1.isPrismaPersistenceEnabled)())
        return null;
    const rows = await prismaAny.$queryRawUnsafe('SELECT * FROM "UsdtAddress" WHERE "userId" = $1 ORDER BY "createdAt" DESC LIMIT 1', userId);
    return Array.isArray(rows) && rows.length ? rows[0] : null;
}
async function upsertUsdtAddressRow(params) {
    if (!(0, persistence_1.isPrismaPersistenceEnabled)())
        return null;
    const responseDataJson = JSON.stringify(params.responseData ?? {});
    const rows = await prismaAny.$queryRawUnsafe(`INSERT INTO "UsdtAddress" ("id", "userId", "address", "label", "network", "status", "responseData", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, 'TRC20', 'active', $5::jsonb, NOW(), NOW())
     ON CONFLICT ("address") DO UPDATE SET
       "userId" = EXCLUDED."userId",
       "label" = EXCLUDED."label",
       "network" = EXCLUDED."network",
       "status" = EXCLUDED."status",
       "responseData" = EXCLUDED."responseData",
       "updatedAt" = NOW()
     RETURNING *`, crypto_1.default.randomUUID(), params.userId, params.address, params.label || null, responseDataJson);
    return Array.isArray(rows) && rows.length ? rows[0] : null;
}
async function listUserUsdtDeposits(userId, limit = 10) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 10, 50));
    if ((0, persistence_1.isPrismaPersistenceEnabled)()) {
        return prismaAny.transaction.findMany({
            where: {
                userId,
                transactionType: { in: ["deposit", "manual_deposit"] },
                paymentMethod: "strowallet",
                currency: "USDT",
            },
            orderBy: { createdAt: "desc" },
            take: safeLimit,
        });
    }
    if (!isMongoReady())
        return [];
    const Transaction = require("../models/Transaction").default;
    return Transaction.find({
        userId,
        transactionType: { $in: ["deposit", "manual_deposit"] },
        paymentMethod: "strowallet",
        currency: "USDT",
    })
        .sort({ createdAt: -1 })
        .limit(safeLimit)
        .lean();
}
function isMongoReady() {
    return mongoose_1.default.connection.readyState === 1;
}
function shouldSkipCreate(lock, userId, ttlMs) {
    const existing = lock.get(userId);
    if (!existing)
        return false;
    if (Date.now() - existing.startedAt <= ttlMs)
        return true;
    lock.delete(userId);
    return false;
}
const BITVCARD_BASE = "https://strowallet.com/api/bitvcard/";
const API_BASE = "https://strowallet.com/api/"; // for apicard-transactions
const STROWALLET_PREFER_IPV4 = String(process.env.STROWALLET_PREFER_IPV4 || "true").toLowerCase() !== "false";
const STROWALLET_HTTP_TIMEOUT_MS = Number(process.env.STROWALLET_HTTP_TIMEOUT_MS || 30000);
const httpAgent = STROWALLET_PREFER_IPV4 ? new http_1.default.Agent({ keepAlive: true, family: 4 }) : undefined;
const httpsAgent = STROWALLET_PREFER_IPV4 ? new https_1.default.Agent({ keepAlive: true, family: 4 }) : undefined;
const bitvcard = axios_1.default.create({
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
    timeout: STROWALLET_HTTP_TIMEOUT_MS,
    httpAgent,
    httpsAgent,
    headers: {
        Authorization: process.env.STROWALLET_API_KEY ? `Bearer ${process.env.STROWALLET_API_KEY}` : undefined,
    },
});
const VirtualBankRequestSchema = zod_1.z.object({
    userId: zod_1.z.union([zod_1.z.string(), zod_1.z.number()]).transform((v) => String(v)),
    bank: zod_1.z.string().optional(),
    email: zod_1.z.string().email().optional(),
    accountName: zod_1.z.string().min(1).optional(),
    phone: zod_1.z.string().min(7).optional(),
    webhookUrl: zod_1.z.string().url().optional(),
    mode: zod_1.z.string().optional(),
    developerCode: zod_1.z.string().optional(),
    forceCreate: zod_1.z.boolean().optional(),
});
const UsdtAddressSchema = zod_1.z.object({
    userId: zod_1.z.union([zod_1.z.string(), zod_1.z.number()]).transform((v) => String(v)),
    label: zod_1.z.string().optional(),
    email: zod_1.z.string().email().optional(),
    webhookUrl: zod_1.z.string().url().optional(),
    mode: zod_1.z.string().optional(),
    forceCreate: zod_1.z.boolean().optional(),
});
const UsdtHistoryQuerySchema = zod_1.z.object({
    address: zod_1.z.string().min(5),
});
const UsdtSendSchema = zod_1.z.object({
    address: zod_1.z.string().min(5),
    amount: zod_1.z.union([zod_1.z.string(), zod_1.z.number()]).transform((v) => String(v)),
    vipKey: zod_1.z.string().optional(),
    mode: zod_1.z.string().optional(),
});
const BankTransferSchema = zod_1.z.object({
    amount: zod_1.z.string().min(1),
    bank_code: zod_1.z.string().min(1),
    account_number: zod_1.z.string().min(1),
    narration: zod_1.z.string().min(1),
    name_enquiry_reference: zod_1.z.string().min(1),
    SenderName: zod_1.z.string().optional(),
    mode: zod_1.z.string().optional(),
});
const AirtimeSchema = zod_1.z.object({
    amount: zod_1.z.string().min(1),
    phone: zod_1.z.string().min(7),
    service_name: zod_1.z.string().min(1),
});
const DataPlanQuerySchema = zod_1.z.object({
    service_name: zod_1.z.string().min(1),
});
const BuyDataSchema = zod_1.z.object({
    amount: zod_1.z.string().min(1),
    phone: zod_1.z.string().min(7),
    service_name: zod_1.z.string().min(1),
    service_id: zod_1.z.string().min(1),
    variation_code: zod_1.z.string().min(1),
});
const ElectricitySchema = zod_1.z.object({
    amount: zod_1.z.string().min(1),
    phone: zod_1.z.string().min(7),
    service_name: zod_1.z.string().min(1),
    meter_number: zod_1.z.string().min(1),
    meter_type: zod_1.z.enum(["prepaid", "postpaid"]),
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
function getWebhookUrl(defaultPath) {
    const direct = (process.env.STROWALLET_WEBHOOK_URL || "").trim();
    if (direct)
        return direct;
    const base = (process.env.BOT_BACKEND_BASE || "").trim();
    if (base)
        return base.replace(/\/$/, "") + defaultPath;
    const port = process.env.PORT || 3000;
    return `http://127.0.0.1:${port}${defaultPath}`;
}
function normalizeVirtualBankProvider(raw) {
    const value = String(raw || "").trim().toLowerCase();
    if (!value || value === "default" || value === "nombank")
        return "new-customer";
    if (value === "palmpay")
        return "palmpay";
    if (value === "paga")
        return "paga";
    if (value === "safehaven")
        return "safehaven";
    if (value === "amucha")
        return "amucha";
    if (value === "fidelitybank" || value === "fidelity")
        return "fidelitybank";
    return "new-customer";
}
async function findUserById(userId) {
    if ((0, persistence_1.isPrismaPersistenceEnabled)()) {
        return prisma_1.default.user.findUnique({ where: { userId } });
    }
    return User_1.default.findOne({ userId }).lean();
}
async function findExistingVirtualAccount(userId) {
    if ((0, persistence_1.isPrismaPersistenceEnabled)() && hasPrismaModel("virtualBankAccount")) {
        return prismaAny.virtualBankAccount.findFirst({
            where: { userId },
            orderBy: { createdAt: "desc" },
        });
    }
    if (!isMongoReady())
        return null;
    const VirtualBankAccount = getVirtualBankAccountModel();
    return VirtualBankAccount.findOne({ userId }).sort({ createdAt: -1 }).lean();
}
async function findExistingUsdtAddress(userId) {
    const prismaRow = await queryLatestUsdtAddressRow(userId);
    if (prismaRow)
        return prismaRow;
    if (!isMongoReady())
        return null;
    const UsdtAddress = getUsdtAddressModel();
    return UsdtAddress.findOne({ userId }).sort({ createdAt: -1 }).lean();
}
function extractUsdtAddress(payload) {
    if (!payload || typeof payload !== "object")
        return undefined;
    if (payload.address)
        return String(payload.address);
    if (payload.data?.address)
        return String(payload.data.address);
    if (payload.data?.wallet?.address)
        return String(payload.data.wallet.address);
    if (payload.wallet?.address)
        return String(payload.wallet.address);
    if (payload.walletAddress)
        return String(payload.walletAddress);
    if (payload.data?.walletAddress)
        return String(payload.data.walletAddress);
    if (payload.data?.wallet_address)
        return String(payload.data.wallet_address);
    if (payload.result?.address)
        return String(payload.result.address);
    if (payload.result?.walletAddress)
        return String(payload.result.walletAddress);
    if (payload.data?.result?.address)
        return String(payload.data.result.address);
    return undefined;
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
        const tryCardUserFallback = async () => {
            try {
                const altResp = await bitvcard.post("card-user/", payload, {
                    headers: { "Content-Type": "application/json" },
                    params: queryParams,
                });
                return altResp.data;
            }
            catch {
                const altResp = await bitvcard.get("card-user/", { params: queryParams });
                return altResp.data;
            }
        };
        const tryCreateUserGet = async () => {
            const resp = await bitvcard.get("create-user/", { params: queryParams });
            return resp.data;
        };
        let data;
        try {
            const resp = await bitvcard.post("create-user/", payload, {
                headers: { "Content-Type": "application/json" },
            });
            data = resp.data;
            const msg = String(data?.message || data?.error || "");
            if (data?.success === false && /register card user failed/i.test(msg)) {
                data = await tryCardUserFallback();
            }
        }
        catch (firstError) {
            if (firstError?.response?.status === 405) {
                data = await tryCreateUserGet();
            }
            else {
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
                }
                catch (secondError) {
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
        const customerId = data?.response?.customerId ||
            data?.response?.customer_id ||
            data?.customerId ||
            data?.customer_id;
        if (!customerId && body.customerEmail) {
            try {
                const maxAttempts = Number(process.env.STROWALLET_LOOKUP_ATTEMPTS || (process.env.NODE_ENV === "test" ? 1 : 6));
                const delayMs = Number(process.env.STROWALLET_LOOKUP_DELAY_MS || 1200);
                for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
                    if (attempt > 0)
                        await delay(delayMs);
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
                        break;
                    }
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
const LegacyCreateCardSchema = zod_1.z.object({
    name_on_card: zod_1.z.string().min(1),
    card_type: zod_1.z.string().min(1),
    amount: amountString,
    customerEmail: zod_1.z.string().email().optional(),
    customer_email: zod_1.z.string().email().optional(),
    mode: zod_1.z.string().optional(),
});
router.post("/create-card", async (req, res) => {
    try {
        const rawBody = req.body || {};
        const useLegacy = rawBody?.name_on_card ||
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
            };
            delete payload.customer_email;
            const resp = await bitvcard.post("create-card/", payload, {
                headers: { "Content-Type": "application/json" },
                params: payload,
            });
            return (0, apiResponse_1.ok)(res, resp.data, 200);
        }
        const body = applyDefaultMode(CreateNfcCardSchema.parse(rawBody));
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
// Virtual Bank Account (create or fetch)
router.get("/virtual-bank/account", async (req, res) => {
    try {
        return (0, apiResponse_1.fail)(res, "Virtual bank accounts are available for Nigerian users only", 403);
        const userId = String(req.query.userId || "").trim();
        if (!userId)
            return (0, apiResponse_1.fail)(res, "userId is required", 400);
        const existing = await findExistingVirtualAccount(userId);
        if (!existing)
            return (0, apiResponse_1.ok)(res, { account: null }, 200);
        return (0, apiResponse_1.ok)(res, { account: existing }, 200);
    }
    catch (e) {
        const { status, message } = normalizeError(e);
        return (0, apiResponse_1.fail)(res, message, status);
    }
});
router.post("/virtual-bank/account", async (req, res) => {
    try {
        return (0, apiResponse_1.fail)(res, "Virtual bank accounts are available for Nigerian users only", 403);
        const body = VirtualBankRequestSchema.parse(req.body || {});
        if (shouldSkipCreate(virtualAccountCreateLocks, body.userId, VIRTUAL_ACCOUNT_CREATE_TTL_MS)) {
            const cached = virtualAccountCreateLocks.get(body.userId);
            return (0, apiResponse_1.ok)(res, { account: cached?.account ?? null, pending: true }, 200);
        }
        if (!body.forceCreate) {
            const existing = await findExistingVirtualAccount(body.userId);
            if (existing)
                return (0, apiResponse_1.ok)(res, { account: existing }, 200);
        }
        if (body.forceCreate) {
            virtualAccountCreateLocks.set(body.userId, { startedAt: Date.now() });
        }
        const user = await findUserById(body.userId);
        const accountName = body.accountName || [user?.firstName, user?.lastName].filter(Boolean).join(" ") || user?.username || body.userId;
        const email = body.email || user?.customerEmail;
        const phone = body.phone || user?.phoneNumber;
        if (!email || !phone || !accountName) {
            return (0, apiResponse_1.fail)(res, "Missing email, phone, or accountName for virtual account", 400);
        }
        const public_key = requirePublicKey();
        const webhook_url = body.webhookUrl || getWebhookUrl("/api/webhook/strowallet");
        const provider = normalizeVirtualBankProvider(body.bank);
        const payload = {
            public_key,
            email,
            account_name: accountName,
            phone,
            webhook_url,
        };
        if (body.mode)
            payload.mode = body.mode;
        if (body.developerCode)
            payload.developer_code = body.developerCode;
        const resp = await api.post(`virtual-bank/${provider}`, payload, {
            headers: { "Content-Type": "application/json" },
        });
        const data = resp.data || {};
        const accountNumber = String(data?.accountNumber || data?.account_number || "");
        const sessionId = String(data?.sessionId || data?.session_id || "");
        if (!accountNumber) {
            return (0, apiResponse_1.ok)(res, { account: null, raw: data }, 200);
        }
        if ((0, persistence_1.isPrismaPersistenceEnabled)() && hasPrismaModel("virtualBankAccount")) {
            const saved = await prismaAny.virtualBankAccount.upsert({
                where: { accountNumber },
                create: {
                    userId: body.userId,
                    provider,
                    accountNumber,
                    accountName,
                    bankName: data?.sourceBankName || data?.bankName || null,
                    sessionId: sessionId || null,
                    currency: data?.currency || "NGN",
                    responseData: data,
                },
                update: {
                    userId: body.userId,
                    provider,
                    accountName,
                    bankName: data?.sourceBankName || data?.bankName || null,
                    sessionId: sessionId || null,
                    currency: data?.currency || "NGN",
                    responseData: data,
                },
            });
            return (0, apiResponse_1.ok)(res, { account: saved, raw: data }, 200);
        }
        if (!isMongoReady()) {
            const response = { account: null, raw: data };
            if (body.forceCreate)
                virtualAccountCreateLocks.set(body.userId, { startedAt: Date.now(), account: response.account });
            return (0, apiResponse_1.ok)(res, response, 200);
        }
        const VirtualBankAccount = getVirtualBankAccountModel();
        const saved = await VirtualBankAccount.findOneAndUpdate({ accountNumber }, {
            $set: {
                userId: body.userId,
                provider,
                accountName,
                bankName: data?.sourceBankName || data?.bankName,
                sessionId: sessionId || undefined,
                currency: data?.currency || "NGN",
                responseData: data,
            },
        }, { upsert: true, new: true });
        const response = { account: saved, raw: data };
        if (body.forceCreate)
            virtualAccountCreateLocks.set(body.userId, { startedAt: Date.now(), account: response.account });
        return (0, apiResponse_1.ok)(res, response, 200);
    }
    catch (e) {
        if (req?.body?.userId)
            virtualAccountCreateLocks.delete(String(req.body.userId));
        const { status, message } = normalizeError(e);
        return (0, apiResponse_1.fail)(res, message, status);
    }
});
// Bank list + account name + transfer
router.get("/banks/list", async (req, res) => {
    try {
        const public_key = requirePublicKey();
        const resp = await api.get("banks/lists", { params: { public_key } });
        return (0, apiResponse_1.ok)(res, resp.data, 200);
    }
    catch (e) {
        const { status, message } = normalizeError(e);
        return (0, apiResponse_1.fail)(res, message, status);
    }
});
router.get("/banks/resolve", async (req, res) => {
    try {
        const public_key = requirePublicKey();
        const bank_code = String(req.query.bank_code || "").trim();
        const account_number = String(req.query.account_number || "").trim();
        if (!bank_code || !account_number)
            return (0, apiResponse_1.fail)(res, "bank_code and account_number are required", 400);
        const resp = await api.get("banks/get-customer-name", {
            params: { public_key, bank_code, account_number },
        });
        return (0, apiResponse_1.ok)(res, resp.data, 200);
    }
    catch (e) {
        const { status, message } = normalizeError(e);
        return (0, apiResponse_1.fail)(res, message, status);
    }
});
router.post("/banks/transfer", async (req, res) => {
    try {
        const body = BankTransferSchema.parse(req.body || {});
        const public_key = requirePublicKey();
        const params = {
            public_key,
            amount: body.amount,
            bank_code: body.bank_code,
            account_number: body.account_number,
            narration: body.narration,
            name_enquiry_reference: body.name_enquiry_reference,
            SenderName: body.SenderName,
            mode: body.mode || getDefaultMode(),
        };
        const resp = await api.post("banks/request", undefined, { params });
        return (0, apiResponse_1.ok)(res, resp.data, 200);
    }
    catch (e) {
        const { status, message } = normalizeError(e);
        return (0, apiResponse_1.fail)(res, message, status);
    }
});
// USDT address
router.get("/usdt/address", async (req, res) => {
    try {
        const userId = String(req.query.userId || "").trim();
        if (!userId)
            return (0, apiResponse_1.fail)(res, "userId is required", 400);
        const existing = await findExistingUsdtAddress(userId);
        if (!existing) {
            const cached = usdtAddressCreateLocks.get(userId);
            if (cached?.address)
                return (0, apiResponse_1.ok)(res, { address: cached.address }, 200);
        }
        if (!existing)
            return (0, apiResponse_1.ok)(res, { address: null }, 200);
        return (0, apiResponse_1.ok)(res, { address: existing }, 200);
    }
    catch (e) {
        const { status, message } = normalizeError(e);
        return (0, apiResponse_1.fail)(res, message, status);
    }
});
router.post("/usdt/address", async (req, res) => {
    try {
        const body = UsdtAddressSchema.parse(req.body || {});
        if (shouldSkipCreate(usdtAddressCreateLocks, body.userId, USDT_ADDRESS_CREATE_TTL_MS)) {
            const cached = usdtAddressCreateLocks.get(body.userId);
            return (0, apiResponse_1.ok)(res, { address: cached?.address ?? null, pending: true }, 200);
        }
        const existing = await findExistingUsdtAddress(body.userId);
        if (existing)
            return (0, apiResponse_1.ok)(res, { address: existing, created: false }, 200);
        const cachedExisting = usdtAddressCreateLocks.get(body.userId);
        if (cachedExisting?.address)
            return (0, apiResponse_1.ok)(res, { address: cachedExisting.address, created: false }, 200);
        if (body.forceCreate) {
            usdtAddressCreateLocks.set(body.userId, { startedAt: Date.now() });
        }
        const user = await findUserById(body.userId);
        const email = body.email || user?.customerEmail;
        if (!email)
            return (0, apiResponse_1.fail)(res, "Missing email for USDT address", 400);
        const public_key = requirePublicKey();
        const label = body.label || `user:${body.userId}`;
        const webhook_url = body.webhookUrl || getWebhookUrl("/api/webhook/strowallet");
        const params = {
            public_key,
            label,
            email,
            webhook_url,
            mode: body.mode || getDefaultMode(),
        };
        if (shouldDebugStroWallet()) {
            console.log("[strowallet] usdt address request", {
                userId: body.userId,
                label,
                email: maskValue(email, 3, 3),
                webhook_url,
                mode: params.mode,
                public_key: maskValue(public_key, 4, 4),
            });
        }
        let data = {};
        try {
            const resp = await api.post("generate-address", undefined, { params });
            data = resp.data || {};
        }
        catch (providerErr) {
            const providerMessage = String(providerErr?.response?.data?.message || providerErr?.response?.data?.error || providerErr?.message || "");
            if (providerMessage.toLowerCase().includes("address already exists")) {
                const existing = await findExistingUsdtAddress(body.userId);
                if (existing) {
                    return (0, apiResponse_1.ok)(res, { address: existing, raw: providerErr?.response?.data || null, created: false }, 200);
                }
            }
            throw providerErr;
        }
        if (shouldDebugStroWallet()) {
            console.log("[strowallet] usdt address response", data);
        }
        const address = extractUsdtAddress(data);
        if (!address) {
            if (shouldDebugStroWallet()) {
                console.warn("[strowallet] usdt address missing from response", data);
            }
            return (0, apiResponse_1.ok)(res, { address: null, raw: data }, 200);
        }
        if ((0, persistence_1.isPrismaPersistenceEnabled)()) {
            const saved = await upsertUsdtAddressRow({
                userId: body.userId,
                address,
                label,
                responseData: data,
            });
            const response = { address: saved ?? { userId: body.userId, address, label, network: "TRC20", status: "active" }, raw: data, created: true };
            usdtAddressCreateLocks.set(body.userId, { startedAt: Date.now(), address: response.address });
            return (0, apiResponse_1.ok)(res, response, 200);
        }
        if (!isMongoReady()) {
            const response = { address: { address, userId: body.userId, label, network: "TRC20", status: "active" }, raw: data, created: true };
            usdtAddressCreateLocks.set(body.userId, { startedAt: Date.now(), address: response.address });
            return (0, apiResponse_1.ok)(res, response, 200);
        }
        const UsdtAddress = getUsdtAddressModel();
        const saved = await UsdtAddress.findOneAndUpdate({ address }, {
            $set: {
                userId: body.userId,
                label,
                responseData: data,
            },
        }, { upsert: true, new: true });
        const response = { address: saved, raw: data, created: true };
        usdtAddressCreateLocks.set(body.userId, { startedAt: Date.now(), address: response.address });
        return (0, apiResponse_1.ok)(res, response, 200);
    }
    catch (e) {
        if (req?.body?.userId)
            usdtAddressCreateLocks.delete(String(req.body.userId));
        const { status, message } = normalizeError(e);
        return (0, apiResponse_1.fail)(res, message, status);
    }
});
// USDT history by address
router.get("/usdt/history", async (req, res) => {
    try {
        const query = UsdtHistoryQuerySchema.parse(req.query || {});
        const public_key = requirePublicKey();
        const resp = await api.get("get-usdt-history", {
            params: {
                public_key,
                address: query.address,
            },
        });
        return (0, apiResponse_1.ok)(res, resp.data, 200);
    }
    catch (e) {
        const { status, message } = normalizeError(e);
        return (0, apiResponse_1.fail)(res, message, status);
    }
});
// USDT balance (platform wallet)
router.get("/usdt/balance", async (req, res) => {
    try {
        const userId = String(req.query.userId || "").trim();
        if (userId) {
            if ((0, persistence_1.isPrismaPersistenceEnabled)()) {
                const user = await prisma_1.default.user.findUnique({ where: { userId } });
                const balance = Number(user?.balance ?? 0);
                return (0, apiResponse_1.ok)(res, { balance, currency: "USDT", source: "user" }, 200);
            }
            if (!isMongoReady())
                return (0, apiResponse_1.ok)(res, { balance: 0, currency: "USDT", source: "user" }, 200);
            const user = await User_1.default.findOne({ userId }).lean();
            const balance = Number(user?.balance ?? 0);
            return (0, apiResponse_1.ok)(res, { balance, currency: "USDT", source: "user" }, 200);
        }
        const public_key = requirePublicKey();
        const currencyRaw = String(req.query.currency || "USD").trim().toUpperCase();
        const normalized = currencyRaw === "USDT" ? "USD" : currencyRaw;
        const currency = /^[A-Z]{3,5}$/.test(normalized) ? normalized : "USD";
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
// Send USDT
router.post("/usdt/send", async (req, res) => {
    try {
        const body = UsdtSendSchema.parse(req.body || {});
        const public_key = requirePublicKey();
        const vip_key = body.vipKey || process.env.STROWALLET_VIP_KEY;
        if (!vip_key)
            return (0, apiResponse_1.fail)(res, "Send USDT is available on VIP plan only", 403);
        const params = {
            public_key,
            vip_key,
            amount: body.amount,
            address: body.address,
        };
        const mode = normalizeMode(body.mode || getDefaultMode());
        if (mode)
            params.mode = mode;
        const resp = await api.post("send-usdt", undefined, { params });
        return (0, apiResponse_1.ok)(res, resp.data, 200);
    }
    catch (e) {
        const { status, message } = normalizeError(e);
        return (0, apiResponse_1.fail)(res, message, status);
    }
});
// User-level USDT deposit history (internal ledger)
router.get("/usdt/transactions", async (req, res) => {
    try {
        const userId = String(req.query.userId || "").trim();
        if (!userId)
            return (0, apiResponse_1.fail)(res, "userId is required", 400);
        const limit = Number(req.query.limit || 10);
        const items = await listUserUsdtDeposits(userId, limit);
        return (0, apiResponse_1.ok)(res, { items, total: items.length }, 200);
    }
    catch (e) {
        const { status, message } = normalizeError(e);
        return (0, apiResponse_1.fail)(res, message, status);
    }
});
// Bills: electricity + airtime + data
router.post("/bills/electricity", async (req, res) => {
    try {
        const body = ElectricitySchema.parse(req.body || {});
        const public_key = requirePublicKey();
        const payload = { public_key, ...body };
        const resp = await api.post("electricity/request", payload, {
            headers: { "Content-Type": "application/json" },
        });
        return (0, apiResponse_1.ok)(res, resp.data, 200);
    }
    catch (e) {
        const { status, message } = normalizeError(e);
        return (0, apiResponse_1.fail)(res, message, status);
    }
});
// Bills: airtime + data
router.post("/bills/airtime", async (req, res) => {
    try {
        const body = AirtimeSchema.parse(req.body || {});
        const public_key = requirePublicKey();
        const payload = { public_key, ...body };
        const resp = await api.post("buyairtime/request", payload, {
            headers: { "Content-Type": "application/json" },
        });
        return (0, apiResponse_1.ok)(res, resp.data, 200);
    }
    catch (e) {
        const { status, message } = normalizeError(e);
        return (0, apiResponse_1.fail)(res, message, status);
    }
});
router.get("/bills/data/plans", async (req, res) => {
    try {
        const query = DataPlanQuerySchema.parse(req.query || {});
        const public_key = requirePublicKey();
        const resp = await api.get("buydata/plans", {
            params: { public_key, service_name: query.service_name },
        });
        return (0, apiResponse_1.ok)(res, resp.data, 200);
    }
    catch (e) {
        const { status, message } = normalizeError(e);
        return (0, apiResponse_1.fail)(res, message, status);
    }
});
router.post("/bills/data", async (req, res) => {
    try {
        const body = BuyDataSchema.parse(req.body || {});
        const public_key = requirePublicKey();
        const payload = { public_key, ...body };
        const resp = await api.post("buydata/request", payload, {
            headers: { "Content-Type": "application/json" },
        });
        return (0, apiResponse_1.ok)(res, resp.data, 200);
    }
    catch (e) {
        const { status, message } = normalizeError(e);
        return (0, apiResponse_1.fail)(res, message, status);
    }
});
exports.default = router;
