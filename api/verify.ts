import type { VercelRequest, VercelResponse } from "@vercel/node";
import { verifyPayment } from "../src/services/paymentVerification";

type Body = {
  paymentMethod: "telebirr" | "cbe";
  transactionNumber: string;
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ success: false, message: "Method Not Allowed" });
  }

  const body = req.body as Body | undefined;
  if (!body || !body.paymentMethod || !body.transactionNumber) {
    return res.status(400).json({ success: false, message: "paymentMethod and transactionNumber are required" });
  }

  try {
    const result = await verifyPayment({ paymentMethod: body.paymentMethod, transactionNumber: body.transactionNumber });
    return res.status(result.status).json(result.body);
  } catch (error: any) {
    console.error("[api/verify] Unexpected error", error);
    return res.status(500).json({ success: false, message: error?.message || "Verification error" });
  }
}
