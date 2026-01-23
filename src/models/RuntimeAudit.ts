import mongoose from "mongoose";

const RuntimeAuditSchema = new mongoose.Schema({
  key: { type: String, required: true },
  oldValue: { type: mongoose.Schema.Types.Mixed },
  newValue: { type: mongoose.Schema.Types.Mixed },
  changedBy: { type: String },
  reason: { type: String },
  createdAt: { type: Date, default: () => new Date() },
});

const RuntimeAudit = mongoose.models.RuntimeAudit || mongoose.model("RuntimeAudit", RuntimeAuditSchema);
export default RuntimeAudit;
