"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.verify = verify;
const purify_ts_1 = require("purify-ts");
const axios_1 = __importStar(require("axios"));
const pdf_text_reader_1 = require("pdf-text-reader");
const process_text_1 = require("./process-text/process-text");
const transaction_id_1 = require("./transaction-id");
const DEFAULT_VERIFICATION_URL = 'https://apps.cbe.com.et:100/';
const DEFAULT_TIMEOUT_MS = 10_000;
async function verify(request) {
    const txnIdResolution = purify_ts_1.Either.encase(() => resolveTransactionId(request)).mapLeft(() => ({
        type: 'INVALID_TRANSACTION_ID',
    }));
    if (txnIdResolution.isLeft())
        return (0, purify_ts_1.Left)(txnIdResolution.extract());
    const accNoResolution = resolveAccountNumber(request.accountNumberOfSenderOrReceiver);
    if (accNoResolution.isLeft())
        return (0, purify_ts_1.Left)(accNoResolution.extract());
    const txnId = txnIdResolution.unsafeCoerce();
    const accountNumber = accNoResolution.unsafeCoerce();
    const verificationUrl = buildVerificationUrl({
        explicitLink: request.link ?? extractLinkFromMessage(request.message),
        baseUrl: request.cbeVerificationUrl,
        transactionId: txnId,
        accountNumber: accountNumber ?? undefined,
    });
    try {
        const response = await axios_1.default.get(verificationUrl, {
            responseType: 'arraybuffer',
            timeout: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
            validateStatus: () => true,
        });
        if (response.status === 404 || response.status === 410) {
            return (0, purify_ts_1.Left)({ type: 'TRANSACTION_NOT_FOUND' });
        }
        if (response.status < 200 || response.status >= 300) {
            return (0, purify_ts_1.Left)({
                type: 'API_REQUEST_FAILED',
                message: `HTTP ${response.status}: ${response.statusText || 'Request failed'}`,
            });
        }
        const pdfData = new Uint8Array(response.data);
        const pdfText = await (0, pdf_text_reader_1.readPdfText)({ data: pdfData });
        return (0, purify_ts_1.Right)((0, process_text_1.processResultText)(pdfText));
    }
    catch (error) {
        if (error instanceof axios_1.AxiosError) {
            if (error.response && (error.response.status === 404 || error.response.status === 410)) {
                return (0, purify_ts_1.Left)({ type: 'TRANSACTION_NOT_FOUND' });
            }
            return (0, purify_ts_1.Left)({ type: 'API_REQUEST_FAILED', message: error.message });
        }
        return (0, purify_ts_1.Left)({ type: 'API_REQUEST_FAILED', message: `Unknown error: ${error}` });
    }
}
const resolveTransactionId = (request) => {
    const candidates = [
        request.transactionId,
        (0, transaction_id_1.extractTransactionIdFromLink)(request.link),
        (0, transaction_id_1.extractTransactionIdFromLink)(extractLinkFromMessage(request.message) ?? undefined),
        (0, transaction_id_1.findTransactionId)(request.message),
    ];
    const candidate = candidates.find((it) => it);
    if (!candidate)
        throw new Error('Missing transaction id');
    return (0, transaction_id_1.validateTransactionId)(candidate);
};
const resolveAccountNumber = (accNo) => {
    if (accNo === undefined || accNo === null)
        return (0, purify_ts_1.Right)(null);
    return purify_ts_1.Either.encase(() => validateAccNo(accNo)).mapLeft(() => ({ type: 'INVALID_ACCOUNT_NO' }));
};
const buildVerificationUrl = (params) => {
    const base = params.explicitLink ?? params.baseUrl ?? DEFAULT_VERIFICATION_URL;
    const withProtocol = prependProtocolIfMissing(base);
    try {
        const url = new URL(withProtocol);
        url.searchParams.set('id', params.transactionId);
        return url.toString();
    }
    catch {
        // fall through to legacy path style if URL parsing fails
    }
    if (params.accountNumber) {
        const trimmedBase = withProtocol.replace(/\/+$/, '');
        return `${trimmedBase}/${params.transactionId}${params.accountNumber.substring(5)}`;
    }
    return `${withProtocol}?id=${params.transactionId}`;
};
const extractLinkFromMessage = (message) => {
    if (!message)
        return null;
    const urlPattern = /(https?:\/\/\S+)/gi;
    let match;
    while ((match = urlPattern.exec(message)) !== null) {
        if ((0, transaction_id_1.extractTransactionIdFromLink)(match[1]))
            return match[1];
    }
    return null;
};
const prependProtocolIfMissing = (url) => {
    if (/^https?:\/\//i.test(url))
        return url;
    return `https://${url}`;
};
const validateAccNo = (accNo) => {
    if (!accNo)
        throw 'Error: accNo is required!';
    if (!/^1000\d{9}$/.test(accNo.toString()))
        throw 'Error: Invalid accNo!';
    return accNo.toString();
};
//# sourceMappingURL=verify.js.map