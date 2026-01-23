import { Either } from 'purify-ts';
import { TransactionDetail } from './process-text/process-text';
export type VerifyRequest = {
    transactionId?: string;
    accountNumberOfSenderOrReceiver?: string;
    cbeVerificationUrl?: string;
    message?: string;
    link?: string;
    timeoutMs?: number;
};
export declare function verify(request: VerifyRequest): Promise<Either<VerifyFailure, TransactionDetail>>;
export type VerifyFailure = {
    type: 'INVALID_TRANSACTION_ID';
} | {
    type: 'INVALID_ACCOUNT_NO';
} | {
    type: 'TRANSACTION_NOT_FOUND';
} | {
    type: 'API_REQUEST_FAILED';
    message: string;
};
export type { TransactionDetail } from './process-text/process-text';
//# sourceMappingURL=verify.d.ts.map