import express from "express";
import axios, { AxiosError } from "axios";
import { z } from "zod";
import User from "../models/User";
import Customer from "../models/Customer";
import Card from "../models/Card";
import CardRequest from "../models/CardRequest";
import { TelegramLink } from "../models/TelegramLink";
import Transaction from "../models/Transaction";
import { notifyCardStatusChanged } from "../services/botService";
import { auditCardTransactions, getReconciliationSummary, reconcileAllCards, reconcileCard } from "../services/reconciliationService";
import { ok, fail } from "../utils/apiResponse";

const router = express.Router();

const BITVCARD_BASE = "https://strowallet.com/api/bitvcard/";

function getDefaultMode() {
  return process.env.STROWALLET_DEFAULT_MODE || (process.env.NODE_ENV !== "production" ? "sandbox" : undefined);
}

function normalizeMode(mode?: string) {
  if (!mode) return undefined;
  const m = String(mode).toLowerCase();
  if (m === "live") return undefined;
  return m;
}

function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction) {
  const adminToken = process.env.ADMIN_API_TOKEN;
  if (!adminToken) return next();
  const provided = req.headers["x-admin-token"] as string | undefined;
  if (provided && provided === adminToken) return next();
  return fail(res, "Unauthorized", 401);
}

function requirePublicKey() {
  const key = process.env.STROWALLET_PUBLIC_KEY;
  if (!key) {
    const err = new Error("Missing STROWALLET_PUBLIC_KEY env");
    (err as any).status = 500;
    throw err;
  }
  return key;
}

function normalizeError(e: any) {
  if (axios.isAxiosError(e)) {
    const ae = e as AxiosError<any>;
    const status = ae.response?.status ?? 400;
    const payload = ae.response?.data as any;
    const msg = payload?.message || payload?.error || ae.message || "Request failed";
    return { status, message: String(msg) };
  }
  const status = e?.status ?? 400;
  const msg = e?.message ?? "Request error";
  return { status, message: String(msg) };
}

function extractField(obj: any, keys: string[]): string | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  for (const key of keys) {
    if (obj[key] != null) return String(obj[key]);
  }
  for (const val of Object.values(obj)) {
    const v = typeof val === "object" ? extractField(val, keys) : undefined;
    if (v) return v;
  }
  return undefined;
}

async function fetchCardDetail(cardId: string, mode?: string) {
  const public_key = requirePublicKey();
  const resp = await axios.post(
    `${BITVCARD_BASE}fetch-card-detail/`,
    { card_id: cardId, public_key, mode },
    { timeout: 15000 }
  );
  return resp.data;
}

async function actionCard(cardId: string, action: "freeze" | "unfreeze") {
  const public_key = requirePublicKey();
  const resp = await axios.post(
    `${BITVCARD_BASE}action/status/`,
    { card_id: cardId, action, public_key },
    { timeout: 15000 }
  );
  return resp.data;
}

async function fundCard(cardId: string, amount: string, mode?: string) {
  const public_key = requirePublicKey();
  const resp = await axios.post(
    `${BITVCARD_BASE}fund-card/`,
    { card_id: cardId, amount, public_key, mode },
    { timeout: 15000 }
  );
  return resp.data;
}

async function fetchCardTransactions(cardId: string, mode?: string) {
  const public_key = requirePublicKey();
  const resp = await axios.post(
    `${BITVCARD_BASE}card-transactions/`,
    { card_id: cardId, public_key, mode },
    { timeout: 15000 }
  );
  return resp.data;
}

async function fetchCardHistory(cardId: string, page: number, take: number) {
  const public_key = requirePublicKey();
  const resp = await axios.get("https://strowallet.com/api/apicard-transactions/", {
    params: { card_id: cardId, page, take, public_key },
    timeout: 15000,
  });
  return resp.data;
}

