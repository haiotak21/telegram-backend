import express from "express";
import axios, { AxiosError } from "axios";
import CardRequest from "../models/CardRequest";
import { TelegramLink } from "../models/TelegramLink";
import User from "../models/User";
import Customer from "../models/Customer";
import Card from "../models/Card";
import { notifyCardRequestApproved, notifyCardRequestDeclined } from "../services/botService";
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
    const validation = payload?.data?.errors || payload?.errors;
    const validationMsg = validation ? JSON.stringify(validation) : undefined;
    const msg = payload?.message || payload?.error || validationMsg || ae.message || "Request failed";
    return { status, message: String(msg) };
  }
  const status = e?.status ?? 400;
  const msg = e?.message ?? "Request error";
  return { status, message: String(msg) };
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

async function fetchCardDetail(cardId: string, mode?: string) {
  const public_key = requirePublicKey();
  const resp = await axios.post(
    `${BITVCARD_BASE}fetch-card-detail/`,
    { card_id: cardId, public_key, mode },
    { timeout: 15000 }
  );
  return resp.data;
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

function extractCardStatus(respData: any) {
  return (
    respData?.card_status ||
    respData?.status ||
    respData?.state ||
    respData?.response?.card_status ||
    respData?.response?.status ||
    respData?.response?.state ||
    respData?.data?.card_status ||
    respData?.data?.status ||
    respData?.data?.state
  );
}

router.post("/", async (req, res) => {
  try {
    const body = req.body || {};
    const userId = asString(body.userId);
    if (!userId) throw new Error("userId is required");

    const user = (await User.findOne({ userId }).lean()) as any;
    if (!user) {
      return fail(res, "User not found", 404);
    }
    const customer = (await Customer.findOne({ userId }).lean()) as any;

    // Block new requests if user already has a card or approved request
    const activeCard = await Card.findOne({ userId, status: { $in: ["active", "ACTIVE", "frozen", "FROZEN"] } }).lean();
    if (activeCard) {
      return fail(res, "User already has an active card", 400);
    }

    const existing = await CardRequest.findOne({ userId, status: { $in: ["pending", "approved"] } }).lean();
    if (existing) {
      return fail(res, "You already have an active or approved card request", 400);
    }

    if (!customer || customer.kycStatus !== "approved") {
      return fail(res, "You must complete KYC before requesting a card", 400);
    }

    // Enforce minimum amount of 3
    let reqAmount = Number(body.amount);
    if (!Number.isFinite(reqAmount) || reqAmount < 3) reqAmount = 3;
    // Enforce cardType to be visa or mastercard
    let reqCardTypeRaw = asString(body.cardType);
    let reqCardType = reqCardTypeRaw ? reqCardTypeRaw.toLowerCase() : "visa";
    if (reqCardType !== "visa" && reqCardType !== "mastercard") reqCardType = "visa";

    const nameOnCard = asString(body.nameOnCard) || [user.firstName, user.lastName].filter(Boolean).join(" ") || "StroWallet User";
    const customerEmail = asEmail(body.customerEmail) || customer.email || user.customerEmail;
    if (!customerEmail) {
      return fail(res, "customerEmail is required to create a card", 400);
    }

    const request = await CardRequest.create({
      userId,
      nameOnCard,
      cardType: reqCardType,
      amount: reqAmount.toString(),
      customerEmail,
      mode: normalizeMode(getDefaultMode()),
      metadata: body.metadata,
      status: "pending",
    });

    const bitvcard = buildBitvcardClient();
    const public_key = requirePublicKey();
    const payload: Record<string, any> = {
      name_on_card: nameOnCard,
      card_type: reqCardType,
      amount: reqAmount.toString(),
      customerEmail,
      public_key,
      mode: normalizeMode(getDefaultMode()),
    };

    try {
      const resp = await bitvcard.post("create-card/", payload);
      const respData = resp.data as any;
      const { cardId, cardNumber, cvc } = extractCardInfo(respData);

      if (!cardId) {
        request.status = "declined";
        request.decisionReason = "Card creation succeeded but no card_id returned";
        request.responseData = respData;
        await request.save();
        notifyCardRequestDeclined(request.userId, request.decisionReason).catch(() => {});
        return fail(res, request.decisionReason, 502);
      }

      request.status = "approved";
      request.cardId = cardId;
      request.cardNumber = cardNumber;
      request.cvc = cvc;
      request.responseData = respData;
      request.nameOnCard = nameOnCard;
      request.cardType = reqCardType;
      request.amount = reqAmount.toString();
      request.customerEmail = customerEmail;
      request.mode = normalizeMode(getDefaultMode());
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
            cardType: reqCardType,
            status: respData?.status || respData?.state || "active",
            last4,
            currency: respData?.currency || respData?.ccy,
            balance: respData?.balance || respData?.available_balance,
            availableBalance: respData?.available_balance,
          },
        },
        { upsert: true, new: true }
      );

      await TelegramLink.findOneAndUpdate(
        { chatId: Number(request.userId) },
        { $addToSet: { cardIds: cardId }, $setOnInsert: { customerEmail } },
        { upsert: true }
      );

      notifyCardRequestApproved(request.userId, { cardId, cardType: reqCardType, nameOnCard, raw: respData }).catch(() => {});

      return ok(res, { request, cardId, response: respData }, 201);
    } catch (e: any) {
      const { status, message } = normalizeError(e);
      request.status = "declined";
      request.decisionReason = message || "Card request failed";
      request.responseData = undefined;
      await request.save();
      notifyCardRequestDeclined(request.userId, request.decisionReason).catch(() => {});
      return fail(res, request.decisionReason, status);
    }
  } catch (err: any) {
    const message = err?.errors?.[0]?.message || err?.message || "Invalid payload";
    return fail(res, message, 400);
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
      const last4 = r.cardNumber ? r.cardNumber.slice(-4) : undefined;
      return {
        ...r,
        userName: fullName,
        customerEmail: r.customerEmail || user?.customerEmail,
        hasActiveCard: Boolean(activeCard),
        activeCardId: activeCard?.cardId,
        activeCardLast4: activeCard?.last4,
        last4,
      };
    });

    return ok(res, { requests: enriched });
  } catch (err: any) {
    const message = err?.message || "Failed to load requests";
    return fail(res, message, 400);
  }
});

