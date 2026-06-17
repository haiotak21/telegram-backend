"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const axios_1 = __importDefault(require("axios"));
const mongoose_1 = __importDefault(require("mongoose"));
const zod_1 = require("zod");
const User_1 = __importDefault(require("../models/User"));
const Card_1 = __importDefault(require("../models/Card"));
const CardRequest_1 = __importDefault(require("../models/CardRequest"));
const Customer_1 = __importDefault(require("../models/Customer"));
const pricingService_1 = require("../services/pricingService");
const topupService_1 = require("../services/topupService");
const TelegramLink_1 = require("../models/TelegramLink");
const Transaction_1 = __importDefault(require("../models/Transaction"));
const RuntimeAudit_1 = __importDefault(require("../models/RuntimeAudit"));
const botService_1 = require("../services/botService");
const apiResponse_1 = require("../utils/apiResponse");
const prisma_1 = __importDefault(require("../utils/prisma"));
const persistence_1 = require("../utils/persistence");
const router = express_1.default.Router();
const AmountEtbSchema = zod_1.z.object({ amountEtb: zod_1.z.number().positive("amountEtb must be greater than 0") });
const AmountUsdtSchema = zod_1.z.object({ amountUsdt: zod_1.z.number().positive() });
const BalanceParamSchema = zod_1.z.object({ userId: zod_1.z.string().min(1) });
const PricingSchema = zod_1.z.object({
    usdtRate: zod_1.z.number().positive(),
    depositPercentFee: zod_1.z.number().min(0),
    depositFlatFee: zod_1.z.number().min(0),
    topupPercentFee: zod_1.z.number().min(0),
    topupFlatFee: zod_1.z.number().min(0),
    topupMin: zod_1.z.number().min(0).optional(),
    topupMax: zod_1.z.number().min(0).optional(),
    cardRequestFeeEtb: zod_1.z.number().min(0).optional(),
    cardRequestWalletFeeTier1Usd: zod_1.z.number().min(0).optional(),
    cardRequestWalletFeeTier2Usd: zod_1.z.number().min(0).optional(),
    cardRequestWalletFeeTier3Usd: zod_1.z.number().min(0).optional(),
    topupCommissionPercent: zod_1.z.number().min(0).optional(),
    transferFeePercent: zod_1.z.number().min(0).optional(),
    billPaymentFeePercent: zod_1.z.number().min(0).optional(),
    firstCardAmountUsd: zod_1.z.number().min(0).optional(),
    firstCardFeeUsd: zod_1.z.number().min(0).optional(),
    updatedBy: zod_1.z.string().optional(),
});
const TopupSchema = zod_1.z.object({
    userId: zod_1.z.string().min(1),
    cardId: zod_1.z.string().min(1),
    amountUsdt: zod_1.z.number().positive(),
    mode: zod_1.z.string().optional(),
});
const ResetUsersSchema = zod_1.z.object({
    scope: zod_1.z.enum(["single", "all"]).default("all"),
    userId: zod_1.z.string().optional(),
    removeTransactions: zod_1.z.boolean().optional(),
    reason: zod_1.z.string().optional(),
});
const TransactionDecisionSchema = zod_1.z.object({
    action: zod_1.z.enum(["approve", "decline"]),
    reason: zod_1.z.string().max(500).optional(),
});
function requireAdmin(req, res, next) {
    const adminToken = process.env.ADMIN_API_TOKEN;
    if (!adminToken)
        return next();
    const provided = req.headers["x-admin-token"];
    if (provided && provided === adminToken)
        return next();
    return (0, apiResponse_1.fail)(res, "Unauthorized", 401);
}
function getBackendBaseCandidates() {
    const port = process.env.PORT || 3000;
    const configured = (process.env.BOT_BACKEND_BASE || "").trim();
    const defaults = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
    const all = [...defaults, configured].filter(Boolean).map((v) => String(v).replace(/\/$/, ""));
    return Array.from(new Set(all));
}
function isRetryableBackendError(err) {
    const code = String(err?.code || "").toUpperCase();
    if (["ENOTFOUND", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ECONNRESET"].includes(code))
        return true;
    const message = String(err?.message || "").toLowerCase();
    if (message.includes("getaddrinfo enotfound") || message.includes("enotfound"))
        return true;
    const status = Number(err?.response?.status || 0);
    return status >= 500;
}
function describeHttpError(err, fallback) {
    const body = err?.response?.data;
    const bodyText = typeof body === "string"
        ? body
        : body && typeof body === "object"
            ? body.error || body.message || body.detail || JSON.stringify(body)
            : "";
    const status = err?.response?.status ? ` (${err.response.status})` : "";
    const msg = bodyText || err?.message || fallback;
    return `${String(msg)}${status}`;
}
async function createCardRequestViaBackend(payload) {
    let lastError;
    for (const base of getBackendBaseCandidates()) {
        try {
            return await axios_1.default.post(`${base}/api/card-requests`, payload, { timeout: 30000 });
        }
        catch (err) {
            lastError = err;
            if (!isRetryableBackendError(err)) {
                throw err;
            }
            console.warn("[wallet] create-card-request backend attempt failed", {
                base,
                code: err?.code,
                status: err?.response?.status,
                message: err?.response?.data?.error || err?.message,
            });
        }
    }
    throw lastError;
}
// Admin: list runtime audits
router.get("/audit", requireAdmin, async (_req, res) => {
    try {
        const items = await RuntimeAudit_1.default.find().sort({ createdAt: -1 }).limit(200).lean();
        return (0, apiResponse_1.ok)(res, { items });
    }
    catch (e) {
        return (0, apiResponse_1.fail)(res, e?.message || "Failed to load audits", 500);
    }
});
router.get("/config", requireAdmin, async (_req, res) => {
    const config = await (0, pricingService_1.loadPricingConfig)();
    return (0, apiResponse_1.ok)(res, { config });
});
router.put("/config", requireAdmin, async (req, res) => {
    try {
        const body = PricingSchema.parse(req.body || {});
        const updated = await (0, pricingService_1.upsertPricingConfig)(body);
        return (0, apiResponse_1.ok)(res, { config: updated });
    }
    catch (err) {
        const message = err?.errors?.[0]?.message || err?.message || "Invalid payload";
        return (0, apiResponse_1.fail)(res, message, 400);
    }
});
router.get("/balance/:userId", async (req, res) => {
    try {
        const params = BalanceParamSchema.parse(req.params);
        if ((0, persistence_1.isPrismaPersistenceEnabled)()) {
            const user = await prisma_1.default.user.findUnique({ where: { userId: params.userId } });
            const customerEmail = user?.customerEmail || undefined;
            const card = await prisma_1.default.card.findFirst({
                where: {
                    OR: [{ userId: params.userId }, ...(customerEmail ? [{ customerEmail }] : [])],
                },
                orderBy: { updatedAt: "desc" },
            });
            const walletBalance = Number(user?.balance ?? 0);
            const cardBalanceCandidate = Number(card?.balance ?? card?.availableBalance ?? NaN);
            const hasCardBalance = Number.isFinite(cardBalanceCandidate);
            const balance = hasCardBalance ? cardBalanceCandidate : (Number.isFinite(walletBalance) ? walletBalance : 0);
            const currency = (card?.currency || user?.currency || "USDT").toUpperCase();
            return (0, apiResponse_1.ok)(res, {
                balance,
                currency,
                walletBalance: Number.isFinite(walletBalance) ? walletBalance : 0,
                cardBalance: hasCardBalance ? cardBalanceCandidate : null,
                source: hasCardBalance ? "card" : "wallet",
            });
        }
        const user = await User_1.default.findOne({ userId: params.userId }).lean();
        const customer = await Customer_1.default.findOne({ userId: params.userId }).lean();
        const customerEmail = customer?.email || user?.customerEmail;
        const card = await Card_1.default.findOne({
            $or: [
                { userId: params.userId },
                ...(customerEmail ? [{ customerEmail }] : []),
            ],
        })
            .sort({ updatedAt: -1 })
            .lean();
        const walletBalance = Number(user?.balance ?? 0);
        const cardBalanceCandidate = Number(card?.balance ?? card?.availableBalance ?? NaN);
        const hasCardBalance = Number.isFinite(cardBalanceCandidate);
        const balance = hasCardBalance ? cardBalanceCandidate : (Number.isFinite(walletBalance) ? walletBalance : 0);
        const currency = String(card?.currency || user?.currency || "USDT").toUpperCase();
        return (0, apiResponse_1.ok)(res, {
            balance,
            currency,
            walletBalance: Number.isFinite(walletBalance) ? walletBalance : 0,
            cardBalance: hasCardBalance ? cardBalanceCandidate : null,
            source: hasCardBalance ? "card" : "wallet",
        });
    }
    catch (err) {
        const message = err?.errors?.[0]?.message || err?.message || "Invalid request";
        return (0, apiResponse_1.fail)(res, message, 400);
    }
});
router.post("/deposit/quote", async (req, res) => {
    try {
        const body = AmountEtbSchema.parse(req.body || {});
        const config = await (0, pricingService_1.loadPricingConfig)();
        const quote = (0, pricingService_1.quoteDeposit)(body.amountEtb, config);
        return (0, apiResponse_1.ok)(res, { quote });
    }
    catch (err) {
        const message = err?.errors?.[0]?.message || err?.message || "Invalid request";
        return (0, apiResponse_1.fail)(res, message, 400);
    }
});
router.post("/topup/quote", async (req, res) => {
    try {
        const body = AmountUsdtSchema.parse(req.body || {});
        const config = await (0, pricingService_1.loadPricingConfig)();
        (0, pricingService_1.enforceTopupLimits)(body.amountUsdt, config);
        const quote = (0, pricingService_1.quoteTopup)(body.amountUsdt, config);
        return (0, apiResponse_1.ok)(res, { quote });
    }
    catch (err) {
        const status = err?.status || 400;
        const message = err?.errors?.[0]?.message || err?.message || "Invalid request";
        return (0, apiResponse_1.fail)(res, message, status);
    }
});
router.post("/topup", async (req, res) => {
    try {
        const body = TopupSchema.parse(req.body || {});
        const result = await (0, topupService_1.topUpCard)(body);
        const status = result.success ? 200 : result.status || 400;
        if (result.success)
            return (0, apiResponse_1.ok)(res, result, status);
        return (0, apiResponse_1.fail)(res, result.message || "Top-up failed", status);
    }
    catch (err) {
        const status = err?.status || 400;
        const message = err?.errors?.[0]?.message || err?.message || "Invalid request";
        return (0, apiResponse_1.fail)(res, message, status);
    }
});
// Manual admin deposit: directly credit user balance and record transaction
router.post("/deposit/manual", requireAdmin, async (req, res) => {
    return (0, apiResponse_1.fail)(res, "Manual deposits are disabled. StroWallet is the source of truth.", 405);
});
// Recent transactions (admin): helps admins find userIds and recent activity
router.get("/transactions/recent", requireAdmin, async (req, res) => {
    try {
        const limitRaw = Number(req.query.limit ?? 20);
        const limit = Number.isFinite(limitRaw) && limitRaw > 0 && limitRaw <= 200 ? limitRaw : 20;
        if ((0, persistence_1.isPrismaPersistenceEnabled)()) {
            const rows = await prisma_1.default.transaction.findMany({
                where: { transactionType: "deposit" },
                orderBy: { createdAt: "desc" },
                take: limit,
            });
            return (0, apiResponse_1.ok)(res, { items: rows.map((r) => ({ ...r, cardId: null })) });
        }
        const items = await Transaction_1.default.find({ transactionType: "deposit" })
            .sort({ createdAt: -1 })
            .limit(limit)
            .lean();
        const userIds = Array.from(new Set(items.map((i) => i.userId).filter(Boolean)));
        const chatIds = userIds
            .map((u) => Number(u))
            .filter((n) => Number.isFinite(n));
        const links = chatIds.length
            ? await TelegramLink_1.TelegramLink.find({ chatId: { $in: chatIds } })
                .select({ chatId: 1, cardIds: 1 })
                .lean()
            : [];
        const linkMap = new Map(links.map((l) => [String(l.chatId), l.cardIds?.[0] || null]));
        const decorated = items.map((i) => ({ ...i, cardId: linkMap.get(String(i.userId)) || null }));
        return (0, apiResponse_1.ok)(res, { items: decorated });
    }
    catch (err) {
        const message = err?.message || "Failed to load transactions";
        return (0, apiResponse_1.fail)(res, message, 400);
    }
});
router.post("/transactions/:id/decision", requireAdmin, async (req, res) => {
    console.log("[wallet] transaction decision request", {
        params: req.params,
        rawUrl: req.originalUrl,
        body: req.body,
        contentType: req.headers["content-type"],
    });
    if ((0, persistence_1.isPrismaPersistenceEnabled)()) {
        try {
            const id = String(req.params.id || "").trim();
            if (!id)
                return (0, apiResponse_1.fail)(res, "Transaction id is required", 400);
            const { action, reason } = TransactionDecisionSchema.parse(req.body || {});
            const tx = await prisma_1.default.transaction.findFirst({
                where: {
                    OR: [{ id }, { transactionNumber: id }, { referenceNumber: id }],
                },
            });
            if (!tx)
                return (0, apiResponse_1.fail)(res, "Transaction not found", 404);
            if (tx.transactionType !== "deposit")
                return (0, apiResponse_1.fail)(res, "Only deposit transactions can be reviewed manually", 400);
            if (tx.status === "completed") {
                return (0, apiResponse_1.ok)(res, {
                    id: tx.id,
                    status: tx.status,
                    message: "Transaction already completed",
                });
            }
            if (tx.status !== "pending") {
                return (0, apiResponse_1.fail)(res, `Only pending transactions can be reviewed (current: ${tx.status})`, 400);
            }
            const txMetadata = tx.metadata && typeof tx.metadata === "object" && !Array.isArray(tx.metadata) ? tx.metadata : {};
            if (action === "decline") {
                await prisma_1.default.transaction.update({
                    where: { id: tx.id },
                    data: {
                        status: "failed",
                        verified: false,
                        metadata: {
                            ...txMetadata,
                            manualReviewRequired: false,
                            manualReview: {
                                status: "declined",
                                reviewedAt: new Date(),
                                reviewedBy: "admin",
                                reason: reason || "Declined by admin",
                            },
                        },
                    },
                });
                await (0, botService_1.notifyDepositReviewDeclined)(String(tx.userId), reason).catch((notifyErr) => {
                    console.warn("Failed to notify declined deposit review", {
                        userId: String(tx.userId),
                        txId: tx.id,
                        error: notifyErr?.message || String(notifyErr),
                    });
                });
                return (0, apiResponse_1.ok)(res, { id: tx.id, status: "failed", action });
            }
            const isCardRequestManual = txMetadata?.kind === "card_request_manual";
            if (isCardRequestManual) {
                const userId = String(tx.userId);
                const userRecord = await prisma_1.default.user.findUnique({ where: { userId } });
                if (!userRecord)
                    return (0, apiResponse_1.fail)(res, "User not found", 404);
                const cardAmountUsdRaw = txMetadata?.cardAmountUsd;
                const cardAmountUsd = Number(cardAmountUsdRaw);
                const amount = Number.isFinite(cardAmountUsd) && cardAmountUsd >= 3 ? cardAmountUsd : 3;
                const nameOnCard = [userRecord.firstName, userRecord.lastName].filter(Boolean).join(" ") || "StroWallet User";
                const customerEmail = userRecord.customerEmail;
                if (!customerEmail)
                    return (0, apiResponse_1.fail)(res, "User email is missing for card request", 400);
                let createResp;
                try {
                    createResp = await createCardRequestViaBackend({
                        userId,
                        nameOnCard,
                        cardType: "nfc",
                        amount: String(amount),
                        customerEmail,
                        metadata: {
                            source: "admin_manual_review",
                            transactionId: tx.id,
                        },
                    });
                }
                catch (createErr) {
                    const msg = describeHttpError(createErr, "Failed to create card request");
                    return (0, apiResponse_1.fail)(res, msg, 400);
                }
                const cardId = createResp?.data?.data?.cardId;
                await prisma_1.default.transaction.update({
                    where: { id: tx.id },
                    data: {
                        status: "completed",
                        verified: true,
                        metadata: {
                            ...txMetadata,
                            manualReviewRequired: false,
                            manualReview: {
                                status: "approved",
                                reviewedAt: new Date(),
                                reviewedBy: "admin",
                                reason: reason || "Approved by admin",
                            },
                            cardRequest: {
                                approvedAt: new Date(),
                                cardId: cardId || null,
                            },
                        },
                    },
                });
                return (0, apiResponse_1.ok)(res, { id: tx.id, status: "completed", action, cardId: cardId || null });
            }
            const amountEtbRaw = tx.amountEtb ?? txMetadata?.expectedAmountEtb ?? tx.amount;
            const amountEtb = Number(amountEtbRaw);
            if (!Number.isFinite(amountEtb) || amountEtb <= 0) {
                return (0, apiResponse_1.fail)(res, "Cannot approve transaction without a valid ETB amount", 400);
            }
            const pricing = await (0, pricingService_1.loadPricingConfig)();
            const quote = (0, pricingService_1.quoteDeposit)(amountEtb, pricing);
            if (quote.creditedUsdt <= 0)
                return (0, apiResponse_1.fail)(res, "Deposit amount is too low after fees", 400);
            const user = await prisma_1.default.user.findUnique({ where: { userId: String(tx.userId) } });
            if (!user)
                return (0, apiResponse_1.fail)(res, "User not found", 404);
            const updatedUser = await prisma_1.default.user.update({
                where: { userId: String(tx.userId) },
                data: { balance: (user.balance || 0) + quote.creditedUsdt },
            });
            await prisma_1.default.transaction.update({
                where: { id: tx.id },
                data: {
                    status: "completed",
                    verified: true,
                    amountEtb,
                    amountUsdt: quote.creditedUsdt,
                    amount: quote.creditedUsdt,
                    currency: "USDT",
                    feeEtb: quote.feeEtb,
                    rateSnapshot: quote.rate,
                    metadata: {
                        ...txMetadata,
                        manualReviewRequired: false,
                        manualReview: {
                            status: "approved",
                            reviewedAt: new Date(),
                            reviewedBy: "admin",
                            reason: reason || "Approved by admin",
                        },
                    },
                },
            });
            await (0, botService_1.notifyDepositCredited)(String(tx.userId), quote.creditedUsdt, updatedUser.balance).catch((notifyErr) => {
                console.warn("Failed to notify approved deposit review", {
                    userId: String(tx.userId),
                    txId: tx.id,
                    error: notifyErr?.message || String(notifyErr),
                });
            });
            return (0, apiResponse_1.ok)(res, {
                id: tx.id,
                status: "completed",
                action,
                creditedUsdt: quote.creditedUsdt,
                newBalance: updatedUser.balance,
                feeEtb: quote.feeEtb,
                rate: quote.rate,
            });
        }
        catch (err) {
            const message = err?.errors?.[0]?.message || err?.message || "Failed to process decision";
            return (0, apiResponse_1.fail)(res, message, 400);
        }
    }
    const session = await mongoose_1.default.startSession();
    session.startTransaction();
    try {
        const id = String(req.params.id || "").trim();
        if (!id) {
            await session.abortTransaction();
            session.endSession();
            return (0, apiResponse_1.fail)(res, "Transaction id is required", 400);
        }
        const { action, reason } = TransactionDecisionSchema.parse(req.body || {});
        const txQuery = [{ transactionNumber: id }, { referenceNumber: id }];
        if (mongoose_1.default.Types.ObjectId.isValid(id)) {
            txQuery.unshift({ _id: id });
        }
        const tx = await Transaction_1.default.findOne({ $or: txQuery }).session(session);
        if (!tx) {
            await session.abortTransaction();
            session.endSession();
            return (0, apiResponse_1.fail)(res, "Transaction not found", 404);
        }
        if (tx.transactionType !== "deposit") {
            await session.abortTransaction();
            session.endSession();
            return (0, apiResponse_1.fail)(res, "Only deposit transactions can be reviewed manually", 400);
        }
        if (tx.status === "completed") {
            await session.commitTransaction();
            session.endSession();
            return (0, apiResponse_1.ok)(res, {
                id: String(tx._id),
                status: tx.status,
                message: "Transaction already completed",
            });
        }
        if (tx.status !== "pending") {
            await session.abortTransaction();
            session.endSession();
            return (0, apiResponse_1.fail)(res, `Only pending transactions can be reviewed (current: ${tx.status})`, 400);
        }
        if (action === "decline") {
            tx.status = "failed";
            tx.verified = false;
            tx.metadata = {
                ...(tx.metadata || {}),
                manualReviewRequired: false,
                manualReview: {
                    status: "declined",
                    reviewedAt: new Date(),
                    reviewedBy: "admin",
                    reason: reason || "Declined by admin",
                },
            };
            await tx.save({ session });
            await session.commitTransaction();
            session.endSession();
            await (0, botService_1.notifyDepositReviewDeclined)(String(tx.userId), reason).catch((notifyErr) => {
                console.warn("Failed to notify declined deposit review", {
                    userId: String(tx.userId),
                    txId: String(tx._id),
                    error: notifyErr?.message || String(notifyErr),
                });
            });
            return (0, apiResponse_1.ok)(res, {
                id: String(tx._id),
                status: tx.status,
                action,
            });
        }
        const isCardRequestManual = tx.metadata?.kind === "card_request_manual";
        if (isCardRequestManual) {
            const userId = String(tx.userId);
            const userRecord = await User_1.default.findOne({ userId }).lean();
            const customer = await Customer_1.default.findOne({ userId }).lean();
            if (!userRecord) {
                await session.abortTransaction();
                session.endSession();
                return (0, apiResponse_1.fail)(res, "User not found", 404);
            }
            const cardAmountUsdRaw = tx.metadata?.cardAmountUsd;
            const cardAmountUsd = Number(cardAmountUsdRaw);
            const amount = Number.isFinite(cardAmountUsd) && cardAmountUsd >= 3 ? cardAmountUsd : 3;
            const nameOnCard = [userRecord.firstName, userRecord.lastName].filter(Boolean).join(" ") || "StroWallet User";
            const customerEmail = customer?.email || userRecord.customerEmail;
            if (!customerEmail) {
                await session.abortTransaction();
                session.endSession();
                return (0, apiResponse_1.fail)(res, "User email is missing for card request", 400);
            }
            let createResp;
            try {
                createResp = await createCardRequestViaBackend({
                    userId,
                    nameOnCard,
                    cardType: "nfc",
                    amount: String(amount),
                    customerEmail,
                    metadata: {
                        source: "admin_manual_review",
                        transactionId: String(tx._id),
                    },
                });
            }
            catch (createErr) {
                await session.abortTransaction();
                session.endSession();
                const msg = describeHttpError(createErr, "Failed to create card request");
                return (0, apiResponse_1.fail)(res, msg, 400);
            }
            const cardId = createResp?.data?.data?.cardId;
            tx.status = "completed";
            tx.verified = true;
            tx.metadata = {
                ...(tx.metadata || {}),
                manualReviewRequired: false,
                manualReview: {
                    status: "approved",
                    reviewedAt: new Date(),
                    reviewedBy: "admin",
                    reason: reason || "Approved by admin",
                },
                cardRequest: {
                    approvedAt: new Date(),
                    cardId: cardId || null,
                },
            };
            await tx.save({ session });
            await session.commitTransaction();
            session.endSession();
            return (0, apiResponse_1.ok)(res, {
                id: String(tx._id),
                status: tx.status,
                action,
                cardId: cardId || null,
            });
        }
        const amountEtbRaw = tx.amountEtb ?? tx.metadata?.expectedAmountEtb ?? tx.amount;
        const amountEtb = Number(amountEtbRaw);
        if (!Number.isFinite(amountEtb) || amountEtb <= 0) {
            await session.abortTransaction();
            session.endSession();
            return (0, apiResponse_1.fail)(res, "Cannot approve transaction without a valid ETB amount", 400);
        }
        const pricing = await (0, pricingService_1.loadPricingConfig)();
        const quote = (0, pricingService_1.quoteDeposit)(amountEtb, pricing);
        if (quote.creditedUsdt <= 0) {
            await session.abortTransaction();
            session.endSession();
            return (0, apiResponse_1.fail)(res, "Deposit amount is too low after fees", 400);
        }
        const user = await User_1.default.findOneAndUpdate({ userId: String(tx.userId) }, { $inc: { balance: quote.creditedUsdt } }, { new: true, session });
        if (!user) {
            await session.abortTransaction();
            session.endSession();
            return (0, apiResponse_1.fail)(res, "User not found", 404);
        }
        tx.status = "completed";
        tx.verified = true;
        tx.amountEtb = amountEtb;
        tx.amountUsdt = quote.creditedUsdt;
        tx.amount = quote.creditedUsdt;
        tx.currency = "USDT";
        tx.feeEtb = quote.feeEtb;
        tx.rateSnapshot = quote.rate;
        tx.metadata = {
            ...(tx.metadata || {}),
            manualReviewRequired: false,
            manualReview: {
                status: "approved",
                reviewedAt: new Date(),
                reviewedBy: "admin",
                reason: reason || "Approved by admin",
            },
        };
        await tx.save({ session });
        await session.commitTransaction();
        session.endSession();
        await (0, botService_1.notifyDepositCredited)(String(tx.userId), quote.creditedUsdt, user.balance).catch((notifyErr) => {
            console.warn("Failed to notify approved deposit review", {
                userId: String(tx.userId),
                txId: String(tx._id),
                error: notifyErr?.message || String(notifyErr),
            });
        });
        return (0, apiResponse_1.ok)(res, {
            id: String(tx._id),
            status: tx.status,
            action,
            creditedUsdt: quote.creditedUsdt,
            newBalance: user.balance,
            feeEtb: quote.feeEtb,
            rate: quote.rate,
        });
    }
    catch (err) {
        try {
            await session.abortTransaction();
        }
        catch { }
        session.endSession();
        const message = err?.errors?.[0]?.message || err?.message || "Failed to process decision";
        return (0, apiResponse_1.fail)(res, message, 400);
    }
});
// Admin: reset all existing users to start fresh (zero balances, unlink cards, archive transactions)
router.post("/reset-users", requireAdmin, async (req, res) => {
    try {
        const body = ResetUsersSchema.parse(req.body || {});
        if (body.scope === "single" && !body.userId) {
            return (0, apiResponse_1.fail)(res, "userId is required for single-user reset", 400);
        }
        if ((0, persistence_1.isPrismaPersistenceEnabled)()) {
            const removeTransactions = Boolean(body.removeTransactions);
            if (body.scope === "single") {
                const userId = String(body.userId);
                const [userRes, cardsRes, requestsRes, transactionsCancelledRes] = await Promise.all([
                    prisma_1.default.user.updateMany({ where: { userId }, data: { balance: 0, currency: "USDT" } }),
                    prisma_1.default.card.updateMany({ where: { userId }, data: { userId: null } }),
                    prisma_1.default.cardRequest.updateMany({
                        where: { userId, NOT: { status: "declined" } },
                        data: { status: "declined", decisionReason: "Reset by admin" },
                    }),
                    prisma_1.default.transaction.updateMany({
                        where: { userId, NOT: { status: "cancelled" } },
                        data: {
                            status: "cancelled",
                            metadata: {
                                archivedBy: "admin_reset",
                                archivedAt: new Date(),
                                reason: body.reason || undefined,
                            },
                        },
                    }),
                ]);
                const transactionsDeletedRes = removeTransactions
                    ? await prisma_1.default.transaction.deleteMany({ where: { userId } })
                    : { count: 0 };
                return (0, apiResponse_1.ok)(res, {
                    message: "User reset completed",
                    scope: body.scope,
                    userId,
                    usersZeroed: userRes.count,
                    linksCleared: 0,
                    cardsUnlinked: cardsRes.count,
                    requestsDeclined: requestsRes.count,
                    transactionsArchived: transactionsCancelledRes.count,
                    transactionsDeleted: transactionsDeletedRes.count,
                });
            }
            const [usersRes, cardsRes, requestsRes, transactionsCancelledRes] = await Promise.all([
                prisma_1.default.user.updateMany({ data: { balance: 0, currency: "USDT" } }),
                prisma_1.default.card.updateMany({ data: { userId: null } }),
                prisma_1.default.cardRequest.updateMany({
                    where: { NOT: { status: "declined" } },
                    data: { status: "declined", decisionReason: "Reset by admin" },
                }),
                prisma_1.default.transaction.updateMany({
                    where: { NOT: { status: "cancelled" } },
                    data: {
                        status: "cancelled",
                        metadata: {
                            archivedBy: "admin_reset",
                            archivedAt: new Date(),
                            reason: body.reason || undefined,
                        },
                    },
                }),
            ]);
            const transactionsDeletedRes = removeTransactions
                ? await prisma_1.default.transaction.deleteMany({})
                : { count: 0 };
            return (0, apiResponse_1.ok)(res, {
                message: "All users reset completed",
                scope: body.scope,
                userId: null,
                usersZeroed: usersRes.count,
                linksCleared: 0,
                cardsUnlinked: cardsRes.count,
                requestsDeclined: requestsRes.count,
                transactionsArchived: transactionsCancelledRes.count,
                transactionsDeleted: transactionsDeletedRes.count,
            });
        }
        const removeTransactions = Boolean(body.removeTransactions);
        const now = new Date();
        const baseTxMetadata = {
            archivedBy: "admin_reset",
            archivedAt: now,
            reason: body.reason || undefined,
        };
        let usersResult = { modifiedCount: 0 };
        let linksResult = { modifiedCount: 0 };
        let cardsResult = { modifiedCount: 0 };
        let requestsResult = { modifiedCount: 0 };
        let transactionsArchived = { modifiedCount: 0 };
        let transactionsDeleted = { deletedCount: 0 };
        if (body.scope === "single") {
            const userId = String(body.userId);
            usersResult = await User_1.default.updateOne({ userId }, { $set: { balance: 0, currency: "USDT" } });
            linksResult = await TelegramLink_1.TelegramLink.updateOne({ chatId: Number(userId) }, { $set: { cardIds: [] } });
            cardsResult = await Card_1.default.updateMany({ userId }, { $unset: { userId: "" } });
            requestsResult = await CardRequest_1.default.updateMany({ userId, status: { $ne: "declined" } }, { $set: { status: "declined", decisionReason: "Reset by admin", updatedAt: now } });
            transactionsArchived = await Transaction_1.default.updateMany({ userId, status: { $ne: "cancelled" } }, { $set: { status: "cancelled", metadata: baseTxMetadata } });
            if (removeTransactions) {
                transactionsDeleted = await Transaction_1.default.deleteMany({ userId });
            }
        }
        else {
            usersResult = await User_1.default.updateMany({}, { $set: { balance: 0, currency: "USDT" } });
            linksResult = await TelegramLink_1.TelegramLink.updateMany({}, { $set: { cardIds: [] } });
            cardsResult = await Card_1.default.updateMany({}, { $unset: { userId: "" } });
            requestsResult = await CardRequest_1.default.updateMany({ status: { $ne: "declined" } }, { $set: { status: "declined", decisionReason: "Reset by admin", updatedAt: now } });
            transactionsArchived = await Transaction_1.default.updateMany({ status: { $ne: "cancelled" } }, { $set: { status: "cancelled", metadata: baseTxMetadata } });
            if (removeTransactions) {
                transactionsDeleted = await Transaction_1.default.deleteMany({});
            }
        }
        await RuntimeAudit_1.default.create({
            key: "reset_users",
            oldValue: null,
            newValue: {
                scope: body.scope,
                userId: body.userId || null,
                removeTransactions,
                usersZeroed: usersResult.modifiedCount || 0,
                linksCleared: linksResult.modifiedCount || 0,
                cardsUnlinked: cardsResult.modifiedCount || 0,
                requestsDeclined: requestsResult.modifiedCount || 0,
                transactionsArchived: transactionsArchived.modifiedCount || 0,
                transactionsDeleted: transactionsDeleted.deletedCount || 0,
            },
            changedBy: "admin",
            reason: body.reason || "Reset requested from admin dashboard",
            createdAt: now,
        });
        return (0, apiResponse_1.ok)(res, {
            message: body.scope === "single" ? "User reset completed" : "All users reset completed",
            scope: body.scope,
            userId: body.userId || null,
            usersZeroed: usersResult.modifiedCount || 0,
            linksCleared: linksResult.modifiedCount || 0,
            cardsUnlinked: cardsResult.modifiedCount || 0,
            requestsDeclined: requestsResult.modifiedCount || 0,
            transactionsArchived: transactionsArchived.modifiedCount || 0,
            transactionsDeleted: transactionsDeleted.deletedCount || 0,
        });
    }
    catch (err) {
        const message = err?.errors?.[0]?.message || err?.message || "Failed to reset users";
        return (0, apiResponse_1.fail)(res, message, 400);
    }
});
exports.default = router;
