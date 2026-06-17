import mongoose, { Schema, Document, Model } from "mongoose";

export interface IPricingConfig extends Document {
  key: string;
  usdtRate: number; // ETB per 1 USDT
  depositPercentFee: number; // percent, e.g., 2 means 2%
  depositFlatFee: number; // ETB flat fee per deposit
  topupPercentFee: number; // percent, e.g., 1.5 means 1.5%
  topupFlatFee: number; // USDT flat fee per top-up
  topupMin?: number; // Minimum top-up amount in USDT
  topupMax?: number; // Maximum top-up amount in USDT
  cardRequestFeeEtb?: number; // flat fee in ETB for card requests
  cardRequestWalletFeeTier1Usd?: number;
  cardRequestWalletFeeTier2Usd?: number;
  cardRequestWalletFeeTier3Usd?: number;
  topupCommissionPercent?: number;
  transferFeePercent?: number;
  billPaymentFeePercent?: number;
  firstCardAmountUsd?: number; // card load amount in USD for first card request
  firstCardFeeUsd?: number; // processing fee in USD for first card request
  updatedBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

const PricingConfigSchema = new Schema<IPricingConfig>(
  {
    key: { type: String, required: true, unique: true, default: "default" },
    usdtRate: { type: Number, required: true },
    depositPercentFee: { type: Number, required: true, default: 0 },
    depositFlatFee: { type: Number, required: true, default: 0 },
    topupPercentFee: { type: Number, required: true, default: 0 },
    topupFlatFee: { type: Number, required: true, default: 0 },
    topupMin: { type: Number },
    topupMax: { type: Number },
    cardRequestFeeEtb: { type: Number, default: 0 },
    cardRequestWalletFeeTier1Usd: { type: Number, default: 2 },
    cardRequestWalletFeeTier2Usd: { type: Number, default: 3 },
    cardRequestWalletFeeTier3Usd: { type: Number, default: 5 },
    topupCommissionPercent: { type: Number, default: 10 },
    transferFeePercent: { type: Number, default: 0 },
    billPaymentFeePercent: { type: Number, default: 0 },
    firstCardAmountUsd: { type: Number, default: 5 },
    firstCardFeeUsd: { type: Number, default: 0 },
    updatedBy: { type: String },
  },
  { timestamps: true }
);

export const PricingConfig: Model<IPricingConfig> =
  mongoose.models.PricingConfig || mongoose.model<IPricingConfig>("PricingConfig", PricingConfigSchema);

export default PricingConfig;
