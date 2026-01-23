"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateTelebirrTransaction = validateTelebirrTransaction;
exports.validateCBETransaction = validateCBETransaction;
exports.transformAccountNumber = transformAccountNumber;
const axios_1 = __importDefault(require("axios"));
const https_1 = __importDefault(require("https"));
const cbe_verifier_custom_1 = require("cbe-verifier-custom");
const paymentVerification_1 = require("./paymentVerification");
function getHttpClient() {
    const baseURL = process.env.PAYMENT_VALIDATION_BASE_URL || "https://ex.pro.et";
    const bearer = process.env.PAYMENT_VALIDATION_STATIC_TOKEN || process.env.PAYMENT_VALIDATION_TOKEN;
    const apiKey = process.env.PAYMENT_VALIDATION_API_KEY;
    const apiKeyHeader = process.env.PAYMENT_VALIDATION_API_KEY_HEADER || "x-api-key";
    const headers = {
        Accept: "*/*",
        "User-Agent": "TelegramBotValidator/1.0",
        "Content-Type": "application/json",
        Connection: "keep-alive",
    };
    if (bearer)
        headers.Authorization = `Bearer ${bearer}`;
    if (apiKey)
        headers[apiKeyHeader] = apiKey;
    const allowInsecure = String(process.env.PAYMENT_VALIDATION_ALLOW_INSECURE || "false").toLowerCase() === "true";
    return axios_1.default.create({
        baseURL,
        timeout: 60000,
        headers,
        httpsAgent: new https_1.default.Agent({ rejectUnauthorized: !allowInsecure }),
    });
}
function logProvider(url, status, data) {
    try {
        const preview = typeof data === "string" ? data : JSON.stringify(data).slice(0, 500);
        console.log("[payment-validation]", { url, status, body: preview });
    }
    catch {
        console.log("[payment-validation]", { url, status, body: "<unserializable>" });
    }
}
function getPaymentSettings(method) {
    if (method === "telebirr") {
        const telebirrPhoneNumber = process.env.TELEBIRR_PHONE_NUMBER;
        if (!telebirrPhoneNumber)
            return null;
        return { telebirrPhoneNumber };
    }
    const cbeAccountNumber = process.env.CBE_ACCOUNT_NUMBER;
    const cbeReceiverName = process.env.CBE_RECEIVER_NAME;
    if (!cbeAccountNumber || !cbeReceiverName)
        return null;
    return { cbeAccountNumber, cbeReceiverName };
}
// --- Telebirr ---
async function validateTelebirrTransaction(transactionNumber) {
    const normalizedTxn = extractTransactionId(transactionNumber);
    const result = await (0, paymentVerification_1.runTelebirrVerificationStandalone)(normalizedTxn);
    if (result.body.success) {
        const transactionDetails = result.body.raw?.transactionDetails || result.body.raw?.data || result.body.raw || {};
        return {
            success: true,
            message: result.body.message,
            transactionDetails,
        };
    }
    return { success: false, message: result.body.message };
}
function normalizeTelebirr(data) {
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
async function validateCBETransaction(transactionNumber) {
    const normalizedTxn = extractTransactionId(transactionNumber);
    if (!normalizedTxn)
        return { success: false, message: "CBE transaction number is required" };
    const accountNumber = sanitizeCbeAccountNumber(process.env.CBE_ACCOUNT_NUMBER);
    const timeoutMs = parseTimeout(process.env.CBE_VERIFICATION_TIMEOUT_MS);
    const cbeVerificationUrl = process.env.CBE_VERIFICATION_URL;
    try {
        const outcome = await (0, cbe_verifier_custom_1.verify)({
            transactionId: normalizedTxn,
            accountNumberOfSenderOrReceiver: accountNumber,
            cbeVerificationUrl,
            timeoutMs,
        });
        if (outcome.isLeft && outcome.isLeft()) {
            return mapLegacyCbeFailure(outcome.extract());
        }
        const detail = outcome.extract();
        return mapLegacyCbeSuccess(detail, normalizedTxn);
    }
    catch (err) {
        const message = err?.message || "CBE validation failed";
        return { success: false, message };
    }
}
// Accept plain txn or URL with ?id=
function extractTransactionId(raw) {
    if (!raw)
        return "";
    const trimmed = raw.trim();
    try {
        const url = new URL(trimmed);
        const fromQuery = url.searchParams.get("id");
        if (fromQuery)
            return fromQuery;
        const parts = url.pathname.split("/").filter(Boolean);
        if (parts.length)
            return parts[parts.length - 1];
    }
    catch {
        // Not a URL
    }
    const match = trimmed.match(/id=([^&\s]+)/i);
    if (match?.[1])
        return match[1];
    return trimmed;
}
function normalizeCBE(data) {
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
function normalizeVerifier(data) {
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
function transformAccountNumber(accountNumber) {
    return accountNumber.replace(/^1+0*/, "");
}
function normalizeError(err, fallback) {
    const message = err?.response?.data?.message || err?.message || fallback;
    return { success: false, message };
}
function shouldRetryPath(err) {
    const code = err?.code;
    const status = err?.response?.status;
    return code === "ECONNREFUSED" || code === "ENOTFOUND" || status === 404;
}
function mapLegacyCbeSuccess(detail, transactionNumber) {
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
function mapLegacyCbeFailure(failure) {
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
function sanitizeCbeAccountNumber(accountNumber) {
    const trimmed = accountNumber?.trim();
    if (!trimmed)
        return undefined;
    return /^1000\d{9}$/.test(trimmed) ? trimmed : undefined;
}
function parseTimeout(raw) {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : undefined;
}
