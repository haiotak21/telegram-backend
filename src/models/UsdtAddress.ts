import mongoose, { Schema, Document, Model } from "mongoose";

export interface IUsdtAddress extends Document {
  userId: string;
  address: string;
  label?: string;
  network?: string;
  status?: string;
  responseData?: any;
  createdAt: Date;
  updatedAt: Date;
}

const UsdtAddressSchema = new Schema<IUsdtAddress>(
  {
    userId: { type: String, required: true, index: true },
    address: { type: String, required: true, unique: true, index: true },
    label: { type: String },
    network: { type: String, default: "TRC20" },
    status: { type: String, default: "active" },
    responseData: { type: Schema.Types.Mixed },
  },
  { timestamps: true }
);

UsdtAddressSchema.index({ userId: 1, address: 1 });

export const UsdtAddress: Model<IUsdtAddress> =
  mongoose.models.UsdtAddress || mongoose.model<IUsdtAddress>("UsdtAddress", UsdtAddressSchema);

export default UsdtAddress;
