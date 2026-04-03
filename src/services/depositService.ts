import mongoose from "mongoose";
import { verifyPayment, PaymentMethod } from "./paymentVerification";
import Transaction from "../models/Transaction";
import User from "../models/User";
import { loadPricingConfig, quoteDeposit } from "./pricingService";
import prisma from "../utils/prisma";
import { isPrismaPersistenceEnabled } from "../utils/persistence";

const EXPECTED_CBE_RECEIVER_NAME = (process.env.CBE_RECEIVER_NAME || process.env.RECEIVER_NAME || "Addisu melke admasu").trim();
const EXPECTED_TELEBIRR_RECEIVER_NAME = (process.env.TELEBIRR_RECEIVER_NAME || "Addisu melke admasu").trim();
const MIN_DEPOSIT_ETB = Number(process.env.MIN_DEPOSIT_ETB || 1000);

export type DepositResult = {
  success: boolean;
  message?: string;
  alreadyProcessed?: boolean;
  status?: string;
  transactionId?: any;
  creditedUsdt?: number;
  feeEtb?: number | null;
  rate?: number | null;
  newBalance?: number | null;
};

function amountsClose(a: number, b: number, tol = 0.01) {
  return Math.abs(a - b) <= tol;
}

function normalizeName(value?: string) {
  return (value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function namesMatchExact(expectedRaw: string, actualRaw?: string) {
  const expected = normalizeName(expectedRaw);
  const actual = normalizeName(actualRaw);
  if (!expected || !actual) return false;
  return expected === actual;
}

function extractReceiverName(verificationBody: any) {
  const raw = verificationBody?.raw ?? verificationBody ?? {};
  const candidate = raw?.transactionDetails || raw?.data?.transactionDetails || raw?.data || raw;
  return (
    candidate?.creditedPartyName ||
    candidate?.receiverName ||
    candidate?.receiver ||
    candidate?.recipientName ||
    candidate?.to ||
    candidate?.payeeName ||
    candidate?.creditedName ||
    raw?.creditedPartyName
  );
}

async function createFailedDepositAttemptPrisma(params: {
  userId: string;
  paymentMethod: PaymentMethod;
  amount: number;
  transactionNumber: string;
  responseData: any;
}) {
  const { userId, paymentMethod, amount, transactionNumber, responseData } = params;
  await prisma.transaction.create({
    data: {
      userId,
      transactionType: "deposit",
      paymentMethod,
      amount,
      transactionNumber,
      status: "failed",
      responseData: responseData as any,
    },
  });
}

async function creditVerifiedDepositPrisma(params: {
  userId: string;
  paymentMethod: PaymentMethod;
  amountEtb: number;
  transactionNumber: string;
  referenceNumber?: string;
  responseData?: any;
}): Promise<DepositResult> {
  const { userId, paymentMethod, amountEtb, transactionNumber, referenceNumber, responseData } = params;

  if (!amountEtb || amountEtb < MIN_DEPOSIT_ETB) {
    return { success: false, message: `Minimum deposit amount is ${MIN_DEPOSIT_ETB} ETB` };
  }

  const pricing = await loadPricingConfig();
  const quote = quoteDeposit(amountEtb, pricing);
  if (quote.creditedUsdt <= 0) {
    return { success: false, message: "Amount too low after fees" };
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { userId } });
      if (!user) {
        throw new Error("User not found");
      }

      const existing = await tx.transaction.findFirst({
        where: {
          paymentMethod,
          transactionType: { in: ["deposit", "verification", "card"] },
          OR: [{ transactionNumber }, ...(referenceNumber ? [{ referenceNumber }] : [])],
        },
        orderBy: { createdAt: "desc" },
      });

      if (existing && String(existing.userId) !== userId) {
        throw new Error("This payment reference has already been used.");
      }

      if (existing && existing.status === "completed") {
        return {
          success: true,
          alreadyProcessed: true,
          status: "completed",
          message: "Deposit already processed",
          transactionId: existing.id,
          creditedUsdt: existing.amountUsdt ?? existing.amount,
          feeEtb: existing.feeEtb,
          rate: existing.rateSnapshot,
          newBalance: user.balance,
        };
      }

      if (existing) {
        throw new Error("This payment reference has already been used.");
      }

      const createdTx = await tx.transaction.create({
        data: {
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
          responseData: responseData as any,
        },
      });

      const updatedUser = await tx.user.update({
        where: { userId },
        data: { balance: { increment: quote.creditedUsdt } },
      });

      return {
        success: true,
        status: "completed",
        message: "Deposit credited successfully",
        transactionId: createdTx.id,
        creditedUsdt: quote.creditedUsdt,
        feeEtb: quote.feeEtb,
        rate: quote.rate,
        newBalance: updatedUser.balance,
      };
    });
  } catch (err: any) {
    return { success: false, message: err?.message || "Deposit failed" };
  }
}

