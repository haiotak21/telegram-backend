export const TRANSACTION_ID_PATTERN = /^FT[A-Z0-9]{10,18}$/i;
export const TRANSACTION_ID_IN_TEXT = /FT[A-Z0-9]{10,18}/i;

const normalize = (value: string) => value.toUpperCase();

export function validateTransactionId(candidate: any): string {
  if (!candidate) throw new Error('Transaction id is required');
  const value = candidate.toString().trim();
  const match = TRANSACTION_ID_IN_TEXT.exec(value);
  if (!match) throw new Error('Invalid transaction id');
  return normalize(match[0]);
}

export function findTransactionId(text?: string): string | null {
  if (!text) return null;
  const match = TRANSACTION_ID_IN_TEXT.exec(text);
  return match ? normalize(match[0]) : null;
}

export function extractTransactionIdFromLink(link?: string): string | null {
  if (!link) return null;
  try {
    const url = new URL(link);
    const id = url.searchParams.get('id');
    if (id) return validateTransactionId(id);
  } catch {
    // ignore and fall back to loose match below
  }
  return findTransactionId(link);
}
