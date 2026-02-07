"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isFakeTopupRuntime = isFakeTopupRuntime;
const express_1 = __importDefault(require("express"));
const zod_1 = require("zod");
const mongoose_1 = __importDefault(require("mongoose"));
const User_1 = __importDefault(require("../models/User"));
const pricingService_1 = require("../services/pricingService");
const topupService_1 = require("../services/topupService");
const botService_1 = require("../services/botService");
const TelegramLink_1 = require("../models/TelegramLink");
const Transaction_1 = __importDefault(require("../models/Transaction"));
const RuntimeConfig_1 = __importDefault(require("../models/RuntimeConfig"));
const RuntimeAudit_1 = __importDefault(require("../models/RuntimeAudit"));
const router = express_1.default.Router();
const AmountEtbSchema = zod_1.z.object({ amountEtb: zod_1.z.number().positive() });
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
    updatedBy: zod_1.z.string().optional(),
});
const TopupSchema = zod_1.z.object({
    userId: zod_1.z.string().min(1),
    cardId: zod_1.z.string().min(1),
    amountUsdt: zod_1.z.number().positive(),
    mode: zod_1.z.string().optional(),
});
const ManualDepositSchema = zod_1.z.object({
    userId: zod_1.z.string().min(1),
    amountUsdt: zod_1.z.number().positive(),
    note: zod_1.z.string().optional(),
});
const DecisionSchema = zod_1.z.object({
    action: zod_1.z.enum(["approve", "decline"]),
});
function requireAdmin(req, res, next) {
    const adminToken = process.env.ADMIN_API_TOKEN;
    if (!adminToken)
        return next();
    const provided = req.headers["x-admin-token"];
    if (provided && provided === adminToken)
        return next();
    return res.status(401).json({ success: false, message: "Unauthorized" });
}
// --- Runtime Config endpoints for FAKE_TOPUP (admin only) ---
router.get("/fake-topup", requireAdmin, async (_req, res) => {
    try {
        const doc = (await RuntimeConfig_1.default.findOne({ key: "FAKE_TOPUP" }).lean());
        const value = doc ? !!doc.value : (process.env.FAKE_TOPUP === "true");
        res.json({ success: true, value });
    }
    catch (err) {
        res.status(500).json({ success: false, message: err?.message || "Failed to read config" });
    }
});
router.put("/fake-topup", requireAdmin, async (req, res) => {
    try {
        let body = req.body || {};
        // Some clients (PowerShell variants) may send the JSON as a raw string
        if (typeof body === "string") {
            try {
                body = JSON.parse(body);
            }
            catch (_) {
                // leave as-is; validation below will catch non-boolean
            }
        }
        let value = body.value;
        if (typeof value === "string") {
            const v = value.toLowerCase().trim();
            if (v === "true" || v === "1")
                value = true;
            else if (v === "false" || v === "0")
                value = false;
        }
        else if (typeof value === "number") {
            value = value === 1 ? true : value === 0 ? false : value;
        }
        if (typeof value !== "boolean") {
            console.warn("/fake-topup: invalid value", { rawBody: req.body, body, typeofValue: typeof body.value, parsedValue: value });
            return res.status(400).json({ success: false, message: "Value must be boolean", received: { rawBody: req.body, body, typeofValue: typeof body.value, parsedValue: value } });
        }
        const before = (await RuntimeConfig_1.default.findOne({ key: "FAKE_TOPUP" }).lean());
        const doc = (await RuntimeConfig_1.default.findOneAndUpdate({ key: "FAKE_TOPUP" }, { value }, { upsert: true, new: true }).lean());
        // record audit
        try {
            await RuntimeAudit_1.default.create({ key: "FAKE_TOPUP", oldValue: before?.value, newValue: !!doc.value, changedBy: req.headers["x-admin-token"] });
        }
        catch (e) {
            console.warn("Failed to write runtime audit", e);
        }
        res.json({ success: true, value: !!doc.value });
    }
    catch (err) {
        res.status(500).json({ success: false, message: err?.message || "Failed to update config" });
    }
});
// Admin: list runtime audits
router.get("/audit", requireAdmin, async (_req, res) => {
    try {
        const items = await RuntimeAudit_1.default.find().sort({ createdAt: -1 }).limit(200).lean();
        res.json({ success: true, items });
    }
    catch (e) {
        res.status(500).json({ success: false, message: e?.message || 'Failed to load audits' });
    }
});
// Helper to resolve FAKE_TOPUP at runtime
async function isFakeTopupRuntime() {
    const doc = (await RuntimeConfig_1.default.findOne({ key: "FAKE_TOPUP" }).lean());
    if (doc)
        return !!doc.value;
    return process.env.FAKE_TOPUP === "true";
}
router.get("/config", requireAdmin, async (_req, res) => {
    const config = await (0, pricingService_1.loadPricingConfig)();
    res.json({ success: true, config });
});
router.put("/config", requireAdmin, async (req, res) => {
    try {
        const body = PricingSchema.parse(req.body || {});
        const updated = await (0, pricingService_1.upsertPricingConfig)(body);
        res.json({ success: true, config: updated });
    }
    catch (err) {
        const message = err?.errors?.[0]?.message || err?.message || "Invalid payload";
        res.status(400).json({ success: false, message });
    }
});
router.get("/balance/:userId", async (req, res) => {
    try {
        const params = BalanceParamSchema.parse(req.params);
        const user = await User_1.default.findOne({ userId: params.userId }).lean();
        res.json({ success: true, balance: user?.balance ?? 0, currency: user?.currency ?? "USDT" });
    }
    catch (err) {
        const message = err?.errors?.[0]?.message || err?.message || "Invalid request";
        res.status(400).json({ success: false, message });
    }
});
router.post("/deposit/quote", async (req, res) => {
    try {
        const body = AmountEtbSchema.parse(req.body || {});
        const config = await (0, pricingService_1.loadPricingConfig)();
        const quote = (0, pricingService_1.quoteDeposit)(body.amountEtb, config);
        res.json({ success: true, quote });
    }
    catch (err) {
        const message = err?.errors?.[0]?.message || err?.message || "Invalid request";
        res.status(400).json({ success: false, message });
    }
});
router.post("/topup/quote", async (req, res) => {
    try {
        const body = AmountUsdtSchema.parse(req.body || {});
        const config = await (0, pricingService_1.loadPricingConfig)();
        (0, pricingService_1.enforceTopupLimits)(body.amountUsdt, config);
        const quote = (0, pricingService_1.quoteTopup)(body.amountUsdt, config);
        res.json({ success: true, quote });
    }
    catch (err) {
        const status = err?.status || 400;
        const message = err?.errors?.[0]?.message || err?.message || "Invalid request";
        res.status(status).json({ success: false, message });
    }
});
router.post("/topup", async (req, res) => {
    try {
        const body = TopupSchema.parse(req.body || {});
        const result = await (0, topupService_1.topUpCard)(body);
        const status = result.success ? 200 : result.status || 400;
        res.status(status).json(result);
    }
    catch (err) {
        const status = err?.status || 400;
        const message = err?.errors?.[0]?.message || err?.message || "Invalid request";
        res.status(status).json({ success: false, message });
    }
});
// Manual admin deposit: directly credit user balance and record transaction
router.post("/deposit/manual", requireAdmin, async (req, res) => {
    const session = await mongoose_1.default.startSession();
    session.startTransaction();
    try {
        const body = ManualDepositSchema.parse(req.body || {});
        const txnNumber = `MANUAL-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const user = await User_1.default.findOneAndUpdate({ userId: body.userId }, { $inc: { balance: body.amountUsdt }, $setOnInsert: { currency: "USDT" } }, { new: true, upsert: true, session });
        const tx = await Transaction_1.default.create([
            {
                userId: body.userId,
                transactionType: "manual_deposit",
                paymentMethod: "system",
                amount: body.amountUsdt,
                amountUsdt: body.amountUsdt,
                currency: "USDT",
                status: "completed",
                transactionNumber: txnNumber,
                referenceNumber: txnNumber,
                metadata: { note: body.note },
            },
        ], { session });
        await session.commitTransaction();
        session.endSession();
        (0, botService_1.notifyDepositCredited)(body.userId, body.amountUsdt, user.balance).catch(() => { });
        res.json({ success: true, transactionId: tx[0]._id, newBalance: user.balance });
    }
    catch (err) {
        try {
            await session.abortTransaction();
        }
        catch { }
        session.endSession();
        const status = err?.status || 400;
        const message = err?.errors?.[0]?.message || err?.message || "Deposit failed";
        res.status(status).json({ success: false, message });
    }
});
// Recent transactions (admin): helps admins find userIds and recent activity
router.get("/transactions/recent", requireAdmin, async (req, res) => {
    try {
        const limitRaw = Number(req.query.limit ?? 20);
        const limit = Number.isFinite(limitRaw) && limitRaw > 0 && limitRaw <= 200 ? limitRaw : 20;
        const items = await Transaction_1.default.find({ transactionType: "deposit", status: { $in: ["pending", "waiting"] } })
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
        res.json({ success: true, items: decorated });
    }
    catch (err) {
        const message = err?.message || "Failed to load transactions";
        res.status(400).json({ success: false, message });
    }
});
router.post("/transactions/:id/decision", requireAdmin, async (req, res) => {
    try {
        const body = DecisionSchema.parse(req.body || {});
        const id = req.params.id;
        const status = body.action === "approve" ? "completed" : "failed";
        const tx = await Transaction_1.default.findOneAndUpdate({
            transactionType: "deposit",
            status: { $in: ["pending", "waiting"] },
            $or: [{ _id: id }, { transactionNumber: id }],
        }, { $set: { status, metadata: { ...(req.body?.metadata || {}), decidedAt: new Date(), decidedBy: "admin" } } }, { new: true }).lean();
        if (!tx) {
            return res.status(404).json({ success: false, message: "Deposit request not found or already handled" });
        }
        res.json({ success: true, item: tx });
    }
    catch (err) {
        const status = err?.status || 400;
        const message = err?.errors?.[0]?.message || err?.message || "Failed to update transaction";
        res.status(status).json({ success: false, message });
    }
});
// Admin: reset all existing users to start fresh (zero balances, unlink cards, archive transactions)
router.post("/reset-users", requireAdmin, async (req, res) => {
    const session = await mongoose_1.default.startSession();
    session.startTransaction();
    try {
        const body = (req.body || {});
        const removeTransactions = !!body.removeTransactions;
        // Zero all user balances
        const usersResult = await User_1.default.updateMany({}, { $set: { balance: 0, currency: "USDT" } }, { session });
        // Unlink cardIds for all TelegramLink records
        const linksResult = await TelegramLink_1.TelegramLink.updateMany({}, { $set: { cardIds: [] } }, { session });
        // Archive transactions by marking them cancelled and adding metadata
        const archiveUpdate = { $set: { status: "cancelled" }, $setOnInsert: {} };
        const now = new Date();
        // Add metadata flag for auditing
        const txs = await Transaction_1.default.updateMany({ status: { $ne: "cancelled" } }, { $set: { status: "cancelled", metadata: { ...(req.body?.metadata || {}), archivedBy: "admin_reset", archivedAt: now } } }, { session });
        if (removeTransactions) {
            // optionally remove transactions entirely (destructive)
            await Transaction_1.default.deleteMany({}, { session });
        }
        // Record runtime audit entry
        const getModifiedCount = (result) => {
            if (!result)
                return null;
            if (typeof result.modifiedCount === "number")
                return result.modifiedCount;
            return result.nModified ?? null;
        };
        try {
            await RuntimeAudit_1.default.create([
                {
                    key: "reset_users",
                    oldValue: null,
                    newValue: {
                        usersZeroed: getModifiedCount(usersResult),
                        linksCleared: getModifiedCount(linksResult),
                        transactionsArchived: getModifiedCount(txs),
                        removedTransactions: removeTransactions,
                    },
                    changedBy: req.headers["x-admin-token"],
                    reason: "Admin requested reset of all user accounts to migrate to new system",
                },
            ], { session });
        }
        catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            console.warn("Failed to write runtime audit for reset-users", message);
        }
        await session.commitTransaction();
        session.endSession();
        res.json({
            success: true,
            message: "All users reset. Existing balances cleared and links unlinked.",
            usersZeroed: getModifiedCount(usersResult),
            linksCleared: getModifiedCount(linksResult),
            transactionsArchived: getModifiedCount(txs),
            removedTransactions: removeTransactions,
        });
    }
    catch (err) {
        try {
            await session.abortTransaction();
        }
        catch { }
        session.endSession();
        const status = err?.status || 500;
        const message = err?.message || "Failed to reset users";
        res.status(status).json({ success: false, message });
    }
});
exports.default = router;
