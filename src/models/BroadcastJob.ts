import mongoose, { Schema, Document, Model } from "mongoose";

export type BroadcastFilter = "all" | "kyc_approved" | "balance_positive";
export type BroadcastStatus = "pending" | "sending" | "completed" | "failed";

export interface IBroadcastJob extends Document {
  createdBy?: string;
  messageText: string;
  imageUrl?: string;
  targetFilter: BroadcastFilter;
  targetUserIds: string[];
  targetCount: number;
  processedCount: number;
  successCount: number;
  failureCount: number;
  status: BroadcastStatus;
  lastError?: string;
  startedAt?: Date;
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const BroadcastJobSchema = new Schema<IBroadcastJob>(
  {
    createdBy: { type: String },
    messageText: { type: String, required: true },
    imageUrl: { type: String },
    targetFilter: { type: String, enum: ["all", "kyc_approved", "balance_positive"], required: true },
    targetUserIds: { type: [String], default: [] },
    targetCount: { type: Number, required: true, default: 0 },
    processedCount: { type: Number, required: true, default: 0 },
    successCount: { type: Number, required: true, default: 0 },
    failureCount: { type: Number, required: true, default: 0 },
    status: { type: String, enum: ["pending", "sending", "completed", "failed"], required: true, default: "pending", index: true },
    lastError: { type: String },
    startedAt: { type: Date },
    completedAt: { type: Date },
  },
  { timestamps: true }
);

BroadcastJobSchema.index({ createdAt: -1 });

export const BroadcastJob: Model<IBroadcastJob> =
  mongoose.models.BroadcastJob || mongoose.model<IBroadcastJob>("BroadcastJob", BroadcastJobSchema);

export default BroadcastJob;
