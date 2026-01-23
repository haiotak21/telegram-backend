export function processResultText(text: string): TransactionDetail {
  const extractValue = (regex: RegExp, txt: string) => regex.exec(txt)?.groups?.['value'];

  const amount = [
    extractValue(/ETB\s*(?<value>[\d,]+\.\d+)/i, text),
    extractValue(/Amount\s+(?<value>[\d,]+\.\d+)\s+ETB/i, text),
  ].find((it) => it !== undefined);

  const payer = extractValue(/Payer\s+(?<value>[^\n]+)/i, text)?.trim();
  const payerAccount = extractValue(/Payer[^\n]*\n\s*Account\s+(?<value>[A-Z0-9*]+)/i, text);

  const receiver = extractValue(/Receiver\s+(?<value>[^\n]+)/i, text)?.trim();
  const receiverAccount = extractValue(/Receiver[^\n]*\n\s*Account\s+(?<value>[A-Z0-9*]+)/i, text);

  const paymentDate = extractValue(/Payment Date(?:\s*&\s*Time)?\s+(?<value>[^\n]+)/i, text);
  const reference = extractValue(/Reference No\.[^\n]*?(?<value>FT[A-Z0-9]{10,18})/i, text);
  const reason = extractValue(/Reason\s*(?:\/\s*Type of service)?\s+(?<value>[^\n]*)/i, text)?.trim();

  return {
    fullText: text,
    amount: amount ? Number.parseFloat(amount.replace(/,/g, '')) : undefined,
    payer,
    receiver,
    reference,
    payerAccount,
    receiverAccount,
    reason,
    date: paymentDate,
  };
}

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
