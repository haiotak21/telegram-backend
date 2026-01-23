import express from "express";
import { z } from "zod";
import { verifyPayment } from "../services/paymentVerification";

const router = express.Router();

const VerifyRequestSchema = z.object({
  paymentMethod: z.enum(["telebirr", "cbe"]),
  transactionNumber: z.string().min(1, "transactionNumber is required"),
});

// Simple in-memory rate limiter (per-process, per-IP)
function createRateLimiter(maxRequests: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
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

const rateLimit = createRateLimiter(30, 60_000);

router.post("/verify", rateLimit, async (req, res) => {
  try {
    const parsed = VerifyRequestSchema.parse(req.body || {});
    const result = await verifyPayment({
      paymentMethod: parsed.paymentMethod,
      transactionNumber: parsed.transactionNumber,
    });
    return res.status(result.status).json(result.body);
  } catch (err: any) {
    const message = err?.errors?.[0]?.message || err?.message || "Invalid request";
    return res.status(err?.status || 400).json({ success: false, message });
  }
});

export default router;
