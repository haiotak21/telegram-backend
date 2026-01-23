"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getFakeTopup = getFakeTopup;
exports.setFakeTopup = setFakeTopup;
const RuntimeConfig_1 = __importDefault(require("../models/RuntimeConfig"));
async function getFakeTopup() {
    const doc = (await RuntimeConfig_1.default.findOne({ key: "FAKE_TOPUP" }).lean());
    if (doc)
        return !!doc.value;
    return process.env.FAKE_TOPUP === "true";
}
async function setFakeTopup(value) {
    await RuntimeConfig_1.default.findOneAndUpdate({ key: "FAKE_TOPUP" }, { value }, { upsert: true, new: true });
}
