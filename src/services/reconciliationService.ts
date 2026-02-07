import axios, { AxiosError } from "axios";
import Card from "../models/Card";
import Transaction from "../models/Transaction";
import CardReconciliation from "../models/CardReconciliation";
import User from "../models/User";
import { notifyUserBalanceReconciled } from "./botService";

const BITVCARD_BASE = "https://strowallet.com/api/bitvcard/";

function requirePublicKey() {
  const key = process.env.STROWALLET_PUBLIC_KEY;
  if (!key) {
    const err = new Error("Missing STROWALLET_PUBLIC_KEY env");
    (err as any).status = 500;
    throw err;
  }
  return key;
}

function normalizeMode(mode?: string) {
  if (!mode) return undefined;
  const m = String(mode).toLowerCase();
  if (m === "live") return undefined;
  return m;
}

function getDefaultMode() {
  return process.env.STROWALLET_DEFAULT_MODE || (process.env.NODE_ENV !== "production" ? "sandbox" : undefined);
}

function parseBalance(value: any): number | undefined {
  if (value == null) return undefined;
  const num = Number(value);
  if (!Number.isFinite(num)) return undefined;
  return num;
}

function extractBalance(detail: any): number | undefined {
  return (
    parseBalance(detail?.balance) ??
    parseBalance(detail?.available_balance) ??
    parseBalance(detail?.availableBalance) ??
    parseBalance(detail?.data?.balance) ??
    parseBalance(detail?.data?.available_balance)
  );
}

function extractCurrency(detail: any): string | undefined {
  return detail?.currency || detail?.ccy || detail?.iso_currency || detail?.data?.currency || detail?.data?.ccy;
}

function extractTransactions(payload: any): any[] {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  const candidates = [
    payload?.data?.transactions,
    payload?.data?.data,
    payload?.data,
    payload?.transactions,
    payload?.response?.transactions,
    payload?.response?.data,
  ];
  for (const c of candidates) {
    if (Array.isArray(c)) return c;
  }
  return [];
}

function normalizeTxnStatus(raw?: string) {
  const v = (raw || "").toLowerCase();
  if (v.includes("fail") || v.includes("decline") || v.includes("deny")) return "failed";
  if (v.includes("pending") || v.includes("review")) return "pending";
  return "completed";
}

function normalizeTxnDirection(raw?: string, amount?: number) {
  const v = (raw || "").toLowerCase();
  if (v.includes("debit") || v.includes("out") || v.includes("dr")) return "debit";
  if (v.includes("credit") || v.includes("in") || v.includes("cr")) return "credit";
  if (amount != null) return amount < 0 ? "debit" : "credit";
  return "debit";
}

function normalizeTxnItem(item: any) {
  const amountRaw = item?.amount ?? item?.transactionAmount ?? item?.total ?? item?.value;
  const amount = amountRaw != null && !Number.isNaN(Number(amountRaw)) ? Number(amountRaw) : undefined;
  const description = item?.description || item?.merchant || item?.merchant_name || item?.narration;
  const currency = item?.currency || item?.ccy || item?.iso_currency;
  const statusRaw = item?.status || item?.state || item?.result;
  const txnId = item?.transactionId || item?.transaction_id || item?.id || item?.ref || item?.reference;
  const directionRaw = item?.direction || item?.type || item?.transaction_type || item?.drCr;
  const direction = normalizeTxnDirection(directionRaw, amount);
  return {
    transactionNumber: txnId ? String(txnId) : undefined,
    amount,
    currency,
    description,
    status: normalizeTxnStatus(statusRaw),
    direction,
  };
}

function buildTxnKey(entry: { transactionNumber?: string; amount?: number; currency?: string; description?: string }) {
  if (entry.transactionNumber) return `id:${entry.transactionNumber}`;
  const amount = entry.amount != null ? Number(entry.amount).toFixed(2) : "na";
  return `h:${amount}|${entry.currency || ""}|${entry.description || ""}`;
}

async function fetchCardDetail(cardId: string, mode?: string) {
  const public_key = requirePublicKey();
  const payload = { card_id: cardId, public_key, mode: normalizeMode(mode ?? getDefaultMode()) };
  const resp = await axios.post(`${BITVCARD_BASE}fetch-card-detail/`, payload, { timeout: 15000 });
  return resp.data;
}

async function fetchCardTransactions(cardId: string, mode?: string) {
  const public_key = requirePublicKey();
  const payload = { card_id: cardId, public_key, mode: normalizeMode(mode ?? getDefaultMode()) };
  const resp = await axios.post(`${BITVCARD_BASE}card-transactions/`, payload, { timeout: 15000 });
  return resp.data;
}

function normalizeError(e: any) {
  if (axios.isAxiosError(e)) {
    const ae = e as AxiosError<any>;
    const status = ae.response?.status ?? 400;
    const payload = ae.response?.data as any;
    const msg = payload?.message || payload?.error || ae.message || "Request failed";
    return { status, message: String(msg), data: payload };
  }
  const status = e?.status ?? 400;
  const msg = e?.message ?? "Request error";
  return { status, message: String(msg) };
}

