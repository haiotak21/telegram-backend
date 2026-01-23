"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const zod_1 = require("zod");
const paymentVerification_1 = require("../services/paymentVerification");
const router = express_1.default.Router();
const VerifyRequestSchema = zod_1.z.object({
    paymentMethod: zod_1.z.enum(["telebirr", "cbe"]),
    transactionNumber: zod_1.z.string().min(1, "transactionNumber is required"),
});
// Simple in-memory rate limiter (per-process, per-IP)
function createRateLimiter(maxRequests, windowMs) {
    const hits = new Map();
    return (req, res, next) => {
        const key = req.ip || "global";
        const now = Date.now();
        const recent = (hits.get(key) || []).filter((ts) => now - ts < windowMs);
        recent.push(now);
        hits.set(key, recent);
        if (recent.length > maxRequests) {
            return res.status(429).json({ success: false, message: "Too many verification attempts. Please try again later." });
        }
        next();
    };
}
const rateLimit = createRateLimiter(30, 60000);
router.post("/verify", rateLimit, async (req, res) => {
    try {
        const parsed = VerifyRequestSchema.parse(req.body || {});
        const result = await (0, paymentVerification_1.verifyPayment)({
            paymentMethod: parsed.paymentMethod,
            transactionNumber: parsed.transactionNumber,
        });
        return res.status(result.status).json(result.body);
    }
    catch (err) {
        const message = err?.errors?.[0]?.message || err?.message || "Invalid request";
        return res.status(err?.status || 400).json({ success: false, message });
    }
});
exports.default = router;
