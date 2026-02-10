import express from "express";
import { z } from "zod";
import { validateTelebirrTransaction, validateCBETransaction, LegacyPaymentMethod } from "../services/paymentServiceLegacy";
import { ok, fail } from "../utils/apiResponse";

const router = express.Router();

const ValidateSchema = z.object({
  payment_method: z.enum(["telebirr", "cbe"]),
  transaction_number: z.string().min(1),
});

router.post("/validate-transaction", async (req, res) => {
  try {
    const body = ValidateSchema.parse(req.body || {});
    const method = body.payment_method as LegacyPaymentMethod;
    const txn = body.transaction_number;
    const result = method === "telebirr" ? await validateTelebirrTransaction(txn) : await validateCBETransaction(txn);
    if (result.success) return ok(res, result);
    return fail(res, result.message || "Validation failed", 400);
  } catch (err: any) {
    const message = err?.errors?.[0]?.message || err?.message || "Invalid request";
    return fail(res, message, 400);
  }
});

export default router;
