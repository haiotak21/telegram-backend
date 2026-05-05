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
const promises_1 = __importDefault(require("fs/promises"));
const path_1 = __importDefault(require("path"));
const mongoose_1 = __importDefault(require("mongoose"));
const persistence_1 = require("../utils/persistence");
const DEFAULT_RATE = 220; // 1 USDT = 220 ETB (fallback)
const PRICING_CONFIG_PATH = process.env.PRICING_CONFIG_PATH || path_1.default.join(process.cwd(), "data", "pricing-config.json");
const PRICING_CONFIG_FILE_STORE = String(process.env.PRICING_CONFIG_FILE_STORE || "true").toLowerCase() !== "false";
function getDefaultPricingConfig() {
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
    };
}
async function readPricingConfigFromFile() {
    try {
        const content = await promises_1.default.readFile(PRICING_CONFIG_PATH, "utf8");
        const parsed = JSON.parse(content);
        if (!parsed || typeof parsed !== "object")
            return null;
        return { ...getDefaultPricingConfig(), ...parsed };
    }
    catch {
        return null;
    }
}
async function writePricingConfigToFile(config) {
    const dir = path_1.default.dirname(PRICING_CONFIG_PATH);
    await promises_1.default.mkdir(dir, { recursive: true });
    await promises_1.default.writeFile(PRICING_CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
}
async function loadPricingConfig() {
    const useFileStore = PRICING_CONFIG_FILE_STORE || (0, persistence_1.isPrismaPersistenceEnabled)() || mongoose_1.default.connection.readyState !== 1;
    if (useFileStore) {
        const fromFile = await readPricingConfigFromFile();
        if (fromFile)
            return fromFile;
        const defaults = getDefaultPricingConfig();
        await writePricingConfigToFile(defaults);
        return defaults;
    }
    try {
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
            firstCardAmountUsd: 5,
            firstCardFeeUsd: 0,
        });
        return created;
    }
    catch {
        const fromFile = await readPricingConfigFromFile();
        if (fromFile)
            return fromFile;
        const defaults = getDefaultPricingConfig();
        await writePricingConfigToFile(defaults);
        return defaults;
    }
}
async function upsertPricingConfig(input) {
    const current = await loadPricingConfig();
    const update = { ...input };
    const useFileStore = PRICING_CONFIG_FILE_STORE || (0, persistence_1.isPrismaPersistenceEnabled)() || mongoose_1.default.connection.readyState !== 1;
    if (useFileStore) {
        const merged = { ...current, ...update, key: "default" };
        await writePricingConfigToFile(merged);
        return merged;
    }
    try {
        const next = await PricingConfig_1.default.findOneAndUpdate({ key: "default" }, { $set: update }, { new: true, upsert: true });
        return next ?? current;
    }
    catch {
        const merged = { ...current, ...update, key: "default" };
        await writePricingConfigToFile(merged);
        return merged;
    }
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
