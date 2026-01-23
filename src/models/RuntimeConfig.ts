import mongoose from "mongoose";

const RuntimeConfigSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  value: { type: mongoose.Schema.Types.Mixed, required: true },
});

const RuntimeConfig = mongoose.models.RuntimeConfig || mongoose.model("RuntimeConfig", RuntimeConfigSchema);
export default RuntimeConfig;
