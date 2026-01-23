import mongoose, { Schema, Document, Model } from "mongoose";

export type CardRequestStatus = "pending" | "approved" | "declined";

export interface ICardRequest extends Document {
  userId: string;
  nameOnCard?: string;
  cardType?: string;
  amount?: string;
  customerEmail?: string;
  mode?: string;
  status: CardRequestStatus;
  adminNote?: string;
  decisionReason?: string;
  cardId?: string;
   cardNumber?: string;
   cvc?: string;
  responseData?: any;
  metadata?: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

const CardRequestSchema = new Schema<ICardRequest>(
  {
    userId: { type: String, required: true, index: true },
    nameOnCard: { type: String },
    cardType: { type: String },
    amount: { type: String },
    customerEmail: { type: String },
    mode: { type: String },
    status: { type: String, enum: ["pending", "approved", "declined"], required: true, default: "pending", index: true },
    adminNote: { type: String },
    decisionReason: { type: String },
    cardId: { type: String },
    cardNumber: { type: String },
    cvc: { type: String },
    responseData: { type: Schema.Types.Mixed },
    metadata: { type: Schema.Types.Mixed },
  },
  { timestamps: true }
);

CardRequestSchema.index({ userId: 1, status: 1, createdAt: -1 });

export const CardRequest: Model<ICardRequest> =
  mongoose.models.CardRequest || mongoose.model<ICardRequest>("CardRequest", CardRequestSchema);

export default CardRequest;
