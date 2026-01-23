import mongoose, { Schema, Document } from "mongoose";

export interface IWebhookEvent extends Document {
  eventId: string;
  type: string;
  created?: number;
  payload: any;
  receivedAt: Date;
}

const WebhookEventSchema = new Schema<IWebhookEvent>({
  eventId: { type: String, required: true, unique: true },
  type: { type: String, required: true },
  created: { type: Number },
  payload: { type: Schema.Types.Mixed, required: true },
  receivedAt: { type: Date, default: () => new Date() },
});

export const WebhookEvent = mongoose.model<IWebhookEvent>("WebhookEvent", WebhookEventSchema);
