import express from "express";
import axios from "axios";
import mongoose from "mongoose";
import { z } from "zod";
import User from "../models/User";
import Card from "../models/Card";
import CardRequest from "../models/CardRequest";
import Customer from "../models/Customer";
import { enforceTopupLimits, loadPricingConfig, quoteDeposit, quoteTopup, upsertPricingConfig } from "../services/pricingService";
import { topUpCard } from "../services/topupService";
import { TelegramLink } from "../models/TelegramLink";
import Transaction from "../models/Transaction";
import RuntimeAudit from "../models/RuntimeAudit";
import { notifyDepositCredited, notifyDepositReviewDeclined } from "../services/botService";
import { ok, fail } from "../utils/apiResponse";
import prisma from "../utils/prisma";
import { isPrismaPersistenceEnabled } from "../utils/persistence";

const router = express.Router();

const AmountEtbSchema = z.object({ amountEtb: z.number().positive("amountEtb must be greater than 0") });
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
  firstCardAmountUsd: z.number().min(0).optional(),
  firstCardFeeUsd: z.number().min(0).optional(),
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

const TransactionDecisionSchema = z.object({
  action: z.enum(["approve", "decline"]),
  reason: z.string().max(500).optional(),
});

function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction) {
  const adminToken = process.env.ADMIN_API_TOKEN;
  if (!adminToken) return next();
  const provided = req.headers["x-admin-token"] as string | undefined;
  if (provided && provided === adminToken) return next();
  return fail(res, "Unauthorized", 401);
}

function getBackendBaseCandidates() {
  const port = process.env.PORT || 3000;
  const configured = (process.env.BOT_BACKEND_BASE || "").trim();
  const defaults = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
  const all = [...defaults, configured].filter(Boolean).map((v) => String(v).replace(/\/$/, ""));
  return Array.from(new Set(all));
}

