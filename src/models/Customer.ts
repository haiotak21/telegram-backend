import mongoose, { Schema, Document, Model } from "mongoose";

export type CustomerKycStatus = "pending" | "approved" | "rejected";

export interface ICustomer extends Document {
  customerId?: string;
  userId: string;
  email?: string;
  telegramId?: string;
  chatId?: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  dateOfBirth?: string;
  phoneNumber?: string;
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
  kycStatus: CustomerKycStatus;
  submittedAt?: Date;
  approvedAt?: Date;
  rawPayload?: any;
  createdAt: Date;
  updatedAt: Date;
}

const CustomerSchema = new Schema<ICustomer>(
  {
    customerId: { type: String, index: true },
    userId: { type: String, required: true, index: true },
    email: { type: String, index: true },
    telegramId: { type: String, index: true },
    chatId: { type: String },
    username: { type: String },
    firstName: { type: String },
    lastName: { type: String },
    dateOfBirth: { type: String },
    phoneNumber: { type: String },
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
    kycStatus: { type: String, enum: ["pending", "approved", "rejected"], default: "pending", index: true },
    submittedAt: { type: Date },
    approvedAt: { type: Date },
    rawPayload: { type: Schema.Types.Mixed },
  },
  { timestamps: true }
);

CustomerSchema.index({ customerId: 1, userId: 1 }, { unique: true, sparse: true });

export const Customer: Model<ICustomer> = mongoose.models.Customer || mongoose.model<ICustomer>("Customer", CustomerSchema);

export default Customer;
