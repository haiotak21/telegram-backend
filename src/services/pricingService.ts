import PricingConfig, { IPricingConfig } from "../models/PricingConfig";
import fs from "fs/promises";
import path from "path";
import mongoose from "mongoose";
import { isPrismaPersistenceEnabled } from "../utils/persistence";

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
const PRICING_CONFIG_PATH = process.env.PRICING_CONFIG_PATH || path.join(process.cwd(), "data", "pricing-config.json");
const PRICING_CONFIG_FILE_STORE = String(process.env.PRICING_CONFIG_FILE_STORE || "true").toLowerCase() !== "false";

function getDefaultPricingConfig(): IPricingConfig {
  return {
    key: "default",
    usdtRate: DEFAULT_RATE,
    depositPercentFee: 0,
    depositFlatFee: 0,
    topupPercentFee: 0,
    topupFlatFee: 0,
    topupMin: undefined,
    topupMax: undefined,
    cardRequestFeeEtb: 0,
    firstCardAmountUsd: 5,
    firstCardFeeUsd: 0,
  } as any;
}

async function readPricingConfigFromFile(): Promise<IPricingConfig | null> {
  try {
    const content = await fs.readFile(PRICING_CONFIG_PATH, "utf8");
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== "object") return null;
    return { ...getDefaultPricingConfig(), ...parsed } as any;
  } catch {
    return null;
  }
}

async function writePricingConfigToFile(config: Partial<IPricingConfig>) {
  const dir = path.dirname(PRICING_CONFIG_PATH);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(PRICING_CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
}

export async function loadPricingConfig(): Promise<IPricingConfig> {
  const useFileStore = PRICING_CONFIG_FILE_STORE || isPrismaPersistenceEnabled() || mongoose.connection.readyState !== 1;
  if (useFileStore) {
    const fromFile = await readPricingConfigFromFile();
    if (fromFile) return fromFile;
    const defaults = getDefaultPricingConfig();
    await writePricingConfigToFile(defaults);
    return defaults;
  }

  try {
    const existing = await PricingConfig.findOne({ key: "default" });
    if (existing) return existing;

    const created = await PricingConfig.create({
      key: "default",
      usdtRate: DEFAULT_RATE,
      depositPercentFee: 0,
      depositFlatFee: 0,
      topupPercentFee: 0,
      topupFlatFee: 0,
      cardRequestFeeEtb: 0,
      firstCardAmountUsd: 5,
      firstCardFeeUsd: 0,
    });
    return created;
  } catch {
    const fromFile = await readPricingConfigFromFile();
    if (fromFile) return fromFile;
    const defaults = getDefaultPricingConfig();
    await writePricingConfigToFile(defaults);
    return defaults;
  }
}

export async function upsertPricingConfig(input: Partial<IPricingConfig> & { updatedBy?: string }) {
  const current = await loadPricingConfig();
  const update: Partial<IPricingConfig> = { ...input } as any;
  const useFileStore = PRICING_CONFIG_FILE_STORE || isPrismaPersistenceEnabled() || mongoose.connection.readyState !== 1;
  if (useFileStore) {
    const merged = { ...current, ...update, key: "default" } as any;
    await writePricingConfigToFile(merged);
    return merged;
  }

  try {
    const next = await PricingConfig.findOneAndUpdate({ key: "default" }, { $set: update }, { new: true, upsert: true });
    return next ?? current;
  } catch {
    const merged = { ...current, ...update, key: "default" } as any;
    await writePricingConfigToFile(merged);
    return merged;
  }
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
