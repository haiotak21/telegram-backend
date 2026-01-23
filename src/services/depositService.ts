import mongoose from "mongoose";
import { verifyPayment, PaymentMethod } from "./paymentVerification";
import { getFakeTopup } from "./runtimeConfigService";
import Transaction from "../models/Transaction";
import User from "../models/User";
import RuntimeAudit from "../models/RuntimeAudit";
import { loadPricingConfig, quoteDeposit } from "./pricingService";

function amountsClose(a: number, b: number, tol = 0.01) {
  return Math.abs(a - b) <= tol;
}

export async function processDeposit(params: {
  userId: string;
  paymentMethod: PaymentMethod;
  amount: number;
  transactionNumber: string;
}) {
  const { userId, paymentMethod, amount, transactionNumber } = params;

  if (amount <= 0) {
    return { success: false, message: "Amount must be greater than zero" };
  }

  const pricing = await loadPricingConfig();
  const quote = quoteDeposit(amount, pricing);
  if (quote.creditedUsdt <= 0) {
    return { success: false, message: "Amount too low after fees" };
  }

  const existing = await Transaction.findOne({ transactionType: "deposit", transactionNumber }).lean();
  if (existing && existing.status === "completed") {
    const user = await User.findOne({ userId }).lean();
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
  const runtimeFake = await getFakeTopup();
  if (!runtimeFake) {
    const verify = await verifyPayment({ paymentMethod, transactionNumber });
    if (!verify.body.success) {
      await Transaction.create({
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
      await Transaction.create({
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
      await Transaction.create({
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

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    // If runtime fake, immediately credit user and mark completed
    if (runtimeFake) {
      const tx = await Transaction.create([
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

      const user = await User.findOneAndUpdate(
        { userId },
        { $inc: { balance: quote.creditedUsdt }, $setOnInsert: { currency: "USDT" } },
        { new: true, upsert: true, session }
      );

      // Record audit entry for simulated deposit
      try {
        await RuntimeAudit.create({
          key: "simulated_deposit",
          oldValue: null,
          newValue: { userId, transactionNumber, creditedUsdt: quote.creditedUsdt, amountEtb: amount },
          changedBy: "system",
          reason: "Auto-credited simulated deposit while FAKE_TOPUP enabled",
        });
      } catch (e: any) {
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

    const tx = await Transaction.create(
      [
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
      ],
      { session }
    );

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
  } catch (err: any) {
    try {
      await session.abortTransaction();
    } catch {}
    session.endSession();
    return { success: false, message: err?.message || "Deposit failed" };
  }
}
