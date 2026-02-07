"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyPayment = verifyPayment;
exports.runTelebirrVerificationStandalone = runTelebirrVerificationStandalone;
const axios_1 = __importDefault(require("axios"));
const https_1 = __importDefault(require("https"));
const cbe_verifier_custom_1 = require("cbe-verifier-custom");
// Local Telebirr verifier (JS helpers)
const { fetchReceipt } = require("../../verifier/telebirr verify/src/fetch");
const { parseReceiptHTML } = require("../../verifier/telebirr verify/src/parser");
const { createReceiptVerifier } = require("../../verifier/telebirr verify/src/index");
function loadConfig() {
    const baseUrl = process.env.PAYMENT_VALIDATION_BASE_URL;
    const token = process.env.PAYMENT_VALIDATION_TOKEN || process.env.PAYMENT_VALIDATION_STATIC_TOKEN;
    const apiKey = process.env.PAYMENT_VALIDATION_API_KEY;
    const apiKeyHeader = process.env.PAYMENT_VALIDATION_API_KEY_HEADER || "x-api-key";
    const providerEnv = (process.env.PAYMENT_VALIDATION_PROVIDER || "").toLowerCase();
    const provider = providerEnv === "verifier" || (baseUrl && baseUrl.includes("verifyapi")) ? "verifier" : "legacy";
    const cbeVerifierStrategy = process.env.PAYMENT_VERIFIER_CBE_STRATEGY;
    const cbeFallbackBaseUrl = process.env.PAYMENT_VALIDATION_CBE_FALLBACK_BASE_URL || process.env.CBE_VALIDATION_BASE_URL;
    const allowInsecureTLS = String(process.env.PAYMENT_VALIDATION_ALLOW_INSECURE || "false").toLowerCase() === "true";
    const enableFakeValidation = String(process.env.PAYMENT_VALIDATION_FAKE || "false").toLowerCase() === "true";
    const fakeDefaultAmount = process.env.PAYMENT_VALIDATION_FAKE_AMOUNT ? Number(process.env.PAYMENT_VALIDATION_FAKE_AMOUNT) : undefined;
    const allowTokenless = String(process.env.PAYMENT_VALIDATION_ALLOW_TOKENLESS || "false").toLowerCase() === "true";
    const cbeAppendAccount = String(process.env.PAYMENT_CBE_APPEND_ACCOUNT || "true").toLowerCase() === "true";
    const cbeCustomPath = process.env.CBE_VALIDATE_PATH || process.env.PAYMENT_CBE_VALIDATE_PATH;
    const cbeCustomMethod = (process.env.CBE_VALIDATE_METHOD || "post").toLowerCase() === "get" ? "get" : "post";
    const cbeDisableVariants = String(process.env.PAYMENT_CBE_DISABLE_VARIANTS || "false").toLowerCase() === "true";
    if (!baseUrl) {
        const err = new Error("Missing PAYMENT_VALIDATION_BASE_URL env");
        err.status = 500;
        throw err;
    }
    // Only enforce token when not in fake mode and not in tokenless mode
    if (!token && !apiKey && !enableFakeValidation && !allowTokenless) {
        const err = new Error("Missing validator credentials (set PAYMENT_VALIDATION_API_KEY or PAYMENT_VALIDATION_TOKEN). For dev, set PAYMENT_VALIDATION_FAKE=true or PAYMENT_VALIDATION_ALLOW_TOKENLESS=true.");
        err.status = 500;
        throw err;
    }
    return {
        baseUrl,
        token,
        apiKey,
        apiKeyHeader,
        provider,
        telebirrPhoneNumber: process.env.TELEBIRR_PHONE_NUMBER,
        cbeAccountNumber: process.env.CBE_ACCOUNT_NUMBER,
        cbeReceiverName: process.env.CBE_RECEIVER_NAME,
        cbeVerifierStrategy,
        cbeFallbackBaseUrl,
        allowInsecureTLS,
        enableFakeValidation,
        fakeDefaultAmount,
        allowTokenless,
        cbeAppendAccount,
        cbeCustomPath,
        cbeCustomMethod,
        cbeDisableVariants,
    };
}
function buildHttpClient(config, forceInsecure = false) {
    const headers = {
        "Content-Type": "application/json",
        Accept: "*/*",
    };
    if (config.token)
        headers.Authorization = `Bearer ${config.token}`;
    if (config.apiKey)
        headers[config.apiKeyHeader] = config.apiKey;
    return axios_1.default.create({
        baseURL: config.baseUrl,
        timeout: 60000,
        headers,
        httpsAgent: new https_1.default.Agent({ rejectUnauthorized: forceInsecure ? false : !config.allowInsecureTLS }),
    });
}
function parseAmount(value) {
    if (!value)
        return undefined;
    const numeric = parseFloat(value);
    return Number.isFinite(numeric) ? numeric : undefined;
}
function normalizeTelebirrResponse(data, transactionNumber) {
    const success = Boolean(data?.success);
    if (!success || !data?.transactionDetails) {
        const message = data?.message || "Telebirr validation failed";
        return { status: 400, body: { success: false, message, raw: data } };
    }
    const amount = parseAmount(data.transactionDetails?.amount);
    const status = data.transactionDetails?.status;
    return {
        status: 200,
        body: {
            success: true,
            message: data?.message || "Verified",
            provider: "telebirr",
            transactionNumber,
            amount,
            currency: "ETB",
            status,
            raw: data,
        },
    };
}
function normalizeCbeResponse(data, transactionNumber) {
    const success = Boolean(data?.success);
    if (!success || !data?.transactionDetails) {
        const message = data?.message || "CBE validation failed";
        return { status: 400, body: { success: false, message, raw: data } };
    }
    const rawAmount = data.transactionDetails?.transferredAmount;
    const cleaned = rawAmount ? rawAmount.replace(/[^\d.-]/g, "") : undefined;
    const amount = parseAmount(cleaned);
    const status = data.transactionDetails?.status;
    return {
        status: 200,
        body: {
            success: true,
            message: data?.message || "Verified",
            provider: "cbe",
            transactionNumber,
            amount,
            currency: "ETB",
            status,
            raw: data,
        },
    };
}
function normalizeVerifierResponse(data, transactionNumber, provider) {
    const success = Boolean(data?.success ?? data?.data?.success);
    if (!success) {
        const message = data?.message || "Validation failed";
        return { status: 400, body: { success: false, message, raw: data } };
    }
    const amount = parseAmount(data?.data?.amount || data?.amount);
    const status = data?.data?.status || data?.status;
    const message = data?.message || "Verified";
    return {
        status: 200,
        body: {
            success: true,
            message,
            provider,
            transactionNumber,
            amount,
            currency: "ETB",
            status,
            raw: data,
        },
    };
}
function manualValidation(method, transactionNumber, amountHint) {
    const nowIso = new Date().toISOString();
    return {
        status: 200,
        body: {
            success: true,
            message: "Verified (fake mode)",
            provider: method,
            transactionNumber,
            amount: typeof amountHint === "number" ? amountHint : undefined,
            currency: "ETB",
            status: "completed",
            raw: {
                success: true,
                message: "Fake validation enabled",
                transactionDetails: {
                    amount: amountHint != null ? String(amountHint) : "Unknown",
                    date: nowIso,
                    status: "completed",
                },
            },
        },
    };
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
function mapValidatorError(error) {
    const status = error.response?.status;
    const data = error.response?.data;
    const providerMessage = data?.message || data?.error;
    if (error.code === "ECONNABORTED" || status === 408) {
        return { status: 408, body: { success: false, message: "Validation service timeout, try again." } };
    }
    if (status && [502, 503, 504].includes(status)) {
        return { status, body: { success: false, message: "Validation service unavailable, try again." } };
    }
    if (status && [400, 404].includes(status)) {
        return { status, body: { success: false, message: providerMessage || "Validation failed" } };
    }
    return { status: status || 502, body: { success: false, message: providerMessage || error.message || "Validation error" } };
}
function isRetryablePathError(error) {
    const status = error.response?.status;
    return (error.code === "ECONNREFUSED" ||
        error.code === "ENOTFOUND" ||
        status === 404);
}
function isSelfSignedCertError(error) {
    const msg = error?.message || "";
    const code = error?.code;
    return (code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
        code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
        msg.toLowerCase().includes("self-signed certificate"));
}
async function verifyPayment(input) {
    const { paymentMethod, transactionNumber } = input;
    const normalizedTxn = extractTransactionId(transactionNumber);
    const { reference: cbeReference } = paymentMethod === "cbe" ? parseCbeComposite(normalizedTxn) : { reference: normalizedTxn };
    const effectiveTxn = paymentMethod === "cbe" ? cbeReference : normalizedTxn;
    if (!effectiveTxn.trim()) {
        return { status: 400, body: { success: false, message: "transactionNumber is required" } };
    }
    const enableFakeValidation = String(process.env.PAYMENT_VALIDATION_FAKE || "false").toLowerCase() === "true";
    const fakeDefaultAmount = process.env.PAYMENT_VALIDATION_FAKE_AMOUNT ? Number(process.env.PAYMENT_VALIDATION_FAKE_AMOUNT) : undefined;
    if (enableFakeValidation) {
        return manualValidation(paymentMethod, normalizedTxn, fakeDefaultAmount);
    }
    // Always use the in-process custom verifier for CBE
    if (paymentMethod === "cbe") {
        return await runCustomCbeVerificationStandalone(effectiveTxn, normalizedTxn);
    }
    // Telebirr now uses the in-process receipt verifier
    return await runTelebirrVerificationStandalone(normalizedTxn);
}
async function runTelebirrVerificationStandalone(transactionNumber) {
    const allowInsecure = String(process.env.PAYMENT_VALIDATION_ALLOW_INSECURE || "false").toLowerCase() === "true";
    const expectedReceiverName = (process.env.TELEBIRR_RECEIVER_NAME || process.env.RECEIVER_NAME || "").trim();
    const expectedReceiverPhone = (process.env.TELEBIRR_PHONE_NUMBER || "").trim();
    const receiptNo = transactionNumber?.trim();
    if (!receiptNo) {
        return { status: 400, body: { success: false, message: "transactionNumber is required" } };
    }
    try {
        const html = await fetchReceipt({ receiptNo, insecure: allowInsecure });
        const parsed = parseReceiptHTML(html, { receiptNo });
        const hasFields = parsed && typeof parsed === "object" && Object.keys(parsed).length > 0;
        if (!hasFields) {
            return { status: 400, body: { success: false, message: "Could not parse Telebirr receipt" } };
        }
        const transactionDetails = mapTelebirrParsed(parsed);
        const verifier = createReceiptVerifier(parsed, {
            credited_party_name: expectedReceiverName || undefined,
            credited_party_acc_no: expectedReceiverPhone || undefined,
            to: expectedReceiverName || undefined,
        });
        if (expectedReceiverName && !verifier.equals(transactionDetails.creditedPartyName, expectedReceiverName)) {
            return {
                status: 400,
                body: { success: false, message: "Receiver name does not match expected Telebirr account", raw: { transactionDetails, parsed } },
            };
        }
        if (expectedReceiverPhone) {
            const phoneCandidate = transactionDetails.receiverPhone || transactionDetails.creditedPartyAccountNo || parsed?.payer_phone;
            if (!phoneLikelyMatches(expectedReceiverPhone, phoneCandidate)) {
                return {
                    status: 400,
                    body: { success: false, message: "Receiver phone does not match expected Telebirr account", raw: { transactionDetails, parsed } },
                };
            }
        }
        const amount = typeof transactionDetails.settledAmount === "number"
            ? transactionDetails.settledAmount
            : parseTelebirrAmount(parsed);
        const status = transactionDetails.transactionStatus || parsed.transaction_status || "verified";
        return {
            status: 200,
            body: {
                success: true,
                message: "Verified",
                provider: "telebirr",
                transactionNumber: receiptNo,
                amount,
                currency: "ETB",
                status,
                raw: { transactionDetails, data: transactionDetails, parsed },
            },
        };
    }
    catch (error) {
        const status = error?.response?.status;
        const mappedStatus = status && [400, 404].includes(status) ? status : 502;
        const message = error?.response?.data?.message || error?.message || "Telebirr verification failed";
        return { status: mappedStatus, body: { success: false, message } };
    }
}
function mapTelebirrParsed(parsed) {
    const settledAmount = parseTelebirrAmount(parsed);
    const totalPaidAmount = typeof parsed?.total_amount === "number" ? parsed.total_amount : parseAmount(parsed?.total_amount ? String(parsed.total_amount) : undefined);
    return {
        reference: parsed?.receiptNo || parsed?.receipt_no || parsed?.receiptno || parsed?.receipt,
        receiptNo: parsed?.receiptNo || parsed?.receipt_no || parsed?.receiptno || parsed?.receipt,
        payerName: parsed?.payer_name,
        payerPhone: parsed?.payer_phone,
        payerAccountType: parsed?.payer_acc_type,
        creditedPartyName: parsed?.credited_party_name || parsed?.to,
        creditedPartyAccountNo: parsed?.credited_party_acc_no,
        receiverPhone: parsed?.credited_party_acc_no || parsed?.bank_acc_no,
        bankAccountNumber: parsed?.bank_acc_no,
        transactionStatus: parsed?.transaction_status,
        paymentDate: parsed?.date,
        settledAmount,
        serviceFee: typeof parsed?.service_fee === "number" ? parsed.service_fee : parseAmount(parsed?.service_fee ? String(parsed.service_fee) : undefined),
        serviceFeeVAT: typeof parsed?.service_fee_vat === "number" ? parsed.service_fee_vat : parseAmount(parsed?.service_fee_vat ? String(parsed.service_fee_vat) : undefined),
        discountAmount: parsed?.discount_amount,
        vatAmount: parsed?.vat_amount,
        totalPaidAmount: totalPaidAmount ?? settledAmount,
        totalAmount: totalPaidAmount ?? settledAmount,
        amountInWord: parsed?.amount_in_word,
        paymentMode: parsed?.payment_mode,
        paymentReason: parsed?.payment_reason,
        paymentChannel: parsed?.payment_channel,
    };
}
function parseTelebirrAmount(parsed) {
    if (typeof parsed?.settled_amount === "number")
        return parsed.settled_amount;
    if (typeof parsed?.total_amount === "number")
        return parsed.total_amount;
    const fromSettled = parseAmount(parsed?.settled_amount ? String(parsed.settled_amount) : undefined);
    if (typeof fromSettled === "number")
        return fromSettled;
    return parseAmount(parsed?.total_amount ? String(parsed.total_amount) : undefined);
}
function normalizeDigits(value) {
    return (value || "").replace(/\D+/g, "");
}
function phoneLikelyMatches(expected, actual) {
    const e = normalizeDigits(expected);
    const a = normalizeDigits(actual);
    if (!e || !a)
        return true;
    if (e === a)
        return true;
    // Handle country code vs local prefix
    const eNoZero = e.replace(/^0/, "");
    const aNo251 = a.replace(/^251/, "");
    if (eNoZero && aNo251 && eNoZero === aNo251)
        return true;
    const last4 = e.slice(-4);
    if (last4 && a.endsWith(last4))
        return true;
    const last6 = e.slice(-6);
    if (last6 && a.endsWith(last6))
        return true;
    return false;
}
function asStringValue(value) {
    if (typeof value === "string")
        return value;
    if (value === undefined || value === null)
        return undefined;
    return String(value);
}
function asNumberValue(value) {
    if (typeof value === "number" && Number.isFinite(value))
        return value;
    if (value === undefined || value === null)
        return undefined;
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
}
function mapCbeSuccess(detail, transactionNumber) {
    const reference = asStringValue(detail.reference) || transactionNumber;
    const amount = asNumberValue(detail.amount);
    return {
        status: 200,
        body: {
            success: true,
            message: "Verified",
            provider: "cbe",
            transactionNumber: reference,
            amount,
            currency: "ETB",
            status: "verified",
            raw: detail,
        },
    };
}
function mapCbeFailure(failure) {
    const failureType = asStringValue(failure.type);
    const failureMessage = asStringValue(failure.message);
    switch (failureType) {
        case "INVALID_TRANSACTION_ID":
            return { status: 400, body: { success: false, message: "Invalid transaction id" } };
        case "INVALID_ACCOUNT_NO":
            return { status: 400, body: { success: false, message: "Invalid CBE account number" } };
        case "TRANSACTION_NOT_FOUND":
            return { status: 404, body: { success: false, message: "Transaction not found" } };
        case "API_REQUEST_FAILED":
        default:
            return { status: 502, body: { success: false, message: failureMessage || "CBE verification failed" } };
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
async function runCustomCbeVerificationStandalone(effectiveTxn, normalizedTxn) {
    const accountNumber = sanitizeCbeAccountNumber(process.env.CBE_ACCOUNT_NUMBER);
    const timeoutMs = parseTimeout(process.env.CBE_VERIFICATION_TIMEOUT_MS);
    const cbeVerificationUrl = process.env.CBE_VERIFICATION_URL;
    try {
        const outcome = await (0, cbe_verifier_custom_1.verify)({
            transactionId: effectiveTxn,
            accountNumberOfSenderOrReceiver: accountNumber,
            cbeVerificationUrl,
            timeoutMs,
        });
        if (outcome.isLeft && outcome.isLeft()) {
            return mapCbeFailure(outcome.extract());
        }
        const detail = outcome.extract();
        return mapCbeSuccess(detail, normalizedTxn);
    }
    catch (e) {
        const message = e?.message || "CBE verification error";
        return { status: 502, body: { success: false, message } };
    }
}
function transformAccountNumber(accountNumber) {
    // Remove leading 1 and 0s, per some gateway formats
    return accountNumber.replace(/^1+0*/, "");
}
// Extract transaction id from a full URL like https://apps.cbe.com.et:100/?id=FT...
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
        // Not a URL; continue
    }
    const match = trimmed.match(/id=([^&\s]+)/i);
    if (match?.[1])
        return match[1];
    return trimmed;
}
// Split CBE references that come as "<ref>&<accountSuffix>" (e.g., BranchReceipt links)
function parseCbeComposite(raw) {
    const decoded = decodeURIComponent(raw.trim());
    const parts = decoded.split(/[&]/).filter(Boolean);
    if (parts.length >= 2) {
        return { reference: parts[0], suffixOverride: parts[1] };
    }
    return { reference: decoded };
}
