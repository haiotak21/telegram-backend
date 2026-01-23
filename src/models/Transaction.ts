import mongoose, { Schema, Document, Model } from "mongoose";

export type TransactionStatus = "pending" | "completed" | "failed" | "cancelled";
export type TransactionType = "deposit" | "withdrawal" | "manual_deposit" | "system" | "verification";
export type PaymentMethodType = "telebirr" | "cbe" | "system";

export interface ITransaction extends Document {
  userId: string;
  transactionType: TransactionType;
  paymentMethod: PaymentMethodType;
  amount: number;
  currency?: string;
  amountEtb?: number;
  amountUsdt?: number;
  feeEtb?: number;
  feeUsdt?: number;
  rateSnapshot?: number;
  transactionNumber?: string;
  referenceNumber?: string;
  status: TransactionStatus;
  responseData?: any;
  metadata?: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

const TransactionSchema = new Schema<ITransaction>(
  {
    userId: { type: String, required: true, index: true },
    transactionType: { type: String, enum: ["deposit", "withdrawal", "manual_deposit", "system", "verification"], required: true, default: "deposit" },
    paymentMethod: { type: String, enum: ["telebirr", "cbe", "system"], required: true },
    amount: { type: Number, required: true },
    currency: { type: String },
    amountEtb: { type: Number },
    amountUsdt: { type: Number },
    feeEtb: { type: Number },
    feeUsdt: { type: Number },
    rateSnapshot: { type: Number },
    transactionNumber: { type: String, required: false },
    referenceNumber: { type: String, required: false },
    status: { type: String, enum: ["pending", "completed", "failed", "cancelled"], required: true, default: "pending" },
    responseData: { type: Schema.Types.Mixed },
    metadata: { type: Schema.Types.Mixed },
  },
  { timestamps: true }
);

// Idempotency for verification-only: unique per (transactionType, transactionNumber, userId)
TransactionSchema.index(
  { transactionType: 1, transactionNumber: 1, userId: 1 },
  { unique: true, sparse: true }
);

// Also enforce uniqueness when the reference number is used
TransactionSchema.index(
  { transactionType: 1, referenceNumber: 1, userId: 1 },
  { unique: true, sparse: true }
);

export const Transaction: Model<ITransaction> = mongoose.models.Transaction || mongoose.model<ITransaction>("Transaction", TransactionSchema);

export default Transaction;
