import axios from "axios";
import https from "https";
import { verify as verifyCbeCustom, TransactionDetail as CbeTransactionDetail, VerifyFailure as CbeVerifyFailure } from "cbe-verifier-custom";
import { runTelebirrVerificationStandalone } from "./paymentVerification";

export type LegacyPaymentMethod = "telebirr" | "cbe";

function getHttpClient() {
  const baseURL = process.env.PAYMENT_VALIDATION_BASE_URL || "https://ex.pro.et";
  const bearer = process.env.PAYMENT_VALIDATION_STATIC_TOKEN || process.env.PAYMENT_VALIDATION_TOKEN;
  const apiKey = process.env.PAYMENT_VALIDATION_API_KEY;
  const apiKeyHeader = process.env.PAYMENT_VALIDATION_API_KEY_HEADER || "x-api-key";

  const headers: Record<string, string> = {
    Accept: "*/*",
    "User-Agent": "TelegramBotValidator/1.0",
    "Content-Type": "application/json",
    Connection: "keep-alive",
  };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (apiKey) headers[apiKeyHeader] = apiKey;

  const allowInsecure = String(process.env.PAYMENT_VALIDATION_ALLOW_INSECURE || "false").toLowerCase() === "true";

  return axios.create({
    baseURL,
    timeout: 60000,
    headers,
    httpsAgent: new https.Agent({ rejectUnauthorized: !allowInsecure }),
  });
}

function logProvider(url: string, status: number | undefined, data: any) {
  try {
    const preview = typeof data === "string" ? data : JSON.stringify(data).slice(0, 500);
    console.log("[payment-validation]", { url, status, body: preview });
  } catch {
    console.log("[payment-validation]", { url, status, body: "<unserializable>" });
  }
}

interface PaymentSettings {
  telebirrPhoneNumber?: string;
  cbeAccountNumber?: string;
  cbeReceiverName?: string;
}

function getPaymentSettings(method: LegacyPaymentMethod): PaymentSettings | null {
  if (method === "telebirr") {
    const telebirrPhoneNumber = process.env.TELEBIRR_PHONE_NUMBER;
    if (!telebirrPhoneNumber) return null;
    return { telebirrPhoneNumber };
  }
  const cbeAccountNumber = process.env.CBE_ACCOUNT_NUMBER;
  const cbeReceiverName = process.env.CBE_RECEIVER_NAME;
  if (!cbeAccountNumber || !cbeReceiverName) return null;
  return { cbeAccountNumber, cbeReceiverName };
}

// --- Telebirr ---
export async function validateTelebirrTransaction(transactionNumber: string) {
  const normalizedTxn = extractTransactionId(transactionNumber);
  const result = await runTelebirrVerificationStandalone(normalizedTxn);
  if (result.body.success) {
    const transactionDetails = (result.body.raw as any)?.transactionDetails || (result.body.raw as any)?.data || result.body.raw || {};
    return {
      success: true,
      message: result.body.message,
      transactionDetails,
    };
  }
  return { success: false, message: result.body.message };
}

function normalizeTelebirr(data: any) {
  if (data?.success && data?.transactionDetails) {
    return {
      success: true,
      message: data?.message || "Transaction validated successfully",
      transactionDetails: data.transactionDetails,
    };
  }
  return {
    success: false,
    message: data?.message || "Transaction validation failed",
  };
}

// --- CBE ---
export async function validateCBETransaction(transactionNumber: string) {
  const normalizedTxn = extractTransactionId(transactionNumber);
  if (!normalizedTxn) return { success: false, message: "CBE transaction number is required" };

  const accountNumber = sanitizeCbeAccountNumber(process.env.CBE_ACCOUNT_NUMBER);
  const timeoutMs = parseTimeout(process.env.CBE_VERIFICATION_TIMEOUT_MS);
  const cbeVerificationUrl = process.env.CBE_VERIFICATION_URL;

  try {
    const outcome = await verifyCbeCustom({
      transactionId: normalizedTxn,
      accountNumberOfSenderOrReceiver: accountNumber,
      cbeVerificationUrl,
      timeoutMs,
    });

    if ((outcome as any).isLeft && (outcome as any).isLeft()) {
      return mapLegacyCbeFailure((outcome as any).extract() as CbeVerifyFailure);
    }

    const detail = (outcome as any).extract() as CbeTransactionDetail;
    return mapLegacyCbeSuccess(detail, normalizedTxn);
  } catch (err: any) {
    const message = err?.message || "CBE validation failed";
    return { success: false, message };
  }
}

// Accept plain txn or URL with ?id=
function extractTransactionId(raw: string): string {
  if (!raw) return "";
  const trimmed = raw.trim();
  try {
    const url = new URL(trimmed);
    const fromQuery = url.searchParams.get("id");
    if (fromQuery) return fromQuery;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  } catch {
    // Not a URL
  }
  const match = trimmed.match(/id=([^&\s]+)/i);
  if (match?.[1]) return match[1];
  return trimmed;
}

function normalizeCBE(data: any) {
  if (data?.success && data?.transactionDetails) {
    return {
      success: true,
      message: data?.message || "Transaction validated successfully",
      transactionDetails: data.transactionDetails,
    };
  }
  return {
    success: false,
    message: data?.message || "Transaction validation failed",
  };
}

function normalizeVerifier(data: any) {
  const success = Boolean(data?.success ?? data?.data?.success);
  if (success) {
    return {
      success: true,
      message: data?.message || "Transaction validated successfully",
      transactionDetails: data?.data || data?.transactionDetails,
    };
  }
  return {
    success: false,
    message: data?.message || "Transaction validation failed",
  };
}

export function transformAccountNumber(accountNumber: string) {
  return accountNumber.replace(/^1+0*/, "");
}

function normalizeError(err: any, fallback: string) {
  const message = err?.response?.data?.message || err?.message || fallback;
  return { success: false, message };
}

function shouldRetryPath(err: any) {
  const code = err?.code;
  const status = err?.response?.status;
  return code === "ECONNREFUSED" || code === "ENOTFOUND" || status === 404;
}

function mapLegacyCbeSuccess(detail: CbeTransactionDetail, transactionNumber: string) {
  return {
    success: true,
    message: "Transaction validated successfully",
    transactionDetails: {
      reference: detail.reference || transactionNumber,
      amount: detail.amount,
      payer: detail.payer,
      receiver: detail.receiver,
      payerAccount: detail.payerAccount,
      receiverAccount: detail.receiverAccount,
      reason: detail.reason,
      date: detail.date,
      fullText: detail.fullText,
    },
  };
}

function mapLegacyCbeFailure(failure: CbeVerifyFailure) {
  switch (failure.type) {
    case "INVALID_TRANSACTION_ID":
      return { success: false, message: "Invalid transaction id" };
    case "INVALID_ACCOUNT_NO":
      return { success: false, message: "Invalid CBE account number" };
    case "TRANSACTION_NOT_FOUND":
      return { success: false, message: "Transaction not found" };
    case "API_REQUEST_FAILED":
    default:
      return { success: false, message: failure.message || "CBE validation failed" };
  }
}

function sanitizeCbeAccountNumber(accountNumber?: string | null): string | undefined {
  const trimmed = accountNumber?.trim();
  if (!trimmed) return undefined;
  return /^1000\d{9}$/.test(trimmed) ? trimmed : undefined;
}

function parseTimeout(raw?: string) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

