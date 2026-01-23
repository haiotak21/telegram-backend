import PricingConfig, { IPricingConfig } from "../models/PricingConfig";

export interface FeeCalculation {
  gross: number;
  fee: number;
  net: number;
}

export interface DepositQuote {
  amountEtb: number;
  feeEtb: number;
  rate: number;
  creditedUsdt: number;
  config: IPricingConfig;
}

export interface TopupQuote {
  amountUsdt: number;
  feeUsdt: number;
  totalChargeUsdt: number;
  config: IPricingConfig;
}

const DEFAULT_RATE = 220; // 1 USDT = 220 ETB (fallback)

export async function loadPricingConfig(): Promise<IPricingConfig> {
  const existing = await PricingConfig.findOne({ key: "default" });
  if (existing) return existing;

  const created = await PricingConfig.create({
    key: "default",
    usdtRate: DEFAULT_RATE,
    depositPercentFee: 0,
    depositFlatFee: 0,
    topupPercentFee: 0,
    topupFlatFee: 0,
  });
  return created;
}

export async function upsertPricingConfig(input: Partial<IPricingConfig> & { updatedBy?: string }) {
  const current = await loadPricingConfig();
  const update: Partial<IPricingConfig> = { ...input } as any;
  const next = await PricingConfig.findOneAndUpdate({ key: "default" }, { $set: update }, { new: true, upsert: true });
  return next ?? current;
}

function applyFees(amount: number, percent: number, flat: number): FeeCalculation {
  const percentFee = (Math.max(percent, 0) / 100) * amount;
  const fee = percentFee + Math.max(flat, 0);
  const net = amount - fee;
  return { gross: amount, fee, net };
}

export function quoteDeposit(amountEtb: number, config: IPricingConfig): DepositQuote {
  const { fee } = applyFees(amountEtb, config.depositPercentFee, config.depositFlatFee);
  const netEtb = amountEtb - fee;
  const rate = config.usdtRate > 0 ? config.usdtRate : DEFAULT_RATE;
  const creditedUsdt = netEtb / rate;
  return { amountEtb, feeEtb: fee, rate, creditedUsdt, config };
}

export function quoteTopup(amountUsdt: number, config: IPricingConfig): TopupQuote {
  const { fee } = applyFees(amountUsdt, config.topupPercentFee, config.topupFlatFee);
  const totalChargeUsdt = amountUsdt + fee;
  return { amountUsdt, feeUsdt: fee, totalChargeUsdt, config };
}

export function enforceTopupLimits(amountUsdt: number, config: IPricingConfig) {
  if (config.topupMin != null && amountUsdt < config.topupMin) {
    throw new Error(`Minimum top-up is ${config.topupMin} USDT`);
  }
  if (config.topupMax != null && amountUsdt > config.topupMax) {
    throw new Error(`Maximum top-up is ${config.topupMax} USDT`);
  }
}