router.post("/:id/sync-card", requireAdmin, async (req, res) => {
  try {
    const id = String(req.params.id);
    const cardIdOverride = asString(req.body?.cardId);
    const request = await CardRequest.findById(id).lean();
    if (!request) return fail(res, "Card request not found", 404);

    const respData = request.responseData as any;
    const extracted = extractCardInfo(respData);
    const cardId = cardIdOverride || request.cardId || extracted.cardId;
    if (!cardId) return fail(res, "cardId is missing on this request", 400);

    const cardNumber = request.cardNumber || extracted.cardNumber;
    const last4 = cardNumber ? String(cardNumber).slice(-4) : undefined;
    let status = extractCardStatus(respData) || "pending";
    let currency: string | undefined;
    let balance: any;
    let availableBalance: any;
    try {
      const detailResp = await fetchCardDetail(String(cardId), normalizeMode(request.mode));
      const detail = detailResp?.data ?? detailResp;
      status = extractCardStatus(detail) || status;
      currency = detail?.currency || detail?.ccy;
      balance = detail?.balance || detail?.available_balance;
      availableBalance = detail?.available_balance;
    } catch (e) {
      // Non-fatal: keep existing status if upstream fetch fails.
    }

    await CardRequest.findByIdAndUpdate(id, {
      $set: {
        status: "approved",
        cardId,
        cardNumber: cardNumber || undefined,
        cvc: request.cvc || extracted.cvc,
      },
    });

    await Card.findOneAndUpdate(
      { cardId: String(cardId) },
      {
        $set: {
          cardId: String(cardId),
          userId: request.userId,
          customerEmail: request.customerEmail,
          nameOnCard: request.nameOnCard,
          cardType: request.cardType,
          status,
          last4,
          currency,
          balance,
          availableBalance,
        },
      },
      { upsert: true, new: true }
    );

    if (request.userId) {
      await TelegramLink.findOneAndUpdate(
        { chatId: Number(request.userId) },
        { $addToSet: { cardIds: String(cardId) }, $setOnInsert: { customerEmail: request.customerEmail } },
        { upsert: true }
      );
      notifyCardRequestApproved(request.userId, {
        cardId: String(cardId),
        cardType: request.cardType,
        nameOnCard: request.nameOnCard,
        raw: respData,
      }).catch(() => {});
    }

    return ok(res, { cardId: String(cardId), synced: true });
  } catch (err: any) {
    const message = err?.message || "Failed to sync card";
    return fail(res, message, 400);
  }
});

router.post("/:id/approve", requireAdmin, async (_req, res) => {
  return fail(res, "Admin approval is disabled. StroWallet auto-approves.", 405);
});

router.post("/:id/decline", requireAdmin, async (_req, res) => {
  return fail(res, "Admin decline is disabled. StroWallet auto-approves.", 405);
});

export default router;
