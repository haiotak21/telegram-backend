jest.mock('../src/services/runtimeConfigService', () => ({ getFakeTopup: jest.fn() }));
jest.mock('../src/services/pricingService', () => ({ loadPricingConfig: jest.fn(), quoteTopup: jest.fn(), enforceTopupLimits: jest.fn() }));
jest.mock('../src/models/Transaction', () => ({ create: jest.fn(), updateOne: jest.fn() }));
jest.mock('../src/models/User', () => ({ findOne: jest.fn(), findOneAndUpdate: jest.fn(), create: jest.fn() }));
jest.mock('mongoose', () => ({ startSession: jest.fn(() => ({ startTransaction: jest.fn(), commitTransaction: jest.fn(), abortTransaction: jest.fn(), endSession: jest.fn() })) }));
jest.mock('axios', () => ({ create: jest.fn(() => ({ post: jest.fn(), get: jest.fn() })), post: jest.fn() }));

import { topUpCard } from '../src/services/topupService';
import { getFakeTopup } from '../src/services/runtimeConfigService';
import { loadPricingConfig, quoteTopup } from '../src/services/pricingService';
import Transaction from '../src/models/Transaction';
import User from '../src/models/User';
import axios from 'axios';

describe('topUpCard', () => {
  beforeEach(() => jest.clearAllMocks());
  beforeEach(() => {
    process.env.STROWALLET_PUBLIC_KEY = 'pub_test';
  });

  it('returns simulated success when fake-topup is enabled', async () => {
    (getFakeTopup as any).mockResolvedValue(true);
    (loadPricingConfig as any).mockResolvedValue({});
    (quoteTopup as any).mockReturnValue({ totalChargeUsdt: 1, feeUsdt: 0 });
    (User.findOne as any).mockReturnValue({ session: jest.fn().mockResolvedValue({ userId: 'u1', balance: 10 }) });
    (Transaction.create as any).mockResolvedValue([{ _id: 'tx1' }]);

    const res = await topUpCard({ userId: 'u1', cardId: 'card1', amountUsdt: 1 });
    expect(res.success).toBe(true);
    expect(res.message).toMatch(/simulated/i);
    expect(axios.create).not.toHaveBeenCalled();
  });

  it('attempts real top-up when fake-topup is disabled and has sufficient balance', async () => {
    (getFakeTopup as any).mockResolvedValue(false);
    process.env.FAKE_TOPUP = 'false';
    (loadPricingConfig as any).mockResolvedValue({});
    (quoteTopup as any).mockReturnValue({ totalChargeUsdt: 1, feeUsdt: 0 });
    (User.findOne as any).mockReturnValue({ session: jest.fn().mockResolvedValue({ userId: 'u2', balance: 10 }) });
    (Transaction.create as any).mockResolvedValue([{ _id: 'tx2' }]);
    (User.findOneAndUpdate as any).mockResolvedValue({ balance: 9 });
    (axios.post as any).mockResolvedValue({ data: { id: 'prov1' } });

    const res = await topUpCard({ userId: 'u2', cardId: 'card2', amountUsdt: 1 });
    expect(res.success).toBe(true);
    expect(res.providerResponse).toBeDefined();
    expect(axios.post).toHaveBeenCalled();
  });
});
