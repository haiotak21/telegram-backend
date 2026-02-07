import express from "express";
import axios, { AxiosError } from "axios";
import { z } from "zod";
import User from "../models/User";
import Card from "../models/Card";
import Transaction from "../models/Transaction";
import { notifyCardStatusChanged } from "../services/botService";
import { auditCardTransactions, getReconciliationSummary, reconcileAllCards, reconcileCard } from "../services/reconciliationService";

const router = express.Router();

const BITVCARD_BASE = "https://strowallet.com/api/bitvcard/";

function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction) {
  const adminToken = process.env.ADMIN_API_TOKEN;
  if (!adminToken) return next();
  const provided = req.headers["x-admin-token"] as string | undefined;
  if (provided && provided === adminToken) return next();
  return res.status(401).json({ success: false, message: "Unauthorized" });
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
    return { status, body: { success: false, message: String(msg), data: payload } };
  }
  const status = e?.status ?? 400;
  const msg = e?.message ?? "Request error";
  return { status, body: { success: false, message: String(msg) } };
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

function normalizeKycStatus(value: any): "pending" | "approved" | "declined" | undefined {
  if (!value) return undefined;
  const v = String(value).toLowerCase();
  if (["approved", "verified", "success", "active", "high kyc"].includes(v)) return "approved";
  if (["pending", "processing", "review", "unreview kyc"].includes(v)) return "pending";
  if (["declined", "rejected", "failed", "low kyc"].includes(v)) return "declined";
  return undefined;
}

function extractCustomerId(payload: any) {
  return (
    payload?.data?.customerId ||
    payload?.data?.customer_id ||
    payload?.data?.data?.customerId ||
    payload?.data?.data?.customer_id ||
    payload?.customerId ||
    payload?.customer_id ||
    payload?.data?.id ||
    payload?.data?.data?.id ||
    payload?.id
  );
}

