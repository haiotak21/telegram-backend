"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TRANSACTION_ID_IN_TEXT = exports.TRANSACTION_ID_PATTERN = void 0;
exports.validateTransactionId = validateTransactionId;
exports.findTransactionId = findTransactionId;
exports.extractTransactionIdFromLink = extractTransactionIdFromLink;
exports.TRANSACTION_ID_PATTERN = /^FT[A-Z0-9]{10,18}$/i;
exports.TRANSACTION_ID_IN_TEXT = /FT[A-Z0-9]{10,18}/i;
const normalize = (value) => value.toUpperCase();
function validateTransactionId(candidate) {
    if (!candidate)
        throw new Error('Transaction id is required');
    const value = candidate.toString().trim();
    const match = exports.TRANSACTION_ID_IN_TEXT.exec(value);
    if (!match)
        throw new Error('Invalid transaction id');
    return normalize(match[0]);
}
function findTransactionId(text) {
    if (!text)
        return null;
    const match = exports.TRANSACTION_ID_IN_TEXT.exec(text);
    return match ? normalize(match[0]) : null;
}
function extractTransactionIdFromLink(link) {
    if (!link)
        return null;
    try {
        const url = new URL(link);
        const id = url.searchParams.get('id');
        if (id)
            return validateTransactionId(id);
    }
    catch {
        // ignore and fall back to loose match below
    }
    return findTransactionId(link);
}
//# sourceMappingURL=transaction-id.js.map