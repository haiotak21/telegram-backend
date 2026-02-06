import mongoose, { Schema, Document, Model } from "mongoose";

export interface ICard extends Document {
  cardId: string;
  userId?: string;
  customerEmail?: string;
  nameOnCard?: string;
  cardType?: string;
  status?: string;
  last4?: string;
  currency?: string;
  balance?: string;
  availableBalance?: string;
  lastSync?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const CardSchema = new Schema<ICard>(
  {
    cardId: { type: String, required: true, unique: true, index: true },
    userId: { type: String, index: true },
    customerEmail: { type: String, index: true },
    nameOnCard: { type: String },
    cardType: { type: String },
    status: { type: String },
    last4: { type: String },
    currency: { type: String },
    balance: { type: String },
    availableBalance: { type: String },
    lastSync: { type: Date },
  },
  { timestamps: true }
);

CardSchema.index({ userId: 1, customerEmail: 1, cardId: 1 });

export const Card: Model<ICard> = mongoose.models.Card || mongoose.model<ICard>("Card", CardSchema);

export default Card;
