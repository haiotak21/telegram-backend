jest.mock('../src/services/pricingService', () => ({
  loadPricingConfig: jest.fn(),
  quoteDeposit: jest.fn(),
}));
jest.mock('../src/services/paymentVerification', () => ({
  verifyPayment: jest.fn(),
}));
jest.mock('../src/models/Transaction', () => ({
  create: jest.fn(),
  findOne: jest.fn(),
}));
jest.mock('../src/models/User', () => ({
  findOneAndUpdate: jest.fn(),
  findOne: jest.fn(),
}));

// Mock mongoose session behavior so tests don't require a DB
jest.mock('mongoose', () => ({
  startSession: jest.fn(() => ({
    startTransaction: jest.fn(),
    commitTransaction: jest.fn(),
    abortTransaction: jest.fn(),
    endSession: jest.fn(),
  })),
}));

import { processDeposit } from '../src/services/depositService';

import { loadPricingConfig, quoteDeposit } from '../src/services/pricingService';
import { verifyPayment } from '../src/services/paymentVerification';
import Transaction from '../src/models/Transaction';
import User from '../src/models/User';

const asAny = (v: any) => v;

describe('processDeposit', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default mocked DB lookups return objects with a `lean()` helper
    (Transaction.findOne as any).mockReturnValue({ lean: jest.fn().mockResolvedValue(null) });
    (User.findOne as any).mockReturnValue({ lean: jest.fn().mockResolvedValue(null) });
  });

  it('records pending when fake-topup is disabled and provider verifies', async () => {
    (loadPricingConfig as any).mockResolvedValue({});
    (quoteDeposit as any).mockReturnValue({ creditedUsdt: 0.45454545, rate: 220, feeEtb: 0 });
    (verifyPayment as any).mockResolvedValue({ body: { success: true, amount: 100 } });
    (Transaction.create as any).mockResolvedValue([{ _id: 'txPending' }]);

    const res = await processDeposit({ userId: 'u2', paymentMethod: 'telebirr', amount: 100, transactionNumber: 'SIM2' });
    expect(res.success).toBe(true);
    expect(res.message).toMatch(/Awaiting admin approval/);
  });

  it('returns failure when provider verification fails', async () => {
    (loadPricingConfig as any).mockResolvedValue({});
    (quoteDeposit as any).mockReturnValue({ creditedUsdt: 0.45454545, rate: 220, feeEtb: 0 });
    (verifyPayment as any).mockResolvedValue({ body: { success: false, message: 'Invalid receipt', raw: {} } });
    (Transaction.create as any).mockResolvedValue([{ _id: 'txFail' }]);

    const res = await processDeposit({ userId: 'u3', paymentMethod: 'telebirr', amount: 100, transactionNumber: 'SIM3' });
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/Invalid receipt/);
  });

  it('returns failure when provider amount mismatches', async () => {
    (loadPricingConfig as any).mockResolvedValue({});
    (quoteDeposit as any).mockReturnValue({ creditedUsdt: 0.45454545, rate: 220, feeEtb: 0 });
    (verifyPayment as any).mockResolvedValue({ body: { success: true, amount: 50, raw: {} } });
    (Transaction.create as any).mockResolvedValue([{ _id: 'txFail2' }]);

    const res = await processDeposit({ userId: 'u4', paymentMethod: 'telebirr', amount: 100, transactionNumber: 'SIM4' });
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/Amount mismatch/);
  });

  it('short-circuits when an existing completed deposit is found', async () => {
    (loadPricingConfig as any).mockResolvedValue({});
    (quoteDeposit as any).mockReturnValue({ creditedUsdt: 0.5, rate: 200, feeEtb: 0 });
    // Make Transaction.findOne(...).lean() return an existing completed record
    (Transaction.findOne as any).mockReturnValue({ lean: jest.fn().mockResolvedValue({ status: 'completed', _id: 'existingTx', amountUsdt: 0.5, rateSnapshot: 200, feeEtb: 0 }) });
    (User.findOne as any).mockReturnValue({ lean: jest.fn().mockResolvedValue({ balance: 1.23 }) });

    const res = await processDeposit({ userId: 'u5', paymentMethod: 'telebirr', amount: 100, transactionNumber: 'SIM5' });
    expect(res.success).toBe(true);
    expect(res.message).toMatch(/Deposit already processed/);
    expect(res.newBalance).toBeCloseTo(1.23);
  });
});
