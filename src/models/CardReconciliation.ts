import mongoose, { Schema, Document, Model } from "mongoose";

export interface ICardReconciliation extends Document {
  cardId: string;
  userId?: string;
  customerEmail?: string;
  localBalance?: number;
  externalBalance?: number;
  discrepancy: boolean;
  checkedAt: Date;
  metadata?: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

const CardReconciliationSchema = new Schema<ICardReconciliation>(
  {
    cardId: { type: String, required: true, index: true },
    userId: { type: String, index: true },
    customerEmail: { type: String, index: true },
    localBalance: { type: Number },
    externalBalance: { type: Number },
    discrepancy: { type: Boolean, default: false, index: true },
    checkedAt: { type: Date, required: true, index: true },
    metadata: { type: Schema.Types.Mixed },
  },
  { timestamps: true }
);

CardReconciliationSchema.index({ cardId: 1, checkedAt: -1 });

export const CardReconciliation: Model<ICardReconciliation> =
  mongoose.models.CardReconciliation ||
  mongoose.model<ICardReconciliation>("CardReconciliation", CardReconciliationSchema);

export default CardReconciliation;
