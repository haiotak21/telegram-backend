import { processResultText } from './process-text';

const tx_sample_1 = 'Transferred Amount 3,500.00 ETB';
const tx_sample_2 = 'Transferred Amount 1,234,567.89 ETB';
const tx_receipt = `Commercial Bank of Ethiopia
VAT Invoice/Customer Receipt - Branch Receipt

Payer FT SUSPNESE ACCOUNT

Account E****0010

Receiver H/MARIAM TAKELE MEKONNEN

Account 1****7449

Payment Date & Time 1/15/2026, 5:23:00 PM

Reference No. (VAT Invoice No) FT260157S10C

Reason / Type of service BKM56700002 1:H0o

Transferred Amount 3,000.00 ETB
`;

describe('process-text', () => {
  it('should extract amount properly', () => {
    const transactionDetail = processResultText(tx_sample_1);
    expect(transactionDetail.amount).toBe(3500);
  });

  it('should extract amount with multiple commas', () => {
    const transactionDetail = processResultText(tx_sample_2);
    expect(transactionDetail.amount).toBe(1234567.89);
  });

  it('should extract receiver, reference, date, accounts from receipt text', () => {
    const t = processResultText(tx_receipt);
    expect(t.receiver).toBe('H/MARIAM TAKELE MEKONNEN');
    expect(t.payer).toBe('FT SUSPNESE ACCOUNT');
    expect(t.payerAccount).toBe('E****0010');
    expect(t.receiverAccount).toBe('1****7449');
    expect(t.reference).toBe('FT260157S10C');
    expect(t.date).toBe('1/15/2026, 5:23:00 PM');
    expect(t.reason).toBe('BKM56700002 1:H0o');
    expect(t.amount).toBe(3000);
  });
});
