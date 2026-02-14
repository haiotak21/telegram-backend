"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const zod_1 = require("zod");
const User_1 = __importDefault(require("../models/User"));
const pricingService_1 = require("../services/pricingService");
const topupService_1 = require("../services/topupService");
const TelegramLink_1 = require("../models/TelegramLink");
const Transaction_1 = __importDefault(require("../models/Transaction"));
const RuntimeAudit_1 = __importDefault(require("../models/RuntimeAudit"));
const apiResponse_1 = require("../utils/apiResponse");
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
function requireAdmin(req, res, next) {
    const adminToken = process.env.ADMIN_API_TOKEN;
    if (!adminToken)
        return next();
    const provided = req.headers["x-admin-token"];
    if (provided && provided === adminToken)
        return next();
    return (0, apiResponse_1.fail)(res, "Unauthorized", 401);
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
        const user = await User_1.default.findOne({ userId: params.userId }).lean();
        return (0, apiResponse_1.ok)(res, { balance: user?.balance ?? 0, currency: user?.currency ?? "USDT" });
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
        return (0, apiResponse_1.ok)(res, { items: decorated });
    }
    catch (err) {
        const message = err?.message || "Failed to load transactions";
        return (0, apiResponse_1.fail)(res, message, 400);
    }
});
router.post("/transactions/:id/decision", requireAdmin, async (req, res) => {
    return (0, apiResponse_1.fail)(res, "Manual approval/decline is disabled. StroWallet is the source of truth.", 405);
});
// Admin: reset all existing users to start fresh (zero balances, unlink cards, archive transactions)
router.post("/reset-users", requireAdmin, async (req, res) => {
    return (0, apiResponse_1.fail)(res, "Admin reset is disabled. StroWallet is the source of truth.", 405);
});
exports.default = router;