async function fetchCustomerStatus(params: { customerId?: string; customerEmail?: string }) {
  const public_key = requirePublicKey();
  const resp = await axios.get(`${BITVCARD_BASE}getcardholder/`, {
    params: {
      public_key,
      customerId: params.customerId,
      customerEmail: params.customerEmail,
    },
    timeout: 15000,
  });
  return resp.data;
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

router.get("/users", requireAdmin, async (req, res) => {
  try {
    const { search, limit } = SearchSchema.parse(req.query || {});
    const q = search?.trim();
    const query: any = {
      $or: [
        { kycStatus: { $in: ["pending", "approved", "declined"] } },
        { kycSubmittedAt: { $exists: true, $ne: null } },
        { strowalletCustomerId: { $exists: true, $ne: null } },
      ],
    };

    if (q) {
      const isNumeric = /^\d+$/.test(q);
      query.$and = [
        query,
        {
          $or: [
            ...(isNumeric ? [{ userId: q }] : []),
            { customerEmail: q },
            { strowalletCustomerId: q },
          ],
        },
      ];
      delete query.$or;
    }

    const items = await User.find(query)
      .sort({ kycSubmittedAt: -1, updatedAt: -1 })
      .limit(limit || 50)
      .lean();

    const users = items.map((u) => ({
      telegramUserId: u.userId,
      strowalletCustomerId: u.strowalletCustomerId,
      kycStatus: u.kycStatus || "not_started",
      firstName: u.firstName,
      lastName: u.lastName,
      customerEmail: u.customerEmail,
      idType: u.idType,
      submittedAt: u.kycSubmittedAt,
    }));

    return res.json({ success: true, users });
  } catch (e) {
    const { status, body } = normalizeError(e);
    return res.status(status).json(body);
  }
});

router.get("/users/:telegramUserId/kyc-status", requireAdmin, async (req, res) => {
  try {
    const telegramUserId = String(req.params.telegramUserId);
    const refresh = String(req.query.refresh || "false").toLowerCase() === "true";
    const user = await User.findOne({ userId: telegramUserId });
    if (!user) return res.status(404).json({ success: false, message: "User not found" });

    let updatedStatus = user.kycStatus || "not_started";

    if (refresh && (user.strowalletCustomerId || user.customerEmail)) {
      try {
        const sw = await fetchCustomerStatus({
          customerId: user.strowalletCustomerId || undefined,
          customerEmail: user.customerEmail || undefined,
        });
        const statusRaw =
          sw?.status ||
          sw?.kycStatus ||
          sw?.verificationStatus ||
          sw?.state ||
          sw?.data?.status ||
          sw?.data?.kycStatus ||
          sw?.data?.verificationStatus ||
          sw?.data?.state;

        const normalized = normalizeKycStatus(statusRaw);
        const providerCustomerId = extractCustomerId(sw);
        if (normalized && normalized !== user.kycStatus) {
          user.kycStatus = normalized;
        }
        if (providerCustomerId && !user.strowalletCustomerId) {
          user.strowalletCustomerId = providerCustomerId;
        }
        if (normalized || providerCustomerId) {
          await user.save();
        }
        if (normalized) updatedStatus = normalized;
      } catch (err: any) {
        if (err?.response?.status !== 404) throw err;
      }
    }

    return res.json({
      success: true,
      telegramUserId: user.userId,
      strowalletCustomerId: user.strowalletCustomerId,
      customerEmail: user.customerEmail,
      kycStatus: updatedStatus === "declined" ? "rejected" : updatedStatus,
      submittedAt: user.kycSubmittedAt,
      idType: user.idType,
      name: [user.firstName, user.lastName].filter(Boolean).join(" "),
    });
  } catch (e) {
    const { status, body } = normalizeError(e);
    return res.status(status).json(body);
  }
});

router.get("/users/:telegramUserId/kyc-debug", requireAdmin, async (req, res) => {
  try {
    const telegramUserId = String(req.params.telegramUserId);
    const user = await User.findOne({ userId: telegramUserId }).lean();
    if (!user) return res.status(404).json({ success: false, message: "User not found" });

    const missing = [
      user.idType ? null : "idType",
      user.idImageUrl || user.idImageFrontUrl || user.idImageBackUrl || user.idImagePdfUrl ? null : "idImage",
      user.userPhotoUrl ? null : "userPhoto",
      user.strowalletCustomerId ? null : "strowalletCustomerId",
    ].filter(Boolean);

    return res.json({
      success: true,
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
    const { status, body } = normalizeError(e);
    return res.status(status).json(body);
  }
});

router.get("/users/:telegramUserId/kyc-payload", requireAdmin, async (req, res) => {
  try {
    const telegramUserId = String(req.params.telegramUserId);
    const user = await User.findOne({ userId: telegramUserId }).lean();
    if (!user) return res.status(404).json({ success: false, message: "User not found" });

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

    return res.json({
      success: true,
      note: "idNumber is not stored in plain text; fill it from the user. idNumberLast4 provided for reference.",
      idNumberLast4: user.idNumberLast4,
      payload,
    });
  } catch (e) {
    const { status, body } = normalizeError(e);
    return res.status(status).json(body);
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

    return res.json({
      success: true,
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
    const { status, body } = normalizeError(e);
    return res.status(status).json(body);
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
    return res.json({ success: true, detail: data });
  } catch (e) {
    const { status, body } = normalizeError(e);
    return res.status(status).json(body);
  }
});

router.post("/cards/:cardId/action", requireAdmin, async (req, res) => {
  try {
    const cardId = String(req.params.cardId);
    const action = req.body?.action === "freeze" ? "freeze" : "unfreeze";
    const card = await Card.findOne({ cardId });
    if (!card) return res.status(404).json({ success: false, message: "Card not found" });
    const currentStatus = String(card.status || "").toLowerCase();
    if (action === "freeze" && currentStatus === "frozen") {
      return res.status(400).json({ success: false, message: "Card already frozen" });
    }
    if (action === "unfreeze" && currentStatus === "active") {
      return res.status(400).json({ success: false, message: "Card already active" });
    }
    const result = await actionCard(cardId, action);
    await Card.findOneAndUpdate(
      { cardId },
      { $set: { status: action === "freeze" ? "frozen" : "active", lastSync: new Date() } },
      { new: true }
    );
    await notifyCardStatusChanged(cardId, action === "freeze" ? "frozen" : "active");
    return res.json({ success: true, result });
  } catch (e) {
    const { status, body } = normalizeError(e);
    return res.status(status).json(body);
  }
});

router.post("/cards/:cardId/fund", requireAdmin, async (req, res) => {
  try {
    const cardId = String(req.params.cardId);
    const amount = String(req.body?.amount || "0");
    const mode = typeof req.body?.mode === "string" ? req.body.mode : undefined;
    const result = await fundCard(cardId, amount, mode);

    const data = (result as any)?.data ?? result;
    const balanceRaw =
      (data as any)?.balance ||
      (data as any)?.available_balance ||
      (data as any)?.availableBalance ||
      (data as any)?.data?.balance ||
      (data as any)?.data?.available_balance;
    const currency = extractField(data, ["currency", "ccy", "iso_currency"]);
    const amountNum = Number(amount);
    const nextBalance = balanceRaw != null && !Number.isNaN(Number(balanceRaw)) ? Number(balanceRaw) : undefined;

    const existing = await Card.findOne({ cardId }).lean();
    const updatedBalance =
      nextBalance != null
        ? nextBalance
        : existing?.balance != null && !Number.isNaN(Number(existing.balance)) && !Number.isNaN(amountNum)
          ? Number(existing.balance) + amountNum
          : undefined;

    const updated = await Card.findOneAndUpdate(
      { cardId },
      {
        $set: {
          balance: updatedBalance != null ? String(updatedBalance) : existing?.balance,
          currency: currency || existing?.currency,
          lastSync: new Date(),
        },
      },
      { new: true }
    );

    const userId = updated?.userId || existing?.userId;
    const txnId = extractField(data, ["transaction_id", "transactionId", "id", "reference", "ref"]);
    const ref = txnId || `admin-fund-${cardId}-${Date.now()}`;
    if (userId && !Number.isNaN(amountNum)) {
      await Transaction.findOneAndUpdate(
        { userId, transactionType: "card", transactionNumber: ref },
        {
          $set: {
            userId,
            transactionType: "card",
            paymentMethod: "strowallet",
            amount: Math.abs(amountNum),
            currency: currency || updated?.currency || existing?.currency || "USD",
            status: "completed",
            transactionNumber: ref,
            metadata: {
              cardId,
              direction: "credit",
              description: "Admin fund",
            },
            responseData: data,
          },
        },
        { upsert: true, new: true }
      );
    }
    return res.json({ success: true, result });
  } catch (e) {
    const { status, body } = normalizeError(e);
    return res.status(status).json(body);
  }
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
      return res.json({ success: true, data });
    }
    const data = await fetchCardTransactions(cardId, mode);
    return res.json({ success: true, data });
  } catch (e) {
    const { status, body } = normalizeError(e);
    return res.status(status).json(body);
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

    return res.json({ success: true, transactions });
  } catch (e) {
    const { status, body } = normalizeError(e);
    return res.status(status).json(body);
  }
});

// Reconciliation summary
router.get("/reconciliation", requireAdmin, async (req, res) => {
  try {
    const limit = Number(req.query.limit || 50);
    const mismatchOnly = String(req.query.mismatchOnly || "false").toLowerCase() === "true";
    const items = await getReconciliationSummary(limit, mismatchOnly);
    return res.json({ success: true, items });
  } catch (e) {
    const { status, body } = normalizeError(e);
    return res.status(status).json(body);
  }
});

// Run reconciliation for all cards
router.post("/reconciliation/run", requireAdmin, async (req, res) => {
  try {
    const mode = typeof req.body?.mode === "string" ? req.body.mode : undefined;
    const limit = req.body?.limit ? Number(req.body.limit) : undefined;
    const results = await reconcileAllCards({ mode, notify: true, limit });
    return res.json({ success: true, results });
  } catch (e) {
    const { status, body } = normalizeError(e);
    return res.status(status).json(body);
  }
});

// Force reconciliation for a card
router.post("/reconciliation/:cardId/force", requireAdmin, async (req, res) => {
  try {
    const cardId = String(req.params.cardId);
    const mode = typeof req.body?.mode === "string" ? req.body.mode : undefined;
    const result = await reconcileCard(cardId, { mode, notify: true });
    return res.json({ success: true, result });
  } catch (e) {
    const { status, body } = normalizeError(e);
    return res.status(status).json(body);
  }
});

// Audit transactions for a card
router.get("/reconciliation/:cardId/audit", requireAdmin, async (req, res) => {
  try {
    const cardId = String(req.params.cardId);
    const mode = typeof req.query.mode === "string" ? req.query.mode : undefined;
    const result = await auditCardTransactions(cardId, { mode });
    return res.json({ success: true, result });
  } catch (e) {
    const { status, body } = normalizeError(e);
    return res.status(status).json(body);
  }
});

export default router;