export async function reconcileCard(cardId: string, options?: { mode?: string; notify?: boolean }) {
  const card = await Card.findOne({ cardId });
  if (!card) {
    const err: any = new Error("Card not found");
    err.status = 404;
    throw err;
  }

  const detail = await fetchCardDetail(cardId, options?.mode);
  const data = (detail as any)?.data ?? detail;
  const externalBalance = extractBalance(data);
  const externalCurrency = extractCurrency(data);
  const localBalance = parseBalance(card.balance);

  const mismatch =
    externalBalance != null &&
    (localBalance == null || Math.abs(externalBalance - localBalance) > 0.0001);

  if (externalBalance != null && mismatch) {
    card.balance = String(externalBalance);
    if (externalCurrency) card.currency = externalCurrency;
    card.lastSync = new Date();
    await card.save();
    if (options?.notify !== false && card.userId) {
      await notifyUserBalanceReconciled(card.userId, card.cardId, externalBalance, externalCurrency || card.currency);
    }
  }

  const record = await CardReconciliation.create({
    cardId,
    userId: card.userId,
    customerEmail: card.customerEmail,
    localBalance: localBalance ?? undefined,
    externalBalance: externalBalance ?? undefined,
    discrepancy: Boolean(mismatch),
    checkedAt: new Date(),
    metadata: { currency: externalCurrency || card.currency, raw: data },
  });

  return {
    card,
    externalBalance,
    localBalance,
    mismatch: Boolean(mismatch),
    reconciliation: record,
  };
}

export async function auditCardTransactions(cardId: string, options?: { mode?: string }) {
  const card = await Card.findOne({ cardId }).lean();
  if (!card) {
    const err: any = new Error("Card not found");
    err.status = 404;
    throw err;
  }

  const external = await fetchCardTransactions(cardId, options?.mode);
  const externalItems = extractTransactions((external as any)?.data ?? external).map((item) => normalizeTxnItem(item));

  const local = await Transaction.find({ transactionType: "card", "metadata.cardId": cardId })
    .sort({ createdAt: -1 })
    .lean();

  const localEntries = local.map((t) => ({
    transactionNumber: t.transactionNumber || undefined,
    amount: t.amount,
    currency: t.currency,
    description: t.metadata?.description,
  }));

  const localKeys = new Set(localEntries.map((e) => buildTxnKey(e)));
  const externalKeys = new Set(externalItems.map((e) => buildTxnKey(e)));

  const missingLocal = externalItems.filter((e) => !localKeys.has(buildTxnKey(e)));
  const missingExternal = localEntries.filter((e) => !externalKeys.has(buildTxnKey(e)));

  return {
    cardId,
    externalCount: externalItems.length,
    localCount: localEntries.length,
    missingLocal,
    missingExternal,
  };
}

export async function reconcileAllCards(options?: { mode?: string; notify?: boolean; limit?: number }) {
  const query = { status: { $in: ["active", "ACTIVE", "frozen", "FROZEN"] } } as any;
  const cards = await Card.find(query)
    .sort({ updatedAt: -1 })
    .limit(options?.limit || 500)
    .lean();

  const results = [] as any[];
  for (const c of cards) {
    try {
      const rec = await reconcileCard(c.cardId, options);
      results.push({ cardId: c.cardId, mismatch: rec.mismatch });
    } catch (e: any) {
      const err = normalizeError(e);
      results.push({ cardId: c.cardId, error: err.message });
    }
  }

  return results;
}

export async function getReconciliationSummary(limit = 50, mismatchOnly = false) {
  const query: any = mismatchOnly ? { discrepancy: true } : {};
  const items = await CardReconciliation.find(query)
    .sort({ checkedAt: -1 })
    .limit(limit)
    .lean();

  const cardIds = Array.from(new Set(items.map((i) => i.cardId).filter(Boolean)));
  const userIds = Array.from(new Set(items.map((i) => i.userId).filter(Boolean)));
  const [cards, users] = await Promise.all([
    Card.find({ cardId: { $in: cardIds } }).lean(),
    User.find({ userId: { $in: userIds } }).lean(),
  ]);
  const cardMap = new Map(cards.map((c) => [c.cardId, c]));
  const userMap = new Map(users.map((u) => [u.userId, u]));

  return items.map((i) => {
    const card = cardMap.get(i.cardId);
    const user = i.userId ? userMap.get(i.userId) : undefined;
    return {
      id: i._id,
      cardId: i.cardId,
      userId: i.userId,
      userName: user ? [user.firstName, user.lastName].filter(Boolean).join(" ") : undefined,
      email: i.customerEmail || card?.customerEmail,
      localBalance: i.localBalance,
      externalBalance: i.externalBalance,
      discrepancy: i.discrepancy,
      checkedAt: i.checkedAt,
    };
  });
}
