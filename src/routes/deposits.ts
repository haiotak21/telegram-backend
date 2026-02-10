import express from "express";
import { z } from "zod";
import { processDeposit } from "../services/depositService";
import { ok, fail } from "../utils/apiResponse";

const router = express.Router();

const DepositSchema = z.object({
  userId: z.union([z.string(), z.number()]).transform((v) => String(v)),
  paymentMethod: z.enum(["telebirr", "cbe"]),
  amount: z.number().positive(),
  transactionNumber: z.string().min(1),
});

router.post("/deposit", async (req, res) => {
  try {
    const body = DepositSchema.parse(req.body || {});
    const result = await processDeposit({
      userId: body.userId,
      paymentMethod: body.paymentMethod,
      amount: body.amount,
      transactionNumber: body.transactionNumber,
    });
    if (result.success) return ok(res, result);
    return fail(res, result.message || "Deposit failed", 400);
  } catch (err: any) {
    const message = err?.errors?.[0]?.message || err?.message || "Invalid request";
    return fail(res, message, 400);
  }
});

export default router;
