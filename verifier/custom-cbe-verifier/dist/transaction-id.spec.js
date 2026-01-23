"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const transaction_id_1 = require("./transaction-id");
const sampleId = 'FT26015S1WKK73850447';
describe('transaction-id helpers', () => {
    it('validates longer transaction ids', () => {
        expect((0, transaction_id_1.validateTransactionId)(sampleId)).toBe(sampleId);
    });
    it('finds transaction id inside messages', () => {
        const message = `Dear user, your transaction ${sampleId} is processed.`;
        expect((0, transaction_id_1.findTransactionId)(message)).toBe(sampleId);
    });
    it('extracts transaction id from link query param', () => {
        const link = `https://apps.cbe.com.et:100/?id=${sampleId}`;
        expect((0, transaction_id_1.extractTransactionIdFromLink)(link)).toBe(sampleId);
    });
    it('handles transaction id with trailing symbols', () => {
        const messyId = `${sampleId}&73027449`;
        expect((0, transaction_id_1.validateTransactionId)(messyId)).toBe(sampleId);
    });
    it('extracts transaction id when link has extra characters', () => {
        const link = `https://apps.cbe.com.et:100/BranchReceipt/${sampleId}&73027449`;
        expect((0, transaction_id_1.extractTransactionIdFromLink)(link)).toBe(sampleId);
    });
});
//# sourceMappingURL=transaction-id.spec.js.map