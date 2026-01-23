import { WebhookEvent } from "../models/WebhookEvent";
import { notifyByCardId, notifyByEmail } from "./botService";

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

  const message = formatMessage(type, payload);

  if (cardId) await notifyByCardId(cardId, message);
  if (customerEmail) await notifyByEmail(customerEmail, message);
}

function formatMessage(type: string, payload: any) {
  try {
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
