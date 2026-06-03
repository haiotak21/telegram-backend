import mongoose, { Schema, Document, Model } from "mongoose";

export interface IVirtualBankAccount extends Document {
  userId: string;
  provider: string;
  accountNumber: string;
  accountName?: string;
  bankName?: string;
  sessionId?: string;
  status?: string;
  currency?: string;
  responseData?: any;
  createdAt: Date;
  updatedAt: Date;
}

const VirtualBankAccountSchema = new Schema<IVirtualBankAccount>(
  {
    userId: { type: String, required: true, index: true },
    provider: { type: String, required: true },
    accountNumber: { type: String, required: true, unique: true, index: true },
    accountName: { type: String },
    bankName: { type: String },
    sessionId: { type: String },
    status: { type: String, default: "active" },
    currency: { type: String, default: "NGN" },
    responseData: { type: Schema.Types.Mixed },
  },
  { timestamps: true }
);

VirtualBankAccountSchema.index({ userId: 1, accountNumber: 1 });

export const VirtualBankAccount: Model<IVirtualBankAccount> =
  mongoose.models.VirtualBankAccount || mongoose.model<IVirtualBankAccount>("VirtualBankAccount", VirtualBankAccountSchema);

export default VirtualBankAccount;
