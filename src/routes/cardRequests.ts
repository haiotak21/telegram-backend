import express from "express";
import axios, { AxiosError } from "axios";
import CardRequest from "../models/CardRequest";
import { TelegramLink } from "../models/TelegramLink";
import User from "../models/User";
import Card from "../models/Card";
import { notifyCardRequestApproved, notifyCardRequestDeclined } from "../services/botService";

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

function asString(val: any): string | undefined {
  if (val === undefined || val === null) return undefined;
  return String(val);
}

function asEmail(val: any): string | undefined {
  const s = asString(val);
  if (!s) return undefined;
  return /@/.test(s) ? s : undefined;
}

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
  return axios.create({
    baseURL: BITVCARD_BASE,
    timeout: 15000,
    headers: {
      Authorization: process.env.STROWALLET_API_KEY ? `Bearer ${process.env.STROWALLET_API_KEY}` : undefined,
    },
  });
}

function extractCardInfo(respData: any) {
  const cardId =
    respData?.card_id ||
    respData?.id ||
    respData?.data?.card_id ||
    respData?.data?.id ||
    respData?.response?.card_id ||
    respData?.response?.id ||
    respData?.response?.cardId;
  const cardNumber =
    respData?.card_number ||
    respData?.data?.card_number ||
    respData?.response?.card_number ||
    respData?.response?.cardNumber;
  const cvc =
    respData?.cvc ||
    respData?.cvv ||
    respData?.data?.cvc ||
    respData?.data?.cvv ||
    respData?.response?.cvc ||
    respData?.response?.cvv;
  return { cardId, cardNumber, cvc };
}

router.post("/", async (req, res) => {
  try {
    const body = req.body || {};
    const userId = asString(body.userId);
    if (!userId) throw new Error("userId is required");

    // Block new requests if user already has an active card
    const activeCard = await Card.findOne({ userId, status: { $in: ["active", "ACTIVE", "frozen", "FROZEN"] } }).lean();
    if (activeCard) {
      return res.status(400).json({ success: false, message: "User already has an active card" });
    }
    const chatIdNum = Number(userId);
    // Only block if there is a pending/approved request that is not declined and is not for a card that is unlinked
    const existing = await CardRequest.findOne({
      userId,
      status: { $in: ["pending", "approved"] },
      // Only block if cardId is present and still linked, or if status is pending
    }).lean();
    let block = false;
    if (existing) {
      // If status is pending, always block
      if (existing.status === "pending") block = true;
      // If status is approved, only block if cardId is still linked
      else if (existing.status === "approved" && existing.cardId) {
        // Check if cardId is still linked in TelegramLink
        if (Number.isFinite(chatIdNum)) {
          const link = await TelegramLink.findOne({ chatId: chatIdNum }).lean();
          if (link?.cardIds?.includes(existing.cardId)) block = true;
        } else {
          // If not a telegram user, conservatively block
          block = true;
        }
      }
    }
    if (block) {
      return res.status(400).json({ success: false, message: "You already have an active or approved card request" });
    }

    // Enforce minimum amount of 3
    let reqAmount = Number(body.amount);
    if (!Number.isFinite(reqAmount) || reqAmount < 3) reqAmount = 3;
    // Enforce cardType to be visa or mastercard
    let reqCardTypeRaw = asString(body.cardType);
    let reqCardType = reqCardTypeRaw ? reqCardTypeRaw.toLowerCase() : "visa";
    if (reqCardType !== "visa" && reqCardType !== "mastercard") reqCardType = "visa";
    const request = await CardRequest.create({
      userId,
      nameOnCard: asString(body.nameOnCard),
      cardType: reqCardType,
      amount: reqAmount.toString(),
      customerEmail: asEmail(body.customerEmail),
      mode: normalizeMode(getDefaultMode()),
      metadata: body.metadata,
      status: "pending",
    });
    res.status(201).json({ success: true, request });
  } catch (err: any) {
    const message = err?.errors?.[0]?.message || err?.message || "Invalid payload";
    res.status(400).json({ success: false, message });
  }
});

