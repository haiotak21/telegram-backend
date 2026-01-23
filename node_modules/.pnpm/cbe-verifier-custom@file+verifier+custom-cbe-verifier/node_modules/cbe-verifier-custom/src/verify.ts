import { Either, Left, Right } from 'purify-ts';
import axios, { AxiosError } from 'axios';
import { readPdfText } from 'pdf-text-reader';
import { processResultText, TransactionDetail } from './process-text/process-text';
import { extractTransactionIdFromLink, findTransactionId, validateTransactionId } from './transaction-id';

const DEFAULT_VERIFICATION_URL = 'https://apps.cbe.com.et:100/';
const DEFAULT_TIMEOUT_MS = 10_000;

export type VerifyRequest = {
  transactionId?: string;
  accountNumberOfSenderOrReceiver?: string;
  cbeVerificationUrl?: string;
  message?: string;
  link?: string;
  timeoutMs?: number;
};

export async function verify(request: VerifyRequest): Promise<Either<VerifyFailure, TransactionDetail>> {
  const txnIdResolution = Either.encase(() => resolveTransactionId(request)).mapLeft(() => ({
    type: 'INVALID_TRANSACTION_ID' as const,
  }));

  if (txnIdResolution.isLeft()) return Left(txnIdResolution.extract());
  const accNoResolution = resolveAccountNumber(request.accountNumberOfSenderOrReceiver);
  if (accNoResolution.isLeft()) return Left(accNoResolution.extract());

  const txnId = txnIdResolution.unsafeCoerce();
  const accountNumber = accNoResolution.unsafeCoerce();
  const verificationUrl = buildVerificationUrl({
    explicitLink: request.link ?? extractLinkFromMessage(request.message),
    baseUrl: request.cbeVerificationUrl,
    transactionId: txnId,
    accountNumber: accountNumber ?? undefined,
  });

  try {
    const response = await axios.get(verificationUrl, {
      responseType: 'arraybuffer',
      timeout: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      validateStatus: () => true,
    });

    if (response.status === 404 || response.status === 410) {
      return Left({ type: 'TRANSACTION_NOT_FOUND' as const });
    }

    if (response.status < 200 || response.status >= 300) {
      return Left({
        type: 'API_REQUEST_FAILED' as const,
        message: `HTTP ${response.status}: ${response.statusText || 'Request failed'}`,
      });
    }

    const pdfData = new Uint8Array(response.data);
    const pdfText: string = await readPdfText({ data: pdfData });

    return Right(processResultText(pdfText));
  } catch (error) {
    if (error instanceof AxiosError) {
      if (error.response && (error.response.status === 404 || error.response.status === 410)) {
        return Left({ type: 'TRANSACTION_NOT_FOUND' as const });
      }
      return Left({ type: 'API_REQUEST_FAILED' as const, message: error.message });
    }
    return Left({ type: 'API_REQUEST_FAILED' as const, message: `Unknown error: ${error}` });
  }
}

const resolveTransactionId = (request: VerifyRequest): string => {
  const candidates = [
    request.transactionId,
    extractTransactionIdFromLink(request.link),
    extractTransactionIdFromLink(extractLinkFromMessage(request.message) ?? undefined),
    findTransactionId(request.message),
  ];

  const candidate = candidates.find((it) => it);
  if (!candidate) throw new Error('Missing transaction id');
  return validateTransactionId(candidate);
};

const resolveAccountNumber = (
  accNo?: any
): Either<{ type: 'INVALID_ACCOUNT_NO' }, string | null> => {
  if (accNo === undefined || accNo === null) return Right(null);
  return Either.encase(() => validateAccNo(accNo)).mapLeft(() => ({ type: 'INVALID_ACCOUNT_NO' as const }));
};

const buildVerificationUrl = (params: {
  explicitLink?: string | null;
  baseUrl?: string;
  transactionId: string;
  accountNumber?: string;
}): string => {
  const base = params.explicitLink ?? params.baseUrl ?? DEFAULT_VERIFICATION_URL;
  const withProtocol = prependProtocolIfMissing(base);

  try {
    const url = new URL(withProtocol);
    url.searchParams.set('id', params.transactionId);
    return url.toString();
  } catch {
    // fall through to legacy path style if URL parsing fails
  }

  if (params.accountNumber) {
    const trimmedBase = withProtocol.replace(/\/+$/, '');
    return `${trimmedBase}/${params.transactionId}${params.accountNumber.substring(5)}`;
  }

  return `${withProtocol}?id=${params.transactionId}`;
};

const extractLinkFromMessage = (message?: string | null): string | null => {
  if (!message) return null;
  const urlPattern = /(https?:\/\/\S+)/gi;
  let match: RegExpExecArray | null;
  while ((match = urlPattern.exec(message)) !== null) {
    if (extractTransactionIdFromLink(match[1])) return match[1];
  }
  return null;
};

const prependProtocolIfMissing = (url: string): string => {
  if (/^https?:\/\//i.test(url)) return url;
  return `https://${url}`;
};

const validateAccNo = (accNo: any): string => {
  if (!accNo) throw 'Error: accNo is required!';
  if (!/^1000\d{9}$/.test(accNo.toString())) throw 'Error: Invalid accNo!';
  return accNo.toString();
};

export type VerifyFailure =
  | { type: 'INVALID_TRANSACTION_ID' }
  | { type: 'INVALID_ACCOUNT_NO' }
  | { type: 'TRANSACTION_NOT_FOUND' }
  | { type: 'API_REQUEST_FAILED'; message: string };

export type { TransactionDetail } from './process-text/process-text';
