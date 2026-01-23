"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const zod_1 = require("zod");
const paymentServiceLegacy_1 = require("../services/paymentServiceLegacy");
const router = express_1.default.Router();
const ValidateSchema = zod_1.z.object({
    payment_method: zod_1.z.enum(["telebirr", "cbe"]),
    transaction_number: zod_1.z.string().min(1),
});
router.post("/validate-transaction", async (req, res) => {
    try {
        const body = ValidateSchema.parse(req.body || {});
        const method = body.payment_method;
        const txn = body.transaction_number;
        const result = method === "telebirr"
            ? await (0, paymentServiceLegacy_1.validateTelebirrTransaction)(txn)
            : await (0, paymentServiceLegacy_1.validateCBETransaction)(txn);
        if (result.success)
            return res.json(result);
        return res.status(400).json(result);
    }
    catch (err) {
        const message = err?.errors?.[0]?.message || err?.message || "Invalid request";
        return res.status(400).json({ success: false, message });
    }
});
exports.default = router;
