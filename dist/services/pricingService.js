"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadPricingConfig = loadPricingConfig;
exports.upsertPricingConfig = upsertPricingConfig;
exports.quoteDeposit = quoteDeposit;
exports.quoteTopup = quoteTopup;
exports.enforceTopupLimits = enforceTopupLimits;
const PricingConfig_1 = __importDefault(require("../models/PricingConfig"));
const DEFAULT_RATE = 220; // 1 USDT = 220 ETB (fallback)
async function loadPricingConfig() {
    const existing = await PricingConfig_1.default.findOne({ key: "default" });
    if (existing)
        return existing;
    const created = await PricingConfig_1.default.create({
        key: "default",
        usdtRate: DEFAULT_RATE,
        depositPercentFee: 0,
        depositFlatFee: 0,
        topupPercentFee: 0,
        topupFlatFee: 0,
        cardRequestFeeEtb: 0,
    });
    return created;
}
async function upsertPricingConfig(input) {
    const current = await loadPricingConfig();
    const update = { ...input };
    const next = await PricingConfig_1.default.findOneAndUpdate({ key: "default" }, { $set: update }, { new: true, upsert: true });
    return next ?? current;
}
function applyFees(amount, percent, flat) {
    const percentFee = (Math.max(percent, 0) / 100) * amount;
    const fee = percentFee + Math.max(flat, 0);
    const net = amount - fee;
    return { gross: amount, fee, net };
}
function quoteDeposit(amountEtb, config) {
    const { fee } = applyFees(amountEtb, config.depositPercentFee, config.depositFlatFee);
    const netEtb = amountEtb - fee;
    const rate = config.usdtRate > 0 ? config.usdtRate : DEFAULT_RATE;
    const creditedUsdt = netEtb / rate;
    return { amountEtb, feeEtb: fee, rate, creditedUsdt, config };
}
function quoteTopup(amountUsdt, config) {
    const { fee } = applyFees(amountUsdt, config.topupPercentFee, config.topupFlatFee);
    const totalChargeUsdt = amountUsdt + fee;
    return { amountUsdt, feeUsdt: fee, totalChargeUsdt, config };
}
function enforceTopupLimits(amountUsdt, config) {
    if (config.topupMin != null && amountUsdt < config.topupMin) {
        throw new Error(`Minimum top-up is ${config.topupMin} USDT`);
    }
    if (config.topupMax != null && amountUsdt > config.topupMax) {
        throw new Error(`Maximum top-up is ${config.topupMax} USDT`);
    }
}
