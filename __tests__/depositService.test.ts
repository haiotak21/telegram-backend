jest.mock('../src/services/pricingService', () => ({
  loadPricingConfig: jest.fn(),
  quoteDeposit: jest.fn(),
}));
jest.mock('../src/services/paymentVerification', () => ({
  verifyPayment: jest.fn(),
}));
jest.mock('../src/utils/persistence', () => ({
  isPrismaPersistenceEnabled: jest.fn(() => false),
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
    // Default mocked DB lookups support both `.lean()` and `.session(...).lean()` forms.
    (Transaction.findOne as any).mockImplementation(() => ({
      lean: jest.fn().mockResolvedValue(null),
      session: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(null) }),
    }));
    (User.findOne as any).mockImplementation(() => ({
      lean: jest.fn().mockResolvedValue({ balance: 0 }),
      session: jest.fn().mockResolvedValue({ userId: 'u-default', balance: 0 }),
    }));
    (User.findOneAndUpdate as any).mockResolvedValue({ userId: 'u-default', balance: 0.45454545 });
  });

  it('credits deposit immediately when provider verifies', async () => {
    (loadPricingConfig as any).mockResolvedValue({});
    (quoteDeposit as any).mockReturnValue({ creditedUsdt: 0.45454545, rate: 220, feeEtb: 0 });
    (verifyPayment as any).mockResolvedValue({
      body: {
        success: true,
        amount: 1000,
        transactionNumber: 'SIM2',
        raw: { data: { creditedPartyName: 'Addisu melke admasu' } },
      },
    });
    (User.findOne as any).mockImplementation(() => ({
      lean: jest.fn().mockResolvedValue({ balance: 0 }),
      session: jest.fn().mockResolvedValue({ userId: 'u2', balance: 0 }),
    }));
    (User.findOneAndUpdate as any).mockResolvedValue({ userId: 'u2', balance: 0.45454545 });
    (Transaction.create as any).mockResolvedValue([{ _id: 'txPending' }]);

    const res = await processDeposit({ userId: 'u2', paymentMethod: 'telebirr', amount: 1000, transactionNumber: 'SIM2' });
    expect(res.success).toBe(true);
    expect(res.status).toBe('completed');
    expect(res.message).toMatch(/credited successfully/i);
  });

  it('returns failure when provider verification fails', async () => {
    (loadPricingConfig as any).mockResolvedValue({});
    (quoteDeposit as any).mockReturnValue({ creditedUsdt: 0.45454545, rate: 220, feeEtb: 0 });
    (verifyPayment as any).mockResolvedValue({ body: { success: false, message: 'Invalid receipt', raw: {} } });
    (Transaction.create as any).mockResolvedValue([{ _id: 'txFail' }]);

    const res = await processDeposit({ userId: 'u3', paymentMethod: 'telebirr', amount: 1000, transactionNumber: 'SIM3' });
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/Invalid receipt/);
  });

  it('returns failure when provider amount mismatches', async () => {
    (loadPricingConfig as any).mockResolvedValue({});
    (quoteDeposit as any).mockReturnValue({ creditedUsdt: 0.45454545, rate: 220, feeEtb: 0 });
    (verifyPayment as any).mockResolvedValue({
      body: {
        success: true,
        amount: 50,
        raw: { data: { creditedPartyName: 'Addisu melke admasu' } },
      },
    });
    (Transaction.create as any).mockResolvedValue([{ _id: 'txFail2' }]);

    const res = await processDeposit({ userId: 'u4', paymentMethod: 'telebirr', amount: 1000, transactionNumber: 'SIM4' });
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/selected deposit amount/i);
  });

  it('returns failure when receiver name mismatches expected account', async () => {
    (loadPricingConfig as any).mockResolvedValue({});
    (quoteDeposit as any).mockReturnValue({ creditedUsdt: 0.45454545, rate: 220, feeEtb: 0 });
    (verifyPayment as any).mockResolvedValue({
      body: {
        success: true,
        amount: 1000,
        raw: { data: { creditedPartyName: 'John' } },
      },
    });
    (Transaction.create as any).mockResolvedValue([{ _id: 'txFailReceiver' }]);

    const res = await processDeposit({ userId: 'u6', paymentMethod: 'telebirr', amount: 1000, transactionNumber: 'SIM6' });
    expect(res.success).toBe(false);
    expect(res.message).toBe('Receiver name does not match the expected payment account.');
  });

  it('short-circuits when an existing completed deposit is found', async () => {
    (loadPricingConfig as any).mockResolvedValue({});
    (quoteDeposit as any).mockReturnValue({ creditedUsdt: 0.5, rate: 200, feeEtb: 0 });
    // Make Transaction.findOne(...).lean() return an existing completed record
    (Transaction.findOne as any).mockReturnValue({ lean: jest.fn().mockResolvedValue({ status: 'completed', _id: 'existingTx', amountUsdt: 0.5, rateSnapshot: 200, feeEtb: 0 }) });
    (User.findOne as any).mockReturnValue({ lean: jest.fn().mockResolvedValue({ balance: 1.23 }) });

    const res = await processDeposit({ userId: 'u5', paymentMethod: 'telebirr', amount: 1000, transactionNumber: 'SIM5' });
    expect(res.success).toBe(true);
    expect(res.status).toBe('completed');
    expect(res.message).toMatch(/Deposit already processed/);
    expect(res.newBalance).toBeCloseTo(1.23);
  });
});