const SearchSchema = z.object({
  search: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const TransactionQuerySchema = z.object({
  userId: z.string().optional(),
  cardId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const CardLinkSchema = z
  .object({
    cardId: z.string().min(1),
    customerEmail: z.string().email().optional(),
    userId: z.string().min(1).optional(),
    nameOnCard: z.string().min(1).optional(),
    cardType: z.string().min(1).optional(),
    status: z.string().min(1).optional(),
    last4: z.string().min(4).max(4).optional(),
    currency: z.string().min(1).optional(),
    balance: z.string().optional(),
  })
  .refine((v) => v.customerEmail || v.userId, {
    message: "customerEmail or userId is required",
  });

router.get("/stats", requireAdmin, async (_req, res) => {
  try {
    const [usersTotal, kycApproved, cardHolders, transactionsTotal] = await Promise.all([
      User.countDocuments({}),
      Customer.countDocuments({ kycStatus: "approved" }),
      Card.distinct("userId", { cardId: { $exists: true, $ne: "" } }).then((ids) => ids.length),
      Transaction.countDocuments({}),
    ]);
    return ok(res, { usersTotal, kycApproved, cardHolders, transactionsTotal });
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

router.get("/users", requireAdmin, async (req, res) => {
  try {
    const { search, limit } = SearchSchema.parse(req.query || {});
    const q = search?.trim();
    const baseQuery: any = {
      $or: [
        { kycStatus: { $in: ["pending", "approved", "declined"] } },
        { kycSubmittedAt: { $exists: true, $ne: null } },
        { strowalletCustomerId: { $exists: true, $ne: null } },
      ],
    };

    let query: any = baseQuery;

    if (q) {
      const isNumeric = /^\d+$/.test(q);
      query = {
        $and: [
          baseQuery,
          {
            $or: [
              ...(isNumeric ? [{ userId: q }] : []),
              { customerEmail: q },
              { strowalletCustomerId: q },
            ],
          },
        ],
      };
    }

    const items = await User.find(query)
      .sort({ kycSubmittedAt: -1, updatedAt: -1 })
      .limit(limit || 50)
      .lean();

    const userIds = items.map((u) => u.userId);
    const customers = await Customer.find({ userId: { $in: userIds } }).lean();
    const customerMap = new Map(customers.map((c) => [c.userId, c]));

    const users = items.map((u) => {
      const customer = customerMap.get(u.userId);
      return {
        telegramUserId: u.userId,
        customerId: customer?.customerId || u.strowalletCustomerId,
        kycStatus: customer?.kycStatus || "not_started",
        customerKycStatus: customer?.kycStatus || null,
        userKycStatus: u.kycStatus || null,
        firstName: u.firstName,
        lastName: u.lastName,
        customerEmail: customer?.email || u.customerEmail,
        idType: u.idType,
        submittedAt: customer?.submittedAt || u.kycSubmittedAt,
      };
    });

    return ok(res, { users });
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

router.get("/users/:telegramUserId/kyc-status", requireAdmin, async (req, res) => {
  try {
    const telegramUserId = String(req.params.telegramUserId);
    const user = await User.findOne({ userId: telegramUserId }).lean();
    if (!user) return fail(res, "User not found", 404);
    const customer = await Customer.findOne({ userId: telegramUserId }).lean();
    if (!customer) return fail(res, "Customer not found", 404);

    return ok(res, {
      telegramUserId: user.userId,
      customerId: customer.customerId || user.strowalletCustomerId,
      customerEmail: customer.email || user.customerEmail,
      kycStatus: customer.kycStatus,
      customerKycStatus: customer.kycStatus,
      userKycStatus: user.kycStatus || null,
      submittedAt: customer.submittedAt || user.kycSubmittedAt,
      idType: user.idType,
      name: [user.firstName, user.lastName].filter(Boolean).join(" "),
    });
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

router.get("/users/:telegramUserId/kyc-debug", requireAdmin, async (req, res) => {
  try {
    const telegramUserId = String(req.params.telegramUserId);
    const user = await User.findOne({ userId: telegramUserId }).lean();
    if (!user) return fail(res, "User not found", 404);

    const missing = [
      user.idType ? null : "idType",
      user.idImageUrl || user.idImageFrontUrl || user.idImageBackUrl || user.idImagePdfUrl ? null : "idImage",
      user.userPhotoUrl ? null : "userPhoto",
      user.strowalletCustomerId ? null : "strowalletCustomerId",
    ].filter(Boolean);

    return ok(res, {
      telegramUserId: user.userId,
      kycStatus: user.kycStatus || "not_started",
      strowalletCustomerId: user.strowalletCustomerId,
      customerEmail: user.customerEmail,
      idType: user.idType,
      idImageUrl: user.idImageUrl,
      idImageFrontUrl: user.idImageFrontUrl,
      idImageBackUrl: user.idImageBackUrl,
      idImagePdfUrl: user.idImagePdfUrl,
      userPhotoUrl: user.userPhotoUrl,
      submittedAt: user.kycSubmittedAt,
      missing,
    });
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

router.post("/cards/link", requireAdmin, async (req, res) => {
  try {
    const body = CardLinkSchema.parse(req.body || {});
    const cardId = body.cardId.trim();
    let userId = body.userId;
    let customerEmail = body.customerEmail;

    if (!userId && customerEmail) {
      const customer = await Customer.findOne({ email: customerEmail }).lean();
      if (customer?.userId) userId = customer.userId;
    }
    if (!userId && customerEmail) {
      const user = await User.findOne({ customerEmail }).lean();
      if (user?.userId) userId = user.userId;
    }
    if (userId && !customerEmail) {
      const customer = await Customer.findOne({ userId }).lean();
      customerEmail = customer?.email;
      if (!customerEmail) {
        const user = await User.findOne({ userId }).lean();
        customerEmail = user?.customerEmail;
      }
    }

    const detail = await fetchCardDetail(cardId, normalizeMode(getDefaultMode())).catch(() => null);
    const last4 =
      body.last4 ||
      extractField(detail, ["last4", "card_last4", "cardLast4", "cardSuffix"]) ||
      (extractField(detail, ["card_number", "cardNumber"]) || "").slice(-4) ||
      undefined;

    const cardUpdate: any = {
      cardId,
      userId: userId || undefined,
      customerEmail: customerEmail || undefined,
      nameOnCard: body.nameOnCard || extractField(detail, ["name_on_card", "nameOnCard", "name"]),
      cardType: body.cardType || extractField(detail, ["card_type", "cardType", "brand"]),
      status: body.status || extractField(detail, ["card_status", "status", "state"]) || "active",
      last4,
      currency: body.currency || extractField(detail, ["currency", "ccy"]),
      balance: body.balance || extractField(detail, ["balance", "available_balance", "availableBalance"]),
      availableBalance: extractField(detail, ["available_balance", "availableBalance"]),
      lastSync: new Date(),
    };

    await Card.findOneAndUpdate({ cardId }, { $set: cardUpdate }, { upsert: true, new: true });

    if (userId) {
      const chatId = Number(userId);
      if (Number.isFinite(chatId)) {
        await TelegramLink.findOneAndUpdate(
          { chatId },
          { $addToSet: { cardIds: cardId }, ...(customerEmail ? { $set: { customerEmail } } : {}) },
          { upsert: true }
        );
      }
    }

    if (customerEmail) {
      await TelegramLink.findOneAndUpdate(
        { customerEmail },
        { $addToSet: { cardIds: cardId } },
        { upsert: true }
      );
    }

    if (userId || customerEmail) {
      await CardRequest.findOneAndUpdate(
        {
          $or: [
            ...(userId ? [{ userId }] : []),
            ...(customerEmail ? [{ customerEmail }] : []),
          ],
        },
        { $set: { cardId, status: "approved" } },
        { new: true }
      );
    }

    return ok(res, { cardId, userId, customerEmail, linked: true });
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

router.get("/users/:telegramUserId/kyc-payload", requireAdmin, async (req, res) => {
  try {
    const telegramUserId = String(req.params.telegramUserId);
    const user = await User.findOne({ userId: telegramUserId }).lean();
    if (!user) return fail(res, "User not found", 404);

    const idImage = user.idImagePdfUrl || user.idImageFrontUrl || user.idImageUrl || user.idImageBackUrl;
    const payload = {
      public_key: process.env.STROWALLET_PUBLIC_KEY,
      houseNumber: user.houseNumber,
      firstName: user.firstName,
      lastName: user.lastName,
      idNumber: "<FILL_WITH_USER_ID_NUMBER>",
      customerEmail: user.customerEmail,
      phoneNumber: user.phoneNumber,
      dateOfBirth: user.dateOfBirth,
      idImage,
      userPhoto: user.userPhotoUrl,
      line1: user.line1,
      state: user.state,
      zipCode: user.zipCode,
      city: user.city,
      country: user.country,
      idType: user.idType,
    };

    return ok(res, {
      note: "idNumber is not stored in plain text; fill it from the user. idNumberLast4 provided for reference.",
      idNumberLast4: user.idNumberLast4,
      payload,
    });
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

const CardSearchSchema = z.object({
  search: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

router.get("/cards", requireAdmin, async (req, res) => {
  try {
    const { search, limit } = CardSearchSchema.parse(req.query || {});
    const q = search?.trim();
    const query: any = {};
    if (q) {
      const isNumeric = /^\d+$/.test(q);
      query.$or = [
        ...(isNumeric ? [{ userId: q }] : []),
        { customerEmail: q },
        { cardId: q },
      ];
    }
    const items = await Card.find(query)
      .sort({ updatedAt: -1 })
      .limit(limit || 100)
      .lean();

    const userIds = Array.from(new Set(items.map((c) => c.userId).filter(Boolean)));
    const users = await User.find({ userId: { $in: userIds } }).lean();
    const userMap = new Map(users.map((u) => [u.userId, u]));

    return ok(res, {
      cards: items.map((c) => ({
        cardId: c.cardId,
        userId: c.userId,
        userName: c.userId ? [userMap.get(c.userId)?.firstName, userMap.get(c.userId)?.lastName].filter(Boolean).join(" ") || undefined : undefined,
        customerEmail: c.customerEmail,
        email: c.customerEmail,
        nameOnCard: c.nameOnCard,
        cardType: c.cardType,
        status: c.status,
        last4: c.last4,
        currency: c.currency,
        balance: c.balance != null && !Number.isNaN(Number(c.balance)) ? Number(c.balance) : c.balance,
        availableBalance: c.availableBalance,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      })),
    });
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

router.post("/cards/:cardId/refresh", requireAdmin, async (req, res) => {
  try {
    const cardId = String(req.params.cardId);
    const mode = typeof req.body?.mode === "string" ? req.body.mode : undefined;
    const detail = await fetchCardDetail(cardId, mode);
    const data = detail?.data ?? detail;
    await Card.findOneAndUpdate(
      { cardId },
      {
        $set: {
          nameOnCard: data?.name_on_card || data?.name,
          cardType: data?.card_type || data?.brand,
          status: data?.status || data?.state,
          last4: data?.last4 || data?.card_last4 || data?.cardLast4,
          currency: data?.currency || data?.ccy,
          balance: data?.balance || data?.available_balance,
          availableBalance: data?.available_balance,
        },
      },
      { upsert: true, new: true }
    );
    return ok(res, { detail: data });
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

router.post("/cards/:cardId/action", requireAdmin, async (req, res) => {
  try {
    const cardId = String(req.params.cardId);
    const action = req.body?.action === "freeze" ? "freeze" : "unfreeze";
    const card = await Card.findOne({ cardId });
    if (!card) return fail(res, "Card not found", 404);
    const currentStatus = String(card.status || "").toLowerCase();
    if (action === "freeze" && currentStatus === "frozen") {
      return fail(res, "Card already frozen", 400);
    }
    if (action === "unfreeze" && currentStatus === "active") {
      return fail(res, "Card already active", 400);
    }
    const result = await actionCard(cardId, action);
    await Card.findOneAndUpdate(
      { cardId },
      { $set: { status: action === "freeze" ? "frozen" : "active", lastSync: new Date() } },
      { new: true }
    );
    await notifyCardStatusChanged(cardId, action === "freeze" ? "frozen" : "active");
    return ok(res, { result });
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

router.post("/cards/:cardId/fund", requireAdmin, async (_req, res) => {
  return fail(res, "Admin funding is disabled. StroWallet is the source of truth.", 405);
});

router.get("/cards/:cardId/transactions", requireAdmin, async (req, res) => {
  try {
    const cardId = String(req.params.cardId);
    const mode = typeof req.query.mode === "string" ? req.query.mode : undefined;
    const history = String(req.query.history || "recent");
    if (history === "full") {
      const page = Number(req.query.page || 1);
      const take = Number(req.query.take || 50);
      const data = await fetchCardHistory(cardId, page, take);
      return ok(res, { data });
    }
    const data = await fetchCardTransactions(cardId, mode);
    return ok(res, { data });
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

// Local card transactions (webhook-synced)
router.get("/transactions", requireAdmin, async (req, res) => {
  try {
    const { userId, cardId, limit } = TransactionQuerySchema.parse(req.query || {});
    const query: any = { transactionType: "card" };
    if (userId) query.userId = userId;
    if (cardId) query["metadata.cardId"] = cardId;

    const items = await Transaction.find(query)
      .sort({ createdAt: -1 })
      .limit(limit || 50)
      .lean();

    const transactions = items.map((t) => ({
      id: t._id,
      userId: t.userId,
      cardId: t.metadata?.cardId,
      amount: t.amount,
      currency: t.currency,
      direction: t.metadata?.direction,
      description: t.metadata?.description,
      status: t.status,
      createdAt: t.createdAt,
    }));

    return ok(res, { transactions });
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

// Reconciliation summary
router.get("/reconciliation", requireAdmin, async (req, res) => {
  try {
    const limit = Number(req.query.limit || 50);
    const mismatchOnly = String(req.query.mismatchOnly || "false").toLowerCase() === "true";
    const items = await getReconciliationSummary(limit, mismatchOnly);
    return ok(res, { items });
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

// Run reconciliation for all cards
router.post("/reconciliation/run", requireAdmin, async (req, res) => {
  try {
    const mode = typeof req.body?.mode === "string" ? req.body.mode : undefined;
    const limit = req.body?.limit ? Number(req.body.limit) : undefined;
    const results = await reconcileAllCards({ mode, notify: true, limit });
    return ok(res, { results });
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

// Force reconciliation for a card
router.post("/reconciliation/:cardId/force", requireAdmin, async (req, res) => {
  try {
    const cardId = String(req.params.cardId);
    const mode = typeof req.body?.mode === "string" ? req.body.mode : undefined;
    const result = await reconcileCard(cardId, { mode, notify: true });
    return ok(res, { result });
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

export default router;
