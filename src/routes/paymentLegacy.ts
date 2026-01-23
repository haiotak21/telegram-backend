import express from "express";
import { z } from "zod";
import { validateTelebirrTransaction, validateCBETransaction, LegacyPaymentMethod } from "../services/paymentServiceLegacy";

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

    const result =
      method === "telebirr"
        ? await validateTelebirrTransaction(txn)
        : await validateCBETransaction(txn);

    if (result.success) return res.json(result);
    return res.status(400).json(result);
  } catch (err: any) {
    const message = err?.errors?.[0]?.message || err?.message || "Invalid request";
    return res.status(400).json({ success: false, message });
  }
});
export default router;