async function processDepositPrisma(params: {
  userId: string;
  paymentMethod: PaymentMethod;
  amount: number;
  transactionNumber: string;
}): Promise<DepositResult> {
  const { userId, paymentMethod, amount, transactionNumber } = params;

  if (amount < MIN_DEPOSIT_ETB) {
    return { success: false, message: `Minimum deposit amount is ${MIN_DEPOSIT_ETB} ETB` };
  }

  const existing = await prisma.transaction.findFirst({
    where: { transactionType: "deposit", transactionNumber },
    orderBy: { createdAt: "desc" },
  });

  if (existing && existing.status === "completed") {
    const user = await prisma.user.findUnique({ where: { userId } });
    return {
      success: true,
      status: "completed",
      message: "Deposit already processed",
      transactionId: existing.id,
      newBalance: user?.balance ?? null,
      creditedUsdt: existing.amountUsdt ?? existing.amount,
      rate: existing.rateSnapshot,
      feeEtb: existing.feeEtb,
    };
  }

  if (existing) {
    return { success: false, message: "Duplicate transaction_number. Deposit already recorded." };
  }

  const verify = await verifyPayment({ paymentMethod, transactionNumber });
  if (!verify.body.success) {
    await createFailedDepositAttemptPrisma({
      userId,
      paymentMethod,
      amount,
      transactionNumber,
      responseData: verify.body.raw ?? verify.body,
    });
    return { success: false, message: verify.body.message || "Validation failed" };
  }

  const expectedReceiver = paymentMethod === "telebirr" ? EXPECTED_TELEBIRR_RECEIVER_NAME : EXPECTED_CBE_RECEIVER_NAME;
  const receiptReceiver = extractReceiverName(verify.body);
  if (expectedReceiver && !namesMatchExact(expectedReceiver, receiptReceiver)) {
    await createFailedDepositAttemptPrisma({
      userId,
      paymentMethod,
      amount,
      transactionNumber,
      responseData: verify.body.raw ?? verify.body,
    });
    return { success: false, message: "Receiver name does not match the expected payment account." };
  }

  const providerAmount = verify.body.amount;
  if (typeof providerAmount !== "number") {
    await createFailedDepositAttemptPrisma({
      userId,
      paymentMethod,
      amount,
      transactionNumber,
      responseData: verify.body.raw ?? verify.body,
    });
    return { success: false, message: "Provider did not return an amount" };
  }

  if (!amountsClose(providerAmount, amount)) {
    await createFailedDepositAttemptPrisma({
      userId,
      paymentMethod,
      amount,
      transactionNumber,
      responseData: verify.body.raw ?? verify.body,
    });
    return { success: false, message: "Payment amount does not match the selected deposit amount." };
  }

  const normalizedTxn = String(verify.body.transactionNumber || transactionNumber);
  const rawData = (verify.body.raw?.data ?? verify.body.raw ?? {}) as any;
  const referenceNumber = String(rawData?.reference || normalizedTxn);

  return await creditVerifiedDepositPrisma({
    userId,
    paymentMethod,
    amountEtb: amount,
    transactionNumber: normalizedTxn,
    referenceNumber,
    responseData: verify.body.raw ?? verify.body,
  });
}

export async function creditVerifiedDeposit(params: {
  userId: string;
  paymentMethod: PaymentMethod;
  amountEtb: number;
  transactionNumber: string;
  referenceNumber?: string;
  responseData?: any;
}): Promise<DepositResult> {
  if (isPrismaPersistenceEnabled()) {
    return creditVerifiedDepositPrisma(params);
  }

  const { userId, paymentMethod, amountEtb, transactionNumber, referenceNumber, responseData } = params;

  if (!amountEtb || amountEtb < MIN_DEPOSIT_ETB) {
    return { success: false, message: `Minimum deposit amount is ${MIN_DEPOSIT_ETB} ETB` };
  }

  const pricing = await loadPricingConfig();
  const quote = quoteDeposit(amountEtb, pricing);
  if (quote.creditedUsdt <= 0) {
    return { success: false, message: "Amount too low after fees" };
  }

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const user = await User.findOne({ userId }).session(session);
    if (!user) {
      throw new Error("User not found");
    }

    const query: any = {
      paymentMethod,
      transactionType: { $in: ["deposit", "verification", "card"] },
      $or: [{ transactionNumber }],
    };
    if (referenceNumber) {
      query.$or.push({ referenceNumber });
    }

    const existing = await Transaction.findOne(query).session(session).lean();
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

    const tx = await Transaction.create(
      [
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
      ],
      { session }
    );

    const updatedUser = await User.findOneAndUpdate(
      { userId },
      { $inc: { balance: quote.creditedUsdt } },
      { new: true, session }
    );

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
  } catch (err: any) {
    try {
      await session.abortTransaction();
    } catch {}
    session.endSession();
    return { success: false, message: err?.message || "Deposit failed" };
  }
}

export async function processDeposit(params: {
  userId: string;
  paymentMethod: PaymentMethod;
  amount: number;
  transactionNumber: string;
}): Promise<DepositResult> {
  if (isPrismaPersistenceEnabled()) {
    return processDepositPrisma(params);
  }

  const { userId, paymentMethod, amount, transactionNumber } = params;

  if (amount < MIN_DEPOSIT_ETB) {
    return { success: false, message: `Minimum deposit amount is ${MIN_DEPOSIT_ETB} ETB` };
  }

  const existing = await Transaction.findOne({ transactionType: "deposit", transactionNumber }).lean();
  if (existing && existing.status === "completed") {
    const user = await User.findOne({ userId }).lean();
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

  const expectedReceiver = paymentMethod === "telebirr" ? EXPECTED_TELEBIRR_RECEIVER_NAME : EXPECTED_CBE_RECEIVER_NAME;
  const receiptReceiver = extractReceiverName(verify.body);
  if (expectedReceiver && !namesMatchExact(expectedReceiver, receiptReceiver)) {
    await Transaction.create({
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
    return { success: false, message: "Payment amount does not match the selected deposit amount." };
  }

  const normalizedTxn = String(verify.body.transactionNumber || transactionNumber);
  const rawData = (verify.body.raw?.data ?? verify.body.raw ?? {}) as any;
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
