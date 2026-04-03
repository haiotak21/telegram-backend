"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.creditVerifiedDeposit = creditVerifiedDeposit;
exports.processDeposit = processDeposit;
const mongoose_1 = __importDefault(require("mongoose"));
const paymentVerification_1 = require("./paymentVerification");
const Transaction_1 = __importDefault(require("../models/Transaction"));
const User_1 = __importDefault(require("../models/User"));
const pricingService_1 = require("./pricingService");
const EXPECTED_CBE_RECEIVER_NAME = (process.env.CBE_RECEIVER_NAME || process.env.RECEIVER_NAME || "Addisu melke admasu").trim();
const EXPECTED_TELEBIRR_RECEIVER_NAME = (process.env.TELEBIRR_RECEIVER_NAME || "Addisu melke admasu").trim();
const MIN_DEPOSIT_ETB = Number(process.env.MIN_DEPOSIT_ETB || 1000);
function amountsClose(a, b, tol = 0.01) {
    return Math.abs(a - b) <= tol;
}
function normalizeName(value) {
    return (value || "").trim().toLowerCase().replace(/\s+/g, " ");
}
function namesMatchExact(expectedRaw, actualRaw) {
    const expected = normalizeName(expectedRaw);
    const actual = normalizeName(actualRaw);
    if (!expected || !actual)
        return false;
    return expected === actual;
}
function extractReceiverName(verificationBody) {
    const raw = verificationBody?.raw ?? verificationBody ?? {};
    const candidate = raw?.transactionDetails || raw?.data?.transactionDetails || raw?.data || raw;
    return (candidate?.creditedPartyName ||
        candidate?.receiverName ||
        candidate?.receiver ||
        candidate?.recipientName ||
        candidate?.to ||
        candidate?.payeeName ||
        candidate?.creditedName ||
        raw?.creditedPartyName);
}
async function creditVerifiedDeposit(params) {
    const { userId, paymentMethod, amountEtb, transactionNumber, referenceNumber, responseData } = params;
    if (!amountEtb || amountEtb < MIN_DEPOSIT_ETB) {
        return { success: false, message: `Minimum deposit amount is ${MIN_DEPOSIT_ETB} ETB` };
    }
    const pricing = await (0, pricingService_1.loadPricingConfig)();
    const quote = (0, pricingService_1.quoteDeposit)(amountEtb, pricing);
    if (quote.creditedUsdt <= 0) {
        return { success: false, message: "Amount too low after fees" };
    }
    const session = await mongoose_1.default.startSession();
    session.startTransaction();
    try {
        const user = await User_1.default.findOne({ userId }).session(session);
        if (!user) {
            throw new Error("User not found");
        }
        const query = {
            paymentMethod,
            transactionType: { $in: ["deposit", "verification", "card"] },
            $or: [{ transactionNumber }],
        };
        if (referenceNumber) {
            query.$or.push({ referenceNumber });
        }
        const existing = await Transaction_1.default.findOne(query).session(session).lean();
        if (existing && String(existing.userId) !== userId) {
            throw new Error("This payment reference has already been used.");
        }
        if (existing && existing.status === "completed") {
            await session.commitTransaction();
            session.endSession();
            return {
                success: true,
                alreadyProcessed: true,
                status: "completed",
                message: "Deposit already processed",
                transactionId: existing._id,
                creditedUsdt: existing.amountUsdt ?? existing.amount,
                feeEtb: existing.feeEtb,
                rate: existing.rateSnapshot,
                newBalance: user.balance,
            };
        }
        if (existing) {
            throw new Error("This payment reference has already been used.");
        }
        const tx = await Transaction_1.default.create([
            {
                userId,
                transactionType: "deposit",
                paymentMethod,
                amount: quote.creditedUsdt,
                amountEtb,
                amountUsdt: quote.creditedUsdt,
                feeEtb: quote.feeEtb,
                currency: "USDT",
                rateSnapshot: quote.rate,
                transactionNumber,
                referenceNumber,
                status: "completed",
                verified: true,
                responseData,
            },
        ], { session });
        const updatedUser = await User_1.default.findOneAndUpdate({ userId }, { $inc: { balance: quote.creditedUsdt } }, { new: true, session });
        if (!updatedUser) {
            throw new Error("User not found");
        }
        await session.commitTransaction();
        session.endSession();
        return {
            success: true,
            status: "completed",
            message: "Deposit credited successfully",
            transactionId: tx[0]._id,
            creditedUsdt: quote.creditedUsdt,
            feeEtb: quote.feeEtb,
            rate: quote.rate,
            newBalance: updatedUser.balance,
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
async function processDeposit(params) {
    const { userId, paymentMethod, amount, transactionNumber } = params;
    if (amount < MIN_DEPOSIT_ETB) {
        return { success: false, message: `Minimum deposit amount is ${MIN_DEPOSIT_ETB} ETB` };
    }
    const existing = await Transaction_1.default.findOne({ transactionType: "deposit", transactionNumber }).lean();
    if (existing && existing.status === "completed") {
        const user = await User_1.default.findOne({ userId }).lean();
        return {
            success: true,
            status: "completed",
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
    const expectedReceiver = paymentMethod === "telebirr" ? EXPECTED_TELEBIRR_RECEIVER_NAME : EXPECTED_CBE_RECEIVER_NAME;
    const receiptReceiver = extractReceiverName(verify.body);
    if (expectedReceiver && !namesMatchExact(expectedReceiver, receiptReceiver)) {
        await Transaction_1.default.create({
            userId,
            transactionType: "deposit",
            paymentMethod,
            amount,
            transactionNumber,
            status: "failed",
            responseData: verify.body.raw ?? verify.body,
        });
        return { success: false, message: "Receiver name does not match the expected payment account." };
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
        return { success: false, message: "Payment amount does not match the selected deposit amount." };
    }
    const normalizedTxn = String(verify.body.transactionNumber || transactionNumber);
    const rawData = (verify.body.raw?.data ?? verify.body.raw ?? {});
    const referenceNumber = String(rawData?.reference || normalizedTxn);
    return await creditVerifiedDeposit({
        userId,
        paymentMethod,
        amountEtb: amount,
        transactionNumber: normalizedTxn,
        referenceNumber,
        responseData: verify.body.raw ?? verify.body,
    });
}
