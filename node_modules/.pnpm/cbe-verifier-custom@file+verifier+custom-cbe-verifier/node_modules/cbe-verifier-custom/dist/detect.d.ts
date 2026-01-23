export declare function detectTransactionId(buffer: Buffer, params: {
    googleVisionAPIKey?: string;
}): Promise<DetectTransactionIdResult | null>;
export type DetectTransactionIdResult = {
    value: string;
    detectedFrom: 'QR_CODE' | 'TEXT_RECOGNITION';
    timeTaken: number;
};
//# sourceMappingURL=detect.d.ts.map