function isRetryableBackendError(err: any) {
  const code = String(err?.code || "").toUpperCase();
  if (["ENOTFOUND", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ECONNRESET"].includes(code)) return true;
  const message = String(err?.message || "").toLowerCase();
  if (message.includes("getaddrinfo enotfound") || message.includes("enotfound")) return true;
  const status = Number(err?.response?.status || 0);
  return status >= 500;
}

async function createCardRequestViaBackend(payload: Record<string, any>) {
  let lastError: any;
  for (const base of getBackendBaseCandidates()) {
    try {
      return await axios.post(`${base}/api/card-requests`, payload, { timeout: 30000 });
    } catch (err: any) {
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
    if (isPrismaPersistenceEnabled()) {
      const user = await prisma.user.findUnique({ where: { userId: params.userId } });
      const customerEmail = user?.customerEmail || undefined;
      const card = await prisma.card.findFirst({
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
      return ok(res, {
        balance,
        currency,
        walletBalance: Number.isFinite(walletBalance) ? walletBalance : 0,
        cardBalance: hasCardBalance ? cardBalanceCandidate : null,
        source: hasCardBalance ? "card" : "wallet",
      });
    }
    const user = await User.findOne({ userId: params.userId }).lean();
    const customer = await Customer.findOne({ userId: params.userId }).lean();
    const customerEmail = customer?.email || user?.customerEmail;
    const card = await Card.findOne({
      $or: [
        { userId: params.userId },
        ...(customerEmail ? [{ customerEmail }] : []),
      ],
    })
      .sort({ updatedAt: -1 })
      .lean();
    const walletBalance = Number(user?.balance ?? 0);
    const cardBalanceCandidate = Number((card as any)?.balance ?? (card as any)?.availableBalance ?? NaN);
    const hasCardBalance = Number.isFinite(cardBalanceCandidate);
    const balance = hasCardBalance ? cardBalanceCandidate : (Number.isFinite(walletBalance) ? walletBalance : 0);
    const currency = String((card as any)?.currency || user?.currency || "USDT").toUpperCase();
    return ok(res, {
      balance,
      currency,
      walletBalance: Number.isFinite(walletBalance) ? walletBalance : 0,
      cardBalance: hasCardBalance ? cardBalanceCandidate : null,
      source: hasCardBalance ? "card" : "wallet",
    });
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
    if (isPrismaPersistenceEnabled()) {
      const rows = await prisma.transaction.findMany({
        where: { transactionType: "deposit" },
        orderBy: { createdAt: "desc" },
        take: limit,
      });
      return ok(res, { items: rows.map((r: any) => ({ ...r, cardId: null })) });
    }
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
  if (isPrismaPersistenceEnabled()) {
    try {
      const id = String(req.params.id || "").trim();
      if (!id) return fail(res, "Transaction id is required", 400);
      const { action, reason } = TransactionDecisionSchema.parse(req.body || {});

      const tx = await prisma.transaction.findFirst({
        where: {
          OR: [{ id }, { transactionNumber: id }, { referenceNumber: id }],
        },
      });
      if (!tx) return fail(res, "Transaction not found", 404);
      if (tx.transactionType !== "deposit") return fail(res, "Only deposit transactions can be reviewed manually", 400);

      if (tx.status === "completed") {
        return ok(res, {
          id: tx.id,
          status: tx.status,
          message: "Transaction already completed",
        });
      }
      if (tx.status !== "pending") {
        return fail(res, `Only pending transactions can be reviewed (current: ${tx.status})`, 400);
      }

      const txMetadata = tx.metadata && typeof tx.metadata === "object" && !Array.isArray(tx.metadata) ? (tx.metadata as any) : {};

      if (action === "decline") {
        await prisma.transaction.update({
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
            } as any,
          },
        });

        await notifyDepositReviewDeclined(String(tx.userId), reason).catch((notifyErr: any) => {
          console.warn("Failed to notify declined deposit review", {
            userId: String(tx.userId),
            txId: tx.id,
            error: notifyErr?.message || String(notifyErr),
          });
        });

        return ok(res, { id: tx.id, status: "failed", action });
      }

      const isCardRequestManual = txMetadata?.kind === "card_request_manual";
      if (isCardRequestManual) {
        const userId = String(tx.userId);
        const userRecord = await prisma.user.findUnique({ where: { userId } });
        if (!userRecord) return fail(res, "User not found", 404);
        const cardAmountUsdRaw = txMetadata?.cardAmountUsd;
        const cardAmountUsd = Number(cardAmountUsdRaw);
        const amount = Number.isFinite(cardAmountUsd) && cardAmountUsd >= 3 ? cardAmountUsd : 3;
        const nameOnCard = [userRecord.firstName, userRecord.lastName].filter(Boolean).join(" ") || "StroWallet User";
        const customerEmail = userRecord.customerEmail;
        if (!customerEmail) return fail(res, "User email is missing for card request", 400);

        let createResp: any;
        try {
          createResp = await createCardRequestViaBackend(
            {
              userId,
              nameOnCard,
              cardType: "visa",
              amount: String(amount),
              customerEmail,
              metadata: {
                source: "admin_manual_review",
                transactionId: tx.id,
              },
            },
          );
        } catch (createErr: any) {
          const msg = createErr?.response?.data?.error || createErr?.message || "Failed to create card request";
          return fail(res, msg, 400);
        }

        const cardId = createResp?.data?.data?.cardId;
        await prisma.transaction.update({
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
            } as any,
          },
        });

        return ok(res, { id: tx.id, status: "completed", action, cardId: cardId || null });
      }

      const amountEtbRaw = tx.amountEtb ?? txMetadata?.expectedAmountEtb ?? tx.amount;
      const amountEtb = Number(amountEtbRaw);
      if (!Number.isFinite(amountEtb) || amountEtb <= 0) {
        return fail(res, "Cannot approve transaction without a valid ETB amount", 400);
      }

      const pricing = await loadPricingConfig();
      const quote = quoteDeposit(amountEtb, pricing);
      if (quote.creditedUsdt <= 0) return fail(res, "Deposit amount is too low after fees", 400);

      const user = await prisma.user.findUnique({ where: { userId: String(tx.userId) } });
      if (!user) return fail(res, "User not found", 404);

      const updatedUser = await prisma.user.update({
        where: { userId: String(tx.userId) },
        data: { balance: (user.balance || 0) + quote.creditedUsdt },
      });

      await prisma.transaction.update({
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
          } as any,
        },
      });

      await notifyDepositCredited(String(tx.userId), quote.creditedUsdt, updatedUser.balance).catch((notifyErr: any) => {
        console.warn("Failed to notify approved deposit review", {
          userId: String(tx.userId),
          txId: tx.id,
          error: notifyErr?.message || String(notifyErr),
        });
      });

      return ok(res, {
        id: tx.id,
        status: "completed",
        action,
        creditedUsdt: quote.creditedUsdt,
        newBalance: updatedUser.balance,
        feeEtb: quote.feeEtb,
        rate: quote.rate,
      });
    } catch (err: any) {
      const message = err?.errors?.[0]?.message || err?.message || "Failed to process decision";
      return fail(res, message, 400);
    }
  }

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const id = String(req.params.id || "").trim();
    if (!id) {
      await session.abortTransaction();
      session.endSession();
      return fail(res, "Transaction id is required", 400);
    }
    const { action, reason } = TransactionDecisionSchema.parse(req.body || {});

    const txQuery: any[] = [{ transactionNumber: id }, { referenceNumber: id }];
    if (mongoose.Types.ObjectId.isValid(id)) {
      txQuery.unshift({ _id: id });
    }

    const tx = await Transaction.findOne({ $or: txQuery }).session(session);
    if (!tx) {
      await session.abortTransaction();
      session.endSession();
      return fail(res, "Transaction not found", 404);
    }

    if (tx.transactionType !== "deposit") {
      await session.abortTransaction();
      session.endSession();
      return fail(res, "Only deposit transactions can be reviewed manually", 400);
    }

    if (tx.status === "completed") {
      await session.commitTransaction();
      session.endSession();
      return ok(res, {
        id: String(tx._id),
        status: tx.status,
        message: "Transaction already completed",
      });
    }

    if (tx.status !== "pending") {
      await session.abortTransaction();
      session.endSession();
      return fail(res, `Only pending transactions can be reviewed (current: ${tx.status})`, 400);
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

      await notifyDepositReviewDeclined(String(tx.userId), reason).catch((notifyErr: any) => {
        console.warn("Failed to notify declined deposit review", {
          userId: String(tx.userId),
          txId: String(tx._id),
          error: notifyErr?.message || String(notifyErr),
        });
      });
      return ok(res, {
        id: String(tx._id),
        status: tx.status,
        action,
      });
    }

    const isCardRequestManual = tx.metadata?.kind === "card_request_manual";
    if (isCardRequestManual) {
      const userId = String(tx.userId);
      const userRecord = await User.findOne({ userId }).lean();
      const customer = await Customer.findOne({ userId }).lean();
      if (!userRecord) {
        await session.abortTransaction();
        session.endSession();
        return fail(res, "User not found", 404);
      }
      const cardAmountUsdRaw = tx.metadata?.cardAmountUsd;
      const cardAmountUsd = Number(cardAmountUsdRaw);
      const amount = Number.isFinite(cardAmountUsd) && cardAmountUsd >= 3 ? cardAmountUsd : 3;
      const nameOnCard = [userRecord.firstName, userRecord.lastName].filter(Boolean).join(" ") || "StroWallet User";
      const customerEmail = customer?.email || userRecord.customerEmail;
      if (!customerEmail) {
        await session.abortTransaction();
        session.endSession();
        return fail(res, "User email is missing for card request", 400);
      }

      let createResp: any;
      try {
        createResp = await createCardRequestViaBackend(
          {
            userId,
            nameOnCard,
            cardType: "visa",
            amount: String(amount),
            customerEmail,
            metadata: {
              source: "admin_manual_review",
              transactionId: String(tx._id),
            },
          },
        );
      } catch (createErr: any) {
        await session.abortTransaction();
        session.endSession();
        const msg = createErr?.response?.data?.error || createErr?.message || "Failed to create card request";
        return fail(res, msg, 400);
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

      return ok(res, {
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
      return fail(res, "Cannot approve transaction without a valid ETB amount", 400);
    }

    const pricing = await loadPricingConfig();
    const quote = quoteDeposit(amountEtb, pricing);
    if (quote.creditedUsdt <= 0) {
      await session.abortTransaction();
      session.endSession();
      return fail(res, "Deposit amount is too low after fees", 400);
    }

    const user = await User.findOneAndUpdate(
      { userId: String(tx.userId) },
      { $inc: { balance: quote.creditedUsdt } },
      { new: true, session }
    );
    if (!user) {
      await session.abortTransaction();
      session.endSession();
      return fail(res, "User not found", 404);
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

    await notifyDepositCredited(String(tx.userId), quote.creditedUsdt, user.balance).catch((notifyErr: any) => {
      console.warn("Failed to notify approved deposit review", {
        userId: String(tx.userId),
        txId: String(tx._id),
        error: notifyErr?.message || String(notifyErr),
      });
    });
    return ok(res, {
      id: String(tx._id),
      status: tx.status,
      action,
      creditedUsdt: quote.creditedUsdt,
      newBalance: user.balance,
      feeEtb: quote.feeEtb,
      rate: quote.rate,
    });
  } catch (err: any) {
    try {
      await session.abortTransaction();
    } catch {}
    session.endSession();
    const message = err?.errors?.[0]?.message || err?.message || "Failed to process decision";
    return fail(res, message, 400);
  }
});

// Admin: reset all existing users to start fresh (zero balances, unlink cards, archive transactions)
router.post("/reset-users", requireAdmin, async (req, res) => {
  try {
    const body = ResetUsersSchema.parse(req.body || {});
    if (body.scope === "single" && !body.userId) {
      return fail(res, "userId is required for single-user reset", 400);
    }

    if (isPrismaPersistenceEnabled()) {
      const removeTransactions = Boolean(body.removeTransactions);
      if (body.scope === "single") {
        const userId = String(body.userId);
        const [userRes, cardsRes, requestsRes, transactionsCancelledRes] = await Promise.all([
          prisma.user.updateMany({ where: { userId }, data: { balance: 0, currency: "USDT" } }),
          prisma.card.updateMany({ where: { userId }, data: { userId: null } }),
          prisma.cardRequest.updateMany({
            where: { userId, NOT: { status: "declined" } },
            data: { status: "declined", decisionReason: "Reset by admin" },
          }),
          prisma.transaction.updateMany({
            where: { userId, NOT: { status: "cancelled" } },
            data: {
              status: "cancelled",
              metadata: {
                archivedBy: "admin_reset",
                archivedAt: new Date(),
                reason: body.reason || undefined,
              } as any,
            },
          }),
        ]);

        const transactionsDeletedRes = removeTransactions
          ? await prisma.transaction.deleteMany({ where: { userId } })
          : { count: 0 };

        return ok(res, {
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
        prisma.user.updateMany({ data: { balance: 0, currency: "USDT" } }),
        prisma.card.updateMany({ data: { userId: null } }),
        prisma.cardRequest.updateMany({
          where: { NOT: { status: "declined" } },
          data: { status: "declined", decisionReason: "Reset by admin" },
        }),
        prisma.transaction.updateMany({
          where: { NOT: { status: "cancelled" } },
          data: {
            status: "cancelled",
            metadata: {
              archivedBy: "admin_reset",
              archivedAt: new Date(),
              reason: body.reason || undefined,
            } as any,
          },
        }),
      ]);

      const transactionsDeletedRes = removeTransactions
        ? await prisma.transaction.deleteMany({})
        : { count: 0 };

      return ok(res, {
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
