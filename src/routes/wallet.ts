import express from "express";
import { z } from "zod";
import User from "../models/User";
import Card from "../models/Card";
import CardRequest from "../models/CardRequest";
import { enforceTopupLimits, loadPricingConfig, quoteDeposit, quoteTopup, upsertPricingConfig } from "../services/pricingService";
import { topUpCard } from "../services/topupService";
import { TelegramLink } from "../models/TelegramLink";
import Transaction from "../models/Transaction";
import RuntimeAudit from "../models/RuntimeAudit";
import { ok, fail } from "../utils/apiResponse";

const router = express.Router();

const AmountEtbSchema = z.object({ amountEtb: z.number().positive() });
const AmountUsdtSchema = z.object({ amountUsdt: z.number().positive() });
const BalanceParamSchema = z.object({ userId: z.string().min(1) });

const PricingSchema = z.object({
  usdtRate: z.number().positive(),
  depositPercentFee: z.number().min(0),
  depositFlatFee: z.number().min(0),
  topupPercentFee: z.number().min(0),
  topupFlatFee: z.number().min(0),
  topupMin: z.number().min(0).optional(),
  topupMax: z.number().min(0).optional(),
  cardRequestFeeEtb: z.number().min(0).optional(),
  updatedBy: z.string().optional(),
});

const TopupSchema = z.object({
  userId: z.string().min(1),
  cardId: z.string().min(1),
  amountUsdt: z.number().positive(),
  mode: z.string().optional(),
});

const ResetUsersSchema = z.object({
  scope: z.enum(["single", "all"]).default("all"),
  userId: z.string().optional(),
  removeTransactions: z.boolean().optional(),
  reason: z.string().optional(),
});

function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction) {
  const adminToken = process.env.ADMIN_API_TOKEN;
  if (!adminToken) return next();
  const provided = req.headers["x-admin-token"] as string | undefined;
  if (provided && provided === adminToken) return next();
  return fail(res, "Unauthorized", 401);
}


// Admin: list runtime audits
router.get("/audit", requireAdmin, async (_req, res) => {
  try {
    const items = await RuntimeAudit.find().sort({ createdAt: -1 }).limit(200).lean();
    return ok(res, { items });
  } catch (e: any) {
    return fail(res, e?.message || "Failed to load audits", 500);
  }
});

router.get("/config", requireAdmin, async (_req, res) => {
  const config = await loadPricingConfig();
  return ok(res, { config });
});

router.put("/config", requireAdmin, async (req, res) => {
  try {
    const body = PricingSchema.parse(req.body || {});
    const updated = await upsertPricingConfig(body as any);
    return ok(res, { config: updated });
  } catch (err: any) {
    const message = err?.errors?.[0]?.message || err?.message || "Invalid payload";
    return fail(res, message, 400);
  }
});

router.get("/balance/:userId", async (req, res) => {
  try {
    const params = BalanceParamSchema.parse(req.params);
    const user = await User.findOne({ userId: params.userId }).lean();
    return ok(res, { balance: user?.balance ?? 0, currency: user?.currency ?? "USDT" });
  } catch (err: any) {
    const message = err?.errors?.[0]?.message || err?.message || "Invalid request";
    return fail(res, message, 400);
  }
});

router.post("/deposit/quote", async (req, res) => {
  try {
    const body = AmountEtbSchema.parse(req.body || {});
    const config = await loadPricingConfig();
    const quote = quoteDeposit(body.amountEtb, config);
    return ok(res, { quote });
  } catch (err: any) {
    const message = err?.errors?.[0]?.message || err?.message || "Invalid request";
    return fail(res, message, 400);
  }
});

router.post("/topup/quote", async (req, res) => {
  try {
    const body = AmountUsdtSchema.parse(req.body || {});
    const config = await loadPricingConfig();
    enforceTopupLimits(body.amountUsdt, config);
    const quote = quoteTopup(body.amountUsdt, config);
    return ok(res, { quote });
  } catch (err: any) {
    const status = err?.status || 400;
    const message = err?.errors?.[0]?.message || err?.message || "Invalid request";
    return fail(res, message, status);
  }
});

router.post("/topup", async (req, res) => {
  try {
    const body = TopupSchema.parse(req.body || {});
    const result = await topUpCard(body);
    const status = result.success ? 200 : result.status || 400;
    if (result.success) return ok(res, result, status);
    return fail(res, result.message || "Top-up failed", status);
  } catch (err: any) {
    const status = err?.status || 400;
    const message = err?.errors?.[0]?.message || err?.message || "Invalid request";
    return fail(res, message, status);
  }
});

