"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.topUpCard = topUpCard;
const axios_1 = __importDefault(require("axios"));
const mongoose_1 = __importDefault(require("mongoose"));
const Transaction_1 = __importDefault(require("../models/Transaction"));
const User_1 = __importDefault(require("../models/User"));
const pricingService_1 = require("./pricingService");
const BITVCARD_BASE = "https://strowallet.com/api/bitvcard/";
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
function requirePublicKey() {
    const key = process.env.STROWALLET_PUBLIC_KEY;
    if (!key) {
        const err = new Error("Missing STROWALLET_PUBLIC_KEY env");
        err.status = 500;
        throw err;
    }
    return key;
}
async function fundCard(cardId, amount, mode) {
    const public_key = requirePublicKey();
    const resolvedMode = normalizeMode(mode ?? getDefaultMode());
    const payload = { card_id: cardId, amount: amount.toString(), public_key, mode: resolvedMode };
    const resp = await axios_1.default.post(`${BITVCARD_BASE}fund-card/`, payload, { timeout: 20000 });
    return resp.data;
}
async function topUpCard(params) {
    const { userId, cardId, amountUsdt, mode } = params;
    if (!amountUsdt || amountUsdt <= 0) {
        return { success: false, message: "Top-up amount must be greater than zero" };
    }
    const pricing = await (0, pricingService_1.loadPricingConfig)();
    (0, pricingService_1.enforceTopupLimits)(amountUsdt, pricing);
    const quote = (0, pricingService_1.quoteTopup)(amountUsdt, pricing);
    const session = await mongoose_1.default.startSession();
    session.startTransaction();
    try {
        let user = await User_1.default.findOne({ userId }).session(session);
        if (!user) {
            user = await User_1.default.create([{ userId, balance: 0, currency: "USDT" }], { session }).then((r) => r[0]);
        }
        if (!user) {
            throw Object.assign(new Error("User not initialized"), { status: 500 });
        }
        const txnNumber = `TOPUP-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const tx = await Transaction_1.default.create([
            {
                userId,
                transactionType: "withdrawal",
                paymentMethod: "system",
                amount: quote.totalChargeUsdt,
                amountUsdt,
                feeUsdt: quote.feeUsdt,
                currency: "USDT",
                status: "pending",
                transactionNumber: txnNumber,
                referenceNumber: txnNumber,
                metadata: { cardId, mode },
            },
        ], { session });
        if (user.balance < quote.totalChargeUsdt) {
            throw Object.assign(new Error("Insufficient balance"), { status: 400 });
        }
        const updatedUser = await User_1.default.findOneAndUpdate({ userId, balance: { $gte: quote.totalChargeUsdt } }, { $inc: { balance: -quote.totalChargeUsdt }, $setOnInsert: { currency: "USDT" } }, { new: true, upsert: false, session });
        if (!updatedUser) {
            throw Object.assign(new Error("Insufficient balance"), { status: 400 });
        }
        const providerResponse = await fundCard(cardId, amountUsdt, mode);
        await Transaction_1.default.updateOne({ _id: tx[0]._id }, { $set: { status: "completed", responseData: providerResponse, referenceNumber: providerResponse?.id || providerResponse?.ref } }, { session });
        await session.commitTransaction();
        session.endSession();
        return {
            success: true,
            message: "Card topped up successfully",
            transactionId: tx[0]._id,
            chargedUsdt: quote.totalChargeUsdt,
            topupAmountUsdt: amountUsdt,
            feeUsdt: quote.feeUsdt,
            newBalance: updatedUser.balance,
            providerResponse,
        };
    }
    catch (err) {
        try {
            await session.abortTransaction();
        }
        catch { }
        session.endSession();
        const status = err?.status || err?.response?.status || 500;
        const message = err?.message || err?.response?.data?.error || "Top-up failed";
        return { success: false, message, status };
    }
}
