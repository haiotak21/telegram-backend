import { WebhookEvent } from "../models/WebhookEvent";
import Card from "../models/Card";
import CardRequest from "../models/CardRequest";
import { TelegramLink } from "../models/TelegramLink";
import Transaction from "../models/Transaction";
import User from "../models/User";
import Customer from "../models/Customer";
import { notifyByCardId, notifyByEmail, notifyCardStatusChanged, notifyKycStatus } from "./botService";

function extractField(obj: any, keys: string[]): string | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  for (const key of keys) {
    if (obj[key]) return String(obj[key]);
  }
  for (const val of Object.values(obj)) {
    const v = typeof val === "object" ? extractField(val, keys) : undefined;
    if (v) return v;
  }
  return undefined;
}

export async function processStroWalletEvent(payload: any) {
  const eventId = String(payload?.id || payload?.eventId || "");
  const type = String(payload?.type || "unknown");
  const created = typeof payload?.created === "number" ? payload.created : undefined;

  if (!eventId) {
    // store anyway using random to avoid collisions
    console.warn("Webhook missing event id; storing with generated id");
  }

  // de-duplicate
  try {
    await WebhookEvent.create({ eventId: eventId || `${Date.now()}-${Math.random()}`, type, created, payload });
  } catch (e: any) {
    if (String(e?.message || "").includes("duplicate key")) {
      return; // already processed
    }
    throw e;
  }

  const cardId = extractField(payload, ["card_id", "cardId", "id", "card"]);
  const customerEmail = extractField(payload, ["customerEmail", "email"]);
  const customerId = extractField(payload, ["customerId", "customer_id", "cardholderId", "card_holder_id"]);
  const kycStatus = normalizeKycStatus(extractField(payload, [
    "kycStatus",
    "status",
    "verificationStatus",
    "state",
    "kyc_state",
  ]));

  const message = formatMessage(type, payload);

  if (cardId) await notifyByCardId(cardId, message);
  if (customerEmail) await notifyByEmail(customerEmail, message);

  if (kycStatus && (customerId || customerEmail)) {
    const existing = await Customer.findOne({
      $or: [
        ...(customerId ? [{ customerId }] : []),
        ...(customerEmail ? [{ email: customerEmail }] : []),
      ],
    }).lean();

    let userId = existing?.userId;
    if (!userId && (customerId || customerEmail)) {
      const user = await User.findOne({
        $or: [
          ...(customerId ? [{ strowalletCustomerId: customerId }] : []),
          ...(customerEmail ? [{ customerEmail }] : []),
        ],
      }).lean();
      userId = user?.userId;
    }

    if (userId) {
      await Customer.findOneAndUpdate(
        { userId },
        {
          $set: {
            customerId: customerId || existing?.customerId,
            email: customerEmail || existing?.email,
            kycStatus,
            approvedAt: kycStatus === "approved" ? new Date() : undefined,
          },
        },
        { upsert: true, new: true }
      );

      await User.findOneAndUpdate(
        { userId },
        { $set: { kycStatus } },
        { new: true }
      );

      await notifyKycStatus(userId, kycStatus as any).catch(() => {});
    }
  }

  if (type === "card.created" && cardId) {
    const data = payload?.data || payload;
    const userId = await resolveUserId(customerEmail, cardId);
    await Card.findOneAndUpdate(
      { cardId },
      {
        $set: {
          cardId,
          customerEmail: customerEmail || data?.customerEmail,
          userId: userId || undefined,
          nameOnCard: data?.name_on_card || data?.nameOnCard || data?.name,
          cardType: data?.card_type || data?.cardType || data?.brand,
          status: data?.status || data?.state || "active",
          last4: data?.last4 || data?.card_last4 || data?.cardLast4,
          currency: data?.currency || data?.ccy,
          balance: data?.balance || data?.available_balance,
          availableBalance: data?.available_balance,
          lastSync: new Date(),
        },
      },
      { upsert: true, new: true }
    );

    if (userId) {
      const chatId = Number(userId);
      if (Number.isFinite(chatId)) {
        await TelegramLink.findOneAndUpdate(
          { chatId },
          { $addToSet: { cardIds: cardId }, ...(customerEmail ? { $set: { customerEmail } } : {}) },
          { upsert: true, new: true }
        );
      }
    }

    if (customerEmail) {
      await TelegramLink.findOneAndUpdate(
        { customerEmail },
        { $addToSet: { cardIds: cardId } },
        { upsert: true, new: true }
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
  }

  if ((type === "card.frozen" || type === "card.unfrozen" || type === "card.unfreeze") && cardId) {
    const nextStatus = type === "card.frozen" ? "frozen" : "active";
    await Card.findOneAndUpdate(
      { cardId },
      { $set: { status: nextStatus, lastSync: new Date() } },
      { upsert: true, new: true }
    );
    await notifyCardStatusChanged(cardId, nextStatus as any).catch(() => {});
  }

  if (type === "card.funded" && cardId) {
    const data = payload?.data || payload;
    const amountRaw = extractField(payload, ["amount", "transactionAmount", "total", "value"]);
    const amount = amountRaw ? Number(amountRaw) : undefined;
    const currency = extractField(payload, ["currency", "ccy", "iso_currency"]);
    const card = await Card.findOneAndUpdate(
      { cardId },
      {
        $set: {
          balance: data?.balance || data?.available_balance || data?.availableBalance || undefined,
          availableBalance: data?.available_balance || data?.availableBalance || undefined,
          currency: currency || data?.currency || data?.ccy,
          lastSync: new Date(),
        },
      },
      { new: true }
    );
    if (amount != null && card?.userId) {
      await User.findOneAndUpdate(
        { userId: card.userId },
        { $inc: { balance: amount } },
        { new: true }
      );

      const last4 = card.last4 ? `**** ${card.last4}` : undefined;
      const balanceValue = data?.balance || data?.available_balance || data?.availableBalance;
      const amountLabel = amount.toFixed(2);
      const lines = [
        "💳 Card Funded",
        `Amount: - $${amountLabel}`,
        "From Wallet",
        last4 ? `Card: ${last4}` : undefined,
        balanceValue != null ? `Wallet Balance: $${Number(balanceValue).toFixed(2)}` : undefined,
      ].filter(Boolean) as string[];
      await notifyByCardId(cardId, lines.join("\n")).catch(() => {});
    }
  }

  if (type === "transaction.posted" && cardId) {
    const data = payload?.data || payload;
    const amountRaw = extractField(payload, ["amount", "transactionAmount", "total", "value"]);
    const amountValue = amountRaw ? Number(amountRaw) : undefined;
    const description = extractField(payload, ["description", "merchant", "merchant_name", "narration", "narrative"]);
    const statusRaw = extractField(payload, ["status", "result", "state"]);
    const status = normalizeTxnStatus(statusRaw);
    const txnId = extractField(payload, ["transactionId", "transaction_id", "id", "eventId", "ref"]);
    const directionRaw = extractField(payload, ["direction", "type", "transaction_type", "drCr"]);
    const direction = normalizeDirection(directionRaw, amountValue);

    const card = await Card.findOne({ cardId }).lean();
    const userId = card?.userId || (await resolveUserId(customerEmail || card?.customerEmail, cardId));

    if (userId && amountValue != null) {
      await Transaction.findOneAndUpdate(
        { userId, transactionType: "card", transactionNumber: txnId || `${eventId}-${cardId}` },
        {
          $set: {
            userId,
            transactionType: "card",
            paymentMethod: "strowallet",
            amount: Math.abs(amountValue),
            currency: extractField(payload, ["currency", "ccy", "iso_currency"]) || "USD",
            status,
            transactionNumber: txnId || undefined,
            metadata: {
              cardId,
              direction,
              description,
              rawStatus: statusRaw,
            },
            responseData: data,
          },
        },
        { upsert: true, new: true }
      );

      const last4 = card?.last4 ? `**** ${card.last4}` : undefined;
      const amountLabel = `${direction === "debit" ? "-" : "+"} $${Math.abs(amountValue).toFixed(2)}`;
      const title = status === "failed" ? "❌ Payment Failed" : "💳 Payment Completed";
      const remaining = extractField(payload, ["cardBalanceAfter", "balance", "available_balance", "availableBalance"]);
      const reason = status === "failed" ? extractField(payload, ["reason", "declineReason", "message"]) : undefined;
      const lines = [
        title,
        description ? `Merchant: ${description}` : undefined,
        `Amount: ${amountLabel}`,
        last4 ? `Card: ${last4}` : undefined,
        remaining != null ? `Remaining Card Balance: $${Number(remaining).toFixed(2)}` : undefined,
        reason ? `Reason: ${reason}` : undefined,
      ].filter(Boolean) as string[];
      await notifyByCardId(cardId, lines.join("\n")).catch(() => {});
    }
  }
}

function normalizeKycStatus(value?: string): "pending" | "approved" | "rejected" | undefined {
  if (!value) return undefined;
  const v = value.toLowerCase();
  if (["approved", "verified", "success", "active", "high kyc"].includes(v)) return "approved";
  if (["pending", "processing", "review", "unreview kyc"].includes(v)) return "pending";
  if (["declined", "rejected", "failed", "low kyc"].includes(v)) return "rejected";
  return undefined;
}

async function resolveUserId(customerEmail?: string, cardId?: string) {
  if (cardId) {
    const card = await Card.findOne({ cardId }).lean();
    if (card?.userId) return card.userId;
  }
  if (customerEmail) {
    const customer = await Customer.findOne({ email: customerEmail }).lean();
    if (customer?.userId) return customer.userId;
  }
  if (customerEmail) {
    const link = await TelegramLink.findOne({ customerEmail }).lean();
    if (link?.chatId != null) return String(link.chatId);
  }
  if (customerEmail) {
    const user = await User.findOne({ customerEmail }).lean();
    if (user?.userId) return user.userId;
  }
  return undefined;
}

function normalizeTxnStatus(raw?: string) {
  const v = (raw || "").toLowerCase();
  if (v.includes("fail") || v.includes("decline") || v.includes("deny")) return "failed";
  if (v.includes("pending") || v.includes("review")) return "pending";
  return "completed";
}

function normalizeDirection(raw?: string, amount?: number) {
  const v = (raw || "").toLowerCase();
  if (v.includes("debit") || v.includes("out") || v.includes("dr")) return "debit";
  if (v.includes("credit") || v.includes("in") || v.includes("cr")) return "credit";
  if (amount != null) return amount < 0 ? "debit" : "credit";
  return "debit";
}

function formatMessage(type: string, payload: any) {
  try {
    if (type === "card.frozen") {
      const last4 = extractField(payload, ["last4", "cardLast4", "card_last4", "cardSuffix"]);
      return `❌ Your card ${last4 ? `••••${last4}` : ""} has been frozen.`.trim();
    }
    if (type === "card.unfrozen" || type === "card.unfreeze") {
      const last4 = extractField(payload, ["last4", "cardLast4", "card_last4", "cardSuffix"]);
      return `✅ Your card ${last4 ? `••••${last4}` : ""} is active again.`.trim();
    }
    const transactionId = extractField(payload, ["transactionId", "transaction_id", "id", "eventId", "ref"]);
    const scene = extractField(payload, ["scene", "category", "type"]);
    const transaction = extractField(payload, ["transaction", "description", "merchant", "merchant_name", "narration"]);
    const amountRaw = extractField(payload, ["amount", "transactionAmount", "total", "value"]);
    const preauthRaw = extractField(payload, ["preAuthorizationAmount", "preauth", "preAuthAmount", "pre_authorization_amount"]);
    const currency = extractField(payload, ["currency", "ccy", "iso_currency"]) || "USD";
    const declineReason = extractField(payload, ["declineReason", "reason", "message"]);
    const statusRaw = extractField(payload, ["status", "result", "state"]) || type;
    const createdRaw = extractField(payload, ["created", "created_at", "timestamp", "time"]);
    const cardBrand = extractField(payload, ["brand", "cardBrand", "card_type"]);
    const last4 = extractField(payload, ["last4", "cardLast4", "card_last4", "cardSuffix", "card_id", "cardId"]);

    const amount = formatAmount(amountRaw, currency);
    const preauth = formatAmount(preauthRaw, currency);
    const status = normalizeStatus(statusRaw);
    const statusIcon = status.tag === "declined" ? "❌" : status.tag === "approved" ? "✅" : "⏳";
    const cardLine = `Your ${cardBrand || "card"}${last4 ? `(${last4})` : ""} card just made a new move!`;
    const dateTime = formatDateTime(createdRaw);

    const lines = [
      "Card Transaction Alert ⏰",
      "",
      cardLine,
      "",
      transactionId ? `🆔 Transaction ID: ${transactionId}` : undefined,
      scene ? `🧾 Scene: ${scene}` : undefined,
      transaction ? `🛍️ Transaction: ${transaction}` : undefined,
      amount ? `💸 Amount: ${amount}` : undefined,
      preauth ? `💳 Pre-authorization Amount: ${preauth}` : undefined,
      status.tag === "declined" && declineReason ? `❌ Decline Reason: ${declineReason}` : declineReason ? `ℹ️ Note: ${declineReason}` : undefined,
      dateTime ? `🕒 Date & Time: ${dateTime}` : undefined,
      `${statusIcon} Status: ${status.label}`,
    ].filter(Boolean) as string[];

    return lines.join("\n");
  } catch {
    return `StroWallet: ${type}`;
  }
}

function formatAmount(value: string | undefined, currency: string) {
  if (!value) return undefined;
  const numeric = Number(value);
  if (!Number.isNaN(numeric) && Number.isFinite(numeric)) {
    return `${numeric.toFixed(2)}${currency ? currency : ""}`.replace(/\s+/, " ");
  }
  return `${value}${currency ? ` ${currency}` : ""}`.trim();
}

function formatDateTime(raw: string | undefined) {
  if (!raw) return undefined;
  const asNum = Number(raw);
  const date = Number.isFinite(asNum)
    ? new Date(asNum < 1_000_000_000_000 ? asNum * 1000 : asNum)
    : new Date(raw);
  if (isNaN(date.getTime())) return undefined;
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${yyyy}/${mm}/${dd} ${hh}:${mi}:${ss}`;
}

function normalizeStatus(raw: string) {
  const v = (raw || "").toString();
  const lower = v.toLowerCase();
  if (lower.includes("decline") || lower.includes("fail") || lower.includes("deny")) {
    return { tag: "declined" as const, label: v.toUpperCase() || "DECLINED" };
  }
  if (lower.includes("success") || lower.includes("approved") || lower.includes("complete")) {
    return { tag: "approved" as const, label: v.toUpperCase() || "APPROVED" };
  }
  if (lower.includes("pending") || lower.includes("review")) {
    return { tag: "pending" as const, label: v.toUpperCase() || "PENDING" };
  }
  return { tag: "unknown" as const, label: v ? v.toUpperCase() : "UNKNOWN" };
}