// Manual admin deposit: directly credit user balance and record transaction
router.post("/deposit/manual", requireAdmin, async (req, res) => {
  return fail(res, "Manual deposits are disabled. StroWallet is the source of truth.", 405);
});

// Recent transactions (admin): helps admins find userIds and recent activity
router.get("/transactions/recent", requireAdmin, async (req, res) => {
  try {
    const limitRaw = Number(req.query.limit ?? 20);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 && limitRaw <= 200 ? limitRaw : 20;
    const items = await Transaction.find({ transactionType: "deposit" })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    const userIds = Array.from(new Set(items.map((i) => i.userId).filter(Boolean)));
    const chatIds = userIds
      .map((u) => Number(u))
      .filter((n) => Number.isFinite(n));

    const links = chatIds.length
      ? await TelegramLink.find({ chatId: { $in: chatIds } })
          .select({ chatId: 1, cardIds: 1 })
          .lean()
      : [];
    const linkMap = new Map(links.map((l) => [String(l.chatId), l.cardIds?.[0] || null]));

    const decorated = items.map((i) => ({ ...i, cardId: linkMap.get(String(i.userId)) || null }));

    return ok(res, { items: decorated });
  } catch (err: any) {
    const message = err?.message || "Failed to load transactions";
    return fail(res, message, 400);
  }
});

router.post("/transactions/:id/decision", requireAdmin, async (req, res) => {
  return fail(res, "Manual approval/decline is disabled. StroWallet is the source of truth.", 405);
});

// Admin: reset all existing users to start fresh (zero balances, unlink cards, archive transactions)
router.post("/reset-users", requireAdmin, async (req, res) => {
  try {
    const body = ResetUsersSchema.parse(req.body || {});
    if (body.scope === "single" && !body.userId) {
      return fail(res, "userId is required for single-user reset", 400);
    }

    const removeTransactions = Boolean(body.removeTransactions);
    const now = new Date();
    const baseTxMetadata = {
      archivedBy: "admin_reset",
      archivedAt: now,
      reason: body.reason || undefined,
    };

    let usersResult: any = { modifiedCount: 0 };
    let linksResult: any = { modifiedCount: 0 };
    let cardsResult: any = { modifiedCount: 0 };
    let requestsResult: any = { modifiedCount: 0 };
    let transactionsArchived: any = { modifiedCount: 0 };
    let transactionsDeleted: any = { deletedCount: 0 };

    if (body.scope === "single") {
      const userId = String(body.userId);
      usersResult = await User.updateOne(
        { userId },
        { $set: { balance: 0, currency: "USDT" } }
      );

      linksResult = await TelegramLink.updateOne(
        { chatId: Number(userId) },
        { $set: { cardIds: [] } }
      );

      cardsResult = await Card.updateMany(
        { userId },
        { $unset: { userId: "" } }
      );

      requestsResult = await CardRequest.updateMany(
        { userId, status: { $ne: "declined" } },
        { $set: { status: "declined", decisionReason: "Reset by admin", updatedAt: now } }
      );

      transactionsArchived = await Transaction.updateMany(
        { userId, status: { $ne: "cancelled" } },
        { $set: { status: "cancelled", metadata: baseTxMetadata } }
      );

      if (removeTransactions) {
        transactionsDeleted = await Transaction.deleteMany({ userId });
      }
    } else {
      usersResult = await User.updateMany(
        {},
        { $set: { balance: 0, currency: "USDT" } }
      );

      linksResult = await TelegramLink.updateMany({}, { $set: { cardIds: [] } });

      cardsResult = await Card.updateMany(
        {},
        { $unset: { userId: "" } }
      );

      requestsResult = await CardRequest.updateMany(
        { status: { $ne: "declined" } },
        { $set: { status: "declined", decisionReason: "Reset by admin", updatedAt: now } }
      );

      transactionsArchived = await Transaction.updateMany(
        { status: { $ne: "cancelled" } },
        { $set: { status: "cancelled", metadata: baseTxMetadata } }
      );

      if (removeTransactions) {
        transactionsDeleted = await Transaction.deleteMany({});
      }
    }

    await RuntimeAudit.create({
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

    return ok(res, {
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
  } catch (err: any) {
    const message = err?.errors?.[0]?.message || err?.message || "Failed to reset users";
    return fail(res, message, 400);
  }
});

export default router;
