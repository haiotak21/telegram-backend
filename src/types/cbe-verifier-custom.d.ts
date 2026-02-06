declare module "cbe-verifier-custom" {
  export interface TransactionDetail {
    reference?: string;
    amount?: number;
    [key: string]: unknown;
  }

  export interface VerifyFailure {
    type?: string;
    message?: string;
    [key: string]: unknown;
  }
  export type VerifyResult<T> = {
    isLeft?: () => boolean;
    extract?: () => T;
  };

  export function verify(input: {
    transactionId: string;
    accountNumberOfSenderOrReceiver?: string;
    cbeVerificationUrl?: string;
    timeoutMs?: number;
  }): Promise<VerifyResult<TransactionDetail | VerifyFailure>>;
}
