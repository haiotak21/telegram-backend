"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const zod_1 = require("zod");
const depositService_1 = require("../services/depositService");
const apiResponse_1 = require("../utils/apiResponse");
const router = express_1.default.Router();
const DepositSchema = zod_1.z.object({
    userId: zod_1.z.union([zod_1.z.string(), zod_1.z.number()]).transform((v) => String(v)),
    paymentMethod: zod_1.z.enum(["telebirr", "cbe"]),
    amount: zod_1.z.number().positive(),
    transactionNumber: zod_1.z.string().min(1),
});
router.post("/deposit", async (req, res) => {
    try {
        const body = DepositSchema.parse(req.body || {});
        const result = await (0, depositService_1.processDeposit)({
            userId: body.userId,
            paymentMethod: body.paymentMethod,
            amount: body.amount,
            transactionNumber: body.transactionNumber,
        });
        if (result.success)
            return (0, apiResponse_1.ok)(res, result);
        return (0, apiResponse_1.fail)(res, result.message || "Deposit failed", 400);
    }
    catch (err) {
        const message = err?.errors?.[0]?.message || err?.message || "Invalid request";
        return (0, apiResponse_1.fail)(res, message, 400);
    }
});
exports.default = router;
