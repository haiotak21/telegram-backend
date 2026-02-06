import mongoose, { Schema, Document, Model } from "mongoose";

export interface IUser extends Document {
  userId: string;
  balance: number;
  currency?: string;
  kycStatus?: "not_started" | "pending" | "approved" | "declined";
  strowalletCustomerId?: string;
  firstName?: string;
  lastName?: string;
  dateOfBirth?: string;
  phoneNumber?: string;
  customerEmail?: string;
  line1?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  country?: string;
  houseNumber?: string;
  idType?: "NIN" | "PASSPORT" | "DRIVING_LICENSE";
  idNumberEncrypted?: string;
  idNumberLast4?: string;
  idImageUrl?: string;
  idImageFrontUrl?: string;
  idImageBackUrl?: string;
  idImagePdfUrl?: string;
  userPhotoUrl?: string;
  kycSubmittedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const UserSchema = new Schema<IUser>(
  {
    userId: { type: String, required: true, unique: true, index: true },
    balance: { type: Number, required: true, default: 0 },
    currency: { type: String, default: "USDT" },
    kycStatus: { type: String, enum: ["not_started", "pending", "approved", "declined"], default: "not_started", index: true },
    strowalletCustomerId: { type: String },
    firstName: { type: String },
    lastName: { type: String },
    dateOfBirth: { type: String },
    phoneNumber: { type: String },
    customerEmail: { type: String },
    line1: { type: String },
    city: { type: String },
    state: { type: String },
    zipCode: { type: String },
    country: { type: String },
    houseNumber: { type: String },
    idType: { type: String, enum: ["NIN", "PASSPORT", "DRIVING_LICENSE"] },
    idNumberEncrypted: { type: String },
    idNumberLast4: { type: String },
    idImageUrl: { type: String },
    idImageFrontUrl: { type: String },
    idImageBackUrl: { type: String },
    idImagePdfUrl: { type: String },
    userPhotoUrl: { type: String },
    kycSubmittedAt: { type: Date },
  },
  { timestamps: true }
);

export const User: Model<IUser> = mongoose.models.User || mongoose.model<IUser>("User", UserSchema);

export default User;
