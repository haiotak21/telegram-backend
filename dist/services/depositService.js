"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.processDeposit = processDeposit;
const mongoose_1 = __importDefault(require("mongoose"));
const paymentVerification_1 = require("./paymentVerification");
const runtimeConfigService_1 = require("./runtimeConfigService");
const Transaction_1 = __importDefault(require("../models/Transaction"));
const User_1 = __importDefault(require("../models/User"));
const RuntimeAudit_1 = __importDefault(require("../models/RuntimeAudit"));
const pricingService_1 = require("./pricingService");
function amountsClose(a, b, tol = 0.01) {
    return Math.abs(a - b) <= tol;
}
async function processDeposit(params) {
    const { userId, paymentMethod, amount, transactionNumber } = params;
    if (amount <= 0) {
        return { success: false, message: "Amount must be greater than zero" };
    }
    const pricing = await (0, pricingService_1.loadPricingConfig)();
    const quote = (0, pricingService_1.quoteDeposit)(amount, pricing);
    if (quote.creditedUsdt <= 0) {
        return { success: false, message: "Amount too low after fees" };
    }
    const existing = await Transaction_1.default.findOne({ transactionType: "deposit", transactionNumber }).lean();
    if (existing && existing.status === "completed") {
        const user = await User_1.default.findOne({ userId }).lean();
        return {
            success: true,
            message: "Deposit already processed",
            transactionId: existing._id,
            newBalance: user?.balance ?? null,
            creditedUsdt: existing.amountUsdt ?? existing.amount,
            rate: existing.rateSnapshot,
            feeEtb: existing.feeEtb,
        };
    }
    if (existing) {
        return { success: false, message: "Duplicate transaction_number. Deposit already recorded." };
    }
    // If runtime fake-topup is enabled, skip provider verification and auto-complete
    const runtimeFake = await (0, runtimeConfigService_1.getFakeTopup)();
    if (!runtimeFake) {
        const verify = await (0, paymentVerification_1.verifyPayment)({ paymentMethod, transactionNumber });
        if (!verify.body.success) {
            await Transaction_1.default.create({
                userId,
                transactionType: "deposit",
                paymentMethod,
                amount,
                transactionNumber,
                status: "failed",
                responseData: verify.body.raw ?? verify.body,
            });
            return { success: false, message: verify.body.message || "Validation failed" };
        }
        const providerAmount = verify.body.amount;
        if (typeof providerAmount !== "number") {
            await Transaction_1.default.create({
                userId,
                transactionType: "deposit",
                paymentMethod,
                amount,
                transactionNumber,
                status: "failed",
                responseData: verify.body.raw ?? verify.body,
            });
            return { success: false, message: "Provider did not return an amount" };
        }
        if (!amountsClose(providerAmount, amount)) {
            await Transaction_1.default.create({
                userId,
                transactionType: "deposit",
                paymentMethod,
                amount,
                transactionNumber,
                status: "failed",
                responseData: verify.body.raw ?? verify.body,
            });
            return { success: false, message: "Amount mismatch" };
        }
    }
    const session = await mongoose_1.default.startSession();
    session.startTransaction();
    try {
        // If runtime fake, immediately credit user and mark completed
        if (runtimeFake) {
            const tx = await Transaction_1.default.create([
                {
                    userId,
                    transactionType: "deposit",
                    paymentMethod,
                    amount: quote.creditedUsdt,
                    amountEtb: amount,
                    amountUsdt: quote.creditedUsdt,
                    feeEtb: quote.feeEtb,
                    currency: "USDT",
                    rateSnapshot: quote.rate,
                    transactionNumber,
                    status: "completed",
                    responseData: { simulated: true },
                },
            ], { session });
            const user = await User_1.default.findOneAndUpdate({ userId }, { $inc: { balance: quote.creditedUsdt }, $setOnInsert: { currency: "USDT" } }, { new: true, upsert: true, session });
            // Record audit entry for simulated deposit
            try {
                await RuntimeAudit_1.default.create({
                    key: "simulated_deposit",
                    oldValue: null,
                    newValue: { userId, transactionNumber, creditedUsdt: quote.creditedUsdt, amountEtb: amount },
                    changedBy: "system",
                    reason: "Auto-credited simulated deposit while FAKE_TOPUP enabled",
                });
            }
            catch (e) {
                console.warn("Failed to write runtime audit for simulated deposit:", e?.message || e);
            }
            await session.commitTransaction();
            session.endSession();
            return {
                success: true,
                message: "Deposit recorded (simulated) and credited.",
                transactionId: tx[0]._id,
                creditedUsdt: quote.creditedUsdt,
                feeEtb: quote.feeEtb,
                rate: quote.rate,
                newBalance: user?.balance ?? null,
            };
        }
        const tx = await Transaction_1.default.create([
            {
                userId,
                transactionType: "deposit",
                paymentMethod,
                amount: quote.creditedUsdt,
                amountEtb: amount,
                amountUsdt: quote.creditedUsdt,
                feeEtb: quote.feeEtb,
                currency: "USDT",
                rateSnapshot: quote.rate,
                transactionNumber,
                status: "pending",
                responseData: undefined,
            },
        ], { session });
        await session.commitTransaction();
        session.endSession();
        return {
            success: true,
            message: "Deposit recorded. Awaiting admin approval.",
            transactionId: tx[0]._id,
            creditedUsdt: quote.creditedUsdt,
            feeEtb: quote.feeEtb,
            rate: quote.rate,
        };
    }
    catch (err) {
        try {
            await session.abortTransaction();
        }
        catch { }
        session.endSession();
        return { success: false, message: err?.message || "Deposit failed" };
    }
}
