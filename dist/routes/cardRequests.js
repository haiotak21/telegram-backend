"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const axios_1 = __importDefault(require("axios"));
const CardRequest_1 = __importDefault(require("../models/CardRequest"));
const TelegramLink_1 = require("../models/TelegramLink");
const botService_1 = require("../services/botService");
const router = express_1.default.Router();
const BITVCARD_BASE = "https://strowallet.com/api/bitvcard/";
function asString(val) {
    if (val === undefined || val === null)
        return undefined;
    return String(val);
}
function asEmail(val) {
    const s = asString(val);
    if (!s)
        return undefined;
    return /@/.test(s) ? s : undefined;
}
function requireAdmin(req, res, next) {
    const adminToken = process.env.ADMIN_API_TOKEN;
    if (!adminToken)
        return next();
    const provided = req.headers["x-admin-token"];
    if (provided && provided === adminToken)
        return next();
    return res.status(401).json({ success: false, message: "Unauthorized" });
}
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
    if (axios_1.default.isAxiosError(e)) {
        const ae = e;
        const status = ae.response?.status ?? 400;
        const payload = ae.response?.data;
        const validation = payload?.data?.errors || payload?.errors;
        const validationMsg = validation ? JSON.stringify(validation) : undefined;
        const msg = payload?.message || payload?.error || validationMsg || ae.message || "Request failed";
        return { status, body: { success: false, message: String(msg), data: payload } };
    }
    const status = e?.status ?? 400;
    const msg = e?.message ?? "Request error";
    return { status, body: { success: false, message: String(msg) } };
}
function buildBitvcardClient() {
    return axios_1.default.create({
        baseURL: BITVCARD_BASE,
        timeout: 15000,
        headers: {
            Authorization: process.env.STROWALLET_API_KEY ? `Bearer ${process.env.STROWALLET_API_KEY}` : undefined,
        },
    });
}
router.post("/", async (req, res) => {
    try {
        const body = req.body || {};
        const userId = asString(body.userId);
        if (!userId)
            throw new Error("userId is required");
        // Block new requests if user already has a card or a pending/approved request
        const chatIdNum = Number(userId);
        if (Number.isFinite(chatIdNum)) {
            const link = await TelegramLink_1.TelegramLink.findOne({ chatId: chatIdNum }).lean();
            if (link?.cardIds?.length) {
                return res.status(400).json({ success: false, message: "User already has a card linked" });
            }
        }
        const existing = await CardRequest_1.default.findOne({ userId, status: { $in: ["pending", "approved"] } }).lean();
        if (existing) {
            return res.status(400).json({ success: false, message: "You already have an active or approved card request" });
        }
        const request = await CardRequest_1.default.create({
            userId,
            nameOnCard: asString(body.nameOnCard),
            cardType: asString(body.cardType),
            amount: body.amount != null ? String(body.amount) : undefined,
            customerEmail: asEmail(body.customerEmail),
            mode: asString(body.mode),
            metadata: body.metadata,
            status: "pending",
        });
        res.status(201).json({ success: true, request });
    }
    catch (err) {
        const message = err?.errors?.[0]?.message || err?.message || "Invalid payload";
        res.status(400).json({ success: false, message });
    }
});
router.get("/", requireAdmin, async (req, res) => {
    try {
        const status = typeof req.query.status === "string" ? req.query.status : "pending";
        const limitRaw = Number(req.query.limit ?? 50);
        const limit = Number.isFinite(limitRaw) && limitRaw > 0 && limitRaw <= 200 ? limitRaw : 50;
        const requests = await CardRequest_1.default.find(status ? { status } : {}).sort({ createdAt: -1 }).limit(limit).lean();
        res.json({ success: true, requests });
    }
    catch (err) {
        const message = err?.message || "Failed to load requests";
        res.status(400).json({ success: false, message });
    }
});
router.post("/:id/approve", requireAdmin, async (req, res) => {
    try {
        const body = req.body || {};
        const request = await CardRequest_1.default.findById(req.params.id);
        if (!request)
            return res.status(404).json({ success: false, message: "Request not found" });
        if (request.status !== "pending")
            return res.status(400).json({ success: false, message: "Request already processed" });
        const link = await TelegramLink_1.TelegramLink.findOne({ chatId: Number(request.userId) }).lean();
        const nameOnCard = asString(body.nameOnCard) || request.nameOnCard || "StroWallet User";
        const cardType = (asString(body.cardType) || request.cardType || "visa").toLowerCase();
        const amountRaw = body.amount ?? request.amount ?? "0";
        const amountStr = typeof amountRaw === "number" ? amountRaw.toString() : String(amountRaw || "0");
        const parsedAmount = Number(amountStr);
        const amount = Number.isFinite(parsedAmount) && parsedAmount > 0 ? parsedAmount.toString() : undefined;
        const customerEmail = asEmail(body.customerEmail) || request.customerEmail || link?.customerEmail;
        const mode = asString(body.mode) || request.mode;
        if (!customerEmail) {
            return res.status(400).json({ success: false, message: "customerEmail is required to create a card" });
        }
        if (!amount) {
            return res.status(400).json({ success: false, message: "amount must be greater than zero" });
        }
        const allowedCardTypes = ["visa", "mastercard"];
        if (!allowedCardTypes.includes(cardType)) {
            return res.status(400).json({ success: false, message: `card_type must be one of: ${allowedCardTypes.join(", ")}` });
        }
        const bitvcard = buildBitvcardClient();
        const public_key = requirePublicKey();
        const payload = {
            name_on_card: nameOnCard,
            card_type: cardType,
            amount,
            customerEmail,
            public_key,
            mode,
        };
        const resp = await bitvcard.post("create-card/", payload);
        const respData = resp.data;
        const cardId = respData?.card_id || respData?.id || respData?.data?.card_id || respData?.data?.id;
        const cardNumber = respData?.card_number || respData?.data?.card_number;
        const cvc = respData?.cvc || respData?.cvv || respData?.data?.cvc || respData?.data?.cvv;
        if (!cardId) {
            return res.status(502).json({ success: false, message: "Card creation succeeded but no card_id returned", data: respData });
        }
        request.status = "approved";
        request.cardId = cardId;
        request.cardNumber = cardNumber;
        request.cvc = cvc;
        request.responseData = respData;
        request.adminNote = asString(body.adminNote) ?? request.adminNote;
        request.nameOnCard = nameOnCard;
        request.cardType = cardType;
        request.amount = amount;
        request.customerEmail = customerEmail;
        request.mode = mode;
        await request.save();
        // Store card id on Telegram link for "My Cards" view
        await TelegramLink_1.TelegramLink.findOneAndUpdate({ chatId: Number(request.userId) }, { $addToSet: { cardIds: cardId }, $setOnInsert: { customerEmail } }, { upsert: true });
        (0, botService_1.notifyCardRequestApproved)(request.userId, { cardId, cardType, nameOnCard, raw: respData }).catch(() => { });
        res.json({ success: true, request, cardId, response: respData });
    }
    catch (e) {
        console.error("card-requests approve error", {
            id: req.params.id,
            body: req.body,
            err: e?.response?.data || e?.message,
        });
        const { status, body } = normalizeError(e);
        res.status(status).json(body);
    }
});
router.post("/:id/decline", requireAdmin, async (req, res) => {
    try {
        const body = req.body || {};
        const request = await CardRequest_1.default.findById(req.params.id);
        if (!request)
            return res.status(404).json({ success: false, message: "Request not found" });
        if (request.status !== "pending")
            return res.status(400).json({ success: false, message: "Request already processed" });
        request.status = "declined";
        request.decisionReason = asString(body.reason);
        request.adminNote = asString(body.adminNote) ?? request.adminNote;
        await request.save();
        (0, botService_1.notifyCardRequestDeclined)(request.userId, body.reason).catch(() => { });
        res.json({ success: true, request });
    }
    catch (err) {
        const message = err?.errors?.[0]?.message || err?.message || "Invalid request";
        res.status(400).json({ success: false, message });
    }
});
exports.default = router;
