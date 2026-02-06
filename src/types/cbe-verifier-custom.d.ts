declare module "cbe-verifier-custom" {
  export type TransactionDetail = Record<string, unknown>;
  export type VerifyFailure = Record<string, unknown>;
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
