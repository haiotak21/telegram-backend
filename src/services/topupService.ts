import axios from "axios";
import mongoose from "mongoose";
import Transaction from "../models/Transaction";
import User from "../models/User";
import { enforceTopupLimits, loadPricingConfig, quoteTopup } from "./pricingService";

const BITVCARD_BASE = "https://strowallet.com/api/bitvcard/";

function getDefaultMode() {
  return process.env.STROWALLET_DEFAULT_MODE || (process.env.NODE_ENV !== "production" ? "sandbox" : undefined);
}

function normalizeMode(mode?: string) {
  if (!mode) return undefined;
  const m = String(mode).toLowerCase();
  if (m === "live") return undefined;
  return m;
}

function requirePublicKey() {
  const key = process.env.STROWALLET_PUBLIC_KEY;
  if (!key) {
    const err = new Error("Missing STROWALLET_PUBLIC_KEY env");
    (err as any).status = 500;
    throw err;
  }
  return key;
}

async function fundCard(cardId: string, amount: number, mode?: string) {
  const public_key = requirePublicKey();
  const resolvedMode = normalizeMode(mode ?? getDefaultMode());
  const payload = { card_id: cardId, amount: amount.toString(), public_key, mode: resolvedMode };
  const resp = await axios.post(`${BITVCARD_BASE}fund-card/`, payload, { timeout: 20000 });
  return resp.data;
}

export async function topUpCard(params: { userId: string; cardId: string; amountUsdt: number; mode?: string }) {
  const { userId, cardId, amountUsdt, mode } = params;
  if (!amountUsdt || amountUsdt <= 0) {
    return { success: false, message: "Top-up amount must be greater than zero" };
  }

  const pricing = await loadPricingConfig();
  enforceTopupLimits(amountUsdt, pricing);
  const quote = quoteTopup(amountUsdt, pricing);

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    let user = await User.findOne({ userId }).session(session);
    if (!user) {
      user = await User.create([{ userId, balance: 0, currency: "USDT" }], { session }).then((r) => r[0]);
    }
    if (!user) {
      throw Object.assign(new Error("User not initialized"), { status: 500 });
    }

    const txnNumber = `TOPUP-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const tx = await Transaction.create(
      [
        {
          userId,
          transactionType: "withdrawal",
          paymentMethod: "system",
          amount: quote.totalChargeUsdt,
          amountUsdt,
          feeUsdt: quote.feeUsdt,
          currency: "USDT",
          status: "pending",
          transactionNumber: txnNumber,
          referenceNumber: txnNumber,
          metadata: { cardId, mode },
        },
      ],
      { session }
    );

    if (user.balance < quote.totalChargeUsdt) {
      throw Object.assign(new Error("Insufficient balance"), { status: 400 });
    }

    const updatedUser = await User.findOneAndUpdate(
      { userId, balance: { $gte: quote.totalChargeUsdt } },
      { $inc: { balance: -quote.totalChargeUsdt }, $setOnInsert: { currency: "USDT" } },
      { new: true, upsert: false, session }
    );

    if (!updatedUser) {
      throw Object.assign(new Error("Insufficient balance"), { status: 400 });
    }

    const providerResponse = await fundCard(cardId, amountUsdt, mode);

    await Transaction.updateOne(
      { _id: tx[0]._id },
      { $set: { status: "completed", responseData: providerResponse, referenceNumber: providerResponse?.id || providerResponse?.ref } },
      { session }
    );

    await session.commitTransaction();
    session.endSession();

    return {
      success: true,
      message: "Card topped up successfully",
      transactionId: tx[0]._id,
      chargedUsdt: quote.totalChargeUsdt,
      topupAmountUsdt: amountUsdt,
      feeUsdt: quote.feeUsdt,
      newBalance: updatedUser.balance,
      providerResponse,
    };
  } catch (err: any) {
    try {
      await session.abortTransaction();
    } catch {}
    session.endSession();

    const status = err?.status || err?.response?.status || 500;
    const message = err?.message || err?.response?.data?.error || "Top-up failed";
    return { success: false, message, status };
  }
}
