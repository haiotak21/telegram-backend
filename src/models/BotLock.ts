import mongoose from "mongoose";

const BotLockSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, index: true },
  ownerId: { type: String, required: true },
  expiresAt: { type: Date, required: true, index: true },
  createdAt: { type: Date, default: Date.now },
});

BotLockSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.models.BotLock || mongoose.model("BotLock", BotLockSchema);
