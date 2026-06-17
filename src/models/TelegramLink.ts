import mongoose, { Schema, Document } from "mongoose";

export interface ITelegramLink extends Document {
  chatId: number;
  customerEmail?: string;
  cardIds: string[];
  referrerUserId?: string;
  referredAt?: Date;
}

const TelegramLinkSchema = new Schema<ITelegramLink>({
  chatId: { type: Number, required: true, unique: true },
  customerEmail: { type: String },
  cardIds: { type: [String], default: [] },
  referrerUserId: { type: String },
  referredAt: { type: Date },
});

export const TelegramLink = mongoose.model<ITelegramLink>("TelegramLink", TelegramLinkSchema);
