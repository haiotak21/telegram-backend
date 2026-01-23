"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const mongoose_1 = __importDefault(require("mongoose"));
const RuntimeConfigSchema = new mongoose_1.default.Schema({
    key: { type: String, required: true, unique: true },
    value: { type: mongoose_1.default.Schema.Types.Mixed, required: true },
});
const RuntimeConfig = mongoose_1.default.models.RuntimeConfig || mongoose_1.default.model("RuntimeConfig", RuntimeConfigSchema);
exports.default = RuntimeConfig;
