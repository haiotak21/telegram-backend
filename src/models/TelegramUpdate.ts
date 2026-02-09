import mongoose from "mongoose";

const TelegramUpdateSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, index: true },
  createdAt: {
    type: Date,
    default: () => new Date(),
    // Automatically expire processed update keys after a short window
    expires: 300, // 5 minutes
  },
});

const TelegramUpdate =
  mongoose.models.TelegramUpdate || mongoose.model("TelegramUpdate", TelegramUpdateSchema);

export default TelegramUpdate;