router.get("/", requireAdmin, async (req, res) => {
  try {
    const status = typeof req.query.status === "string" ? req.query.status : "pending";
    const limitRaw = Number(req.query.limit ?? 50);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 && limitRaw <= 200 ? limitRaw : 50;
    const requests = await CardRequest.find(status ? { status } : {})
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    const userIds = Array.from(new Set(requests.map((r) => r.userId).filter(Boolean)));
    const [users, cards] = await Promise.all([
      User.find({ userId: { $in: userIds } }).lean(),
      Card.find({ userId: { $in: userIds }, status: { $in: ["active", "ACTIVE", "frozen", "FROZEN"] } }).lean(),
    ]);
    const userMap = new Map(users.map((u) => [u.userId, u]));
    const activeCardMap = new Map<string, (typeof cards)[number]>();
    for (const c of cards) {
      if (c.userId && !activeCardMap.has(c.userId)) activeCardMap.set(c.userId, c);
    }

    const enriched = requests.map((r) => {
      const user = r.userId ? userMap.get(r.userId) : undefined;
      const activeCard = r.userId ? activeCardMap.get(r.userId) : undefined;
      const fullName = [user?.firstName, user?.lastName].filter(Boolean).join(" ") || undefined;
      return {
        ...r,
        userName: fullName,
        customerEmail: r.customerEmail || user?.customerEmail,
        hasActiveCard: Boolean(activeCard),
        activeCardId: activeCard?.cardId,
        activeCardLast4: activeCard?.last4,
      };
    });

    res.json({ success: true, requests: enriched });
  } catch (err: any) {
    const message = err?.message || "Failed to load requests";
    res.status(400).json({ success: false, message });
  }
});

router.post("/:id/approve", requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const request = await CardRequest.findById(req.params.id);
    if (!request) return res.status(404).json({ success: false, message: "Request not found" });
    if (request.status !== "pending") return res.status(400).json({ success: false, message: "Request already processed" });

    const user = await User.findOne({ userId: request.userId }).lean();
    if (!user || user.kycStatus !== "approved") {
      return res.status(400).json({ success: false, message: "User KYC must be approved before creating a card" });
    }

    const existingCard = await Card.findOne({ userId: request.userId, status: { $in: ["active", "ACTIVE", "frozen", "FROZEN"] } }).lean();
    if (existingCard) {
      return res.status(400).json({ success: false, message: "User already has an active card" });
    }

    const link = await TelegramLink.findOne({ chatId: Number(request.userId) }).lean();
    const nameOnCard = asString(body.nameOnCard) || request.nameOnCard || "StroWallet User";
    const cardType = (asString(body.cardType) || request.cardType || "visa").toLowerCase();
    const amountRaw = body.amount ?? request.amount ?? "0";
    const amountStr = typeof amountRaw === "number" ? amountRaw.toString() : String(amountRaw || "0");
    const parsedAmount = Number(amountStr);
    const amount = Number.isFinite(parsedAmount) && parsedAmount > 0 ? parsedAmount.toString() : undefined;
    const customerEmail = asEmail(body.customerEmail) || request.customerEmail || user.customerEmail || link?.customerEmail;
    const mode = normalizeMode(getDefaultMode());

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
    const payload: Record<string, any> = {
      name_on_card: nameOnCard,
      card_type: cardType,
      amount,
      customerEmail,
      public_key,
      mode,
    };

    const resp = await bitvcard.post("create-card/", payload);
    const respData = resp.data as any;

    const cardId =
      respData?.card_id ||
      respData?.id ||
      respData?.data?.card_id ||
      respData?.data?.id ||
      respData?.response?.card_id ||
      respData?.response?.id ||
      respData?.response?.cardId;
    const cardNumber =
      respData?.card_number ||
      respData?.data?.card_number ||
      respData?.response?.card_number ||
      respData?.response?.cardNumber;
    const cvc =
      respData?.cvc ||
      respData?.cvv ||
      respData?.data?.cvc ||
      respData?.data?.cvv ||
      respData?.response?.cvc ||
      respData?.response?.cvv;

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

    const last4 = cardNumber ? cardNumber.slice(-4) : undefined;
    await Card.findOneAndUpdate(
      { cardId },
      {
        $set: {
          cardId,
          userId: request.userId,
          customerEmail,
          nameOnCard,
          cardType,
          status: respData?.status || respData?.state || "active",
          last4,
          currency: respData?.currency || respData?.ccy,
          balance: respData?.balance || respData?.available_balance,
          availableBalance: respData?.available_balance,
        },
      },
      { upsert: true, new: true }
    );

    // Store card id on Telegram link for "My Cards" view
    await TelegramLink.findOneAndUpdate(
      { chatId: Number(request.userId) },
      { $addToSet: { cardIds: cardId }, $setOnInsert: { customerEmail } },
      { upsert: true }
    );

    notifyCardRequestApproved(request.userId, { cardId, cardType, nameOnCard, raw: respData }).catch(() => {});

    res.json({ success: true, request, cardId, response: respData });
  } catch (e: any) {
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
    const request = await CardRequest.findById(req.params.id);
    if (!request) return res.status(404).json({ success: false, message: "Request not found" });
    if (request.status !== "pending") return res.status(400).json({ success: false, message: "Request already processed" });

    request.status = "declined";
    request.decisionReason = asString(body.reason);
    request.adminNote = asString(body.adminNote) ?? request.adminNote;
    await request.save();

    notifyCardRequestDeclined(request.userId, body.reason).catch(() => {});

    res.json({ success: true, request });
  } catch (err: any) {
    const message = err?.errors?.[0]?.message || err?.message || "Invalid request";
    res.status(400).json({ success: false, message });
  }
});

export default router;
