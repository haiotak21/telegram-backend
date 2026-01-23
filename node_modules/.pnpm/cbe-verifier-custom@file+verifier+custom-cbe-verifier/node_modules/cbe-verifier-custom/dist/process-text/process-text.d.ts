export declare function processResultText(text: string): TransactionDetail;
export type TransactionDetail = {
    fullText: string;
    amount?: number;
    payer?: string;
    receiver?: string;
    reference?: string;
    payerAccount?: string;
    receiverAccount?: string;
    reason?: string;
    date?: string;
};
//# sourceMappingURL=process-text.d.ts.map