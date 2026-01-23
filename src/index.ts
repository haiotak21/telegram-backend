import express from "express";
import cors from "cors";
import morgan from "morgan";
import dotenv from "dotenv";
import crypto from "crypto";
import path from "path";

import strowalletRouter from "./routes/strowallet";
import paymentsRouter from "./routes/payments";
import paymentLegacyRouter from "./routes/paymentLegacy";
import depositsRouter from "./routes/deposits";
import walletRouter from "./routes/wallet";
import cardRequestsRouter from "./routes/cardRequests";
import validateRouter from "./routes/validate";
import { connectDB, disconnectDB } from "./db";
import { initBot } from "./services/botService";
import { processStroWalletEvent } from "./services/webhookProcessor";

dotenv.config();

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

// Connect DB and init bot
connectDB().catch((e) => console.error("DB init failed:", e));
initBot();

// Webhook route uses raw body parser; declare before json middleware
app.post(
  "/api/webhook/strowallet",
  express.raw({ type: "*/*" }),
  (req, res) => {
    try {
      const raw = (req.body as Buffer | undefined)?.toString("utf8") || "";
      const payload = raw ? JSON.parse(raw) : {};

      const secret = process.env.STROWALLET_WEBHOOK_SECRET;
      const signatureHeader = (req.headers["x-strowallet-signature"] || req.headers["x-strowallet-signature" as any]) as string | undefined;

      if (secret && signatureHeader) {
        const hmac = crypto.createHmac("sha256", secret);
        const digest = hmac.update(raw).digest("hex");
        const valid = safeCompareHex(digest, signatureHeader);
        if (!valid) {
          return res.status(400).json({ ok: false, error: "Invalid webhook signature" });
        }
      }

      // Persist + notify
      processStroWalletEvent(payload).catch((e) => console.error("Webhook processing error:", e));
      console.log("StroWallet webhook received:", payload?.id, payload?.type);
      return res.status(200).json({ ok: true });
    } catch (err: any) {
      return res.status(400).json({ ok: false, error: "Malformed webhook payload" });
    }
  }
);

// Global middlewares
app.use(cors());
app.use(morgan("dev"));
app.use(express.json());

// Health check
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "strowallet-proxy", version: "1.0.0" });
});

// Mount StroWallet proxy router
app.use("/api/strowallet", strowalletRouter);
app.use("/api/payments", paymentsRouter);
app.use("/api/payment", depositsRouter);
app.use("/api/wallet", walletRouter);
app.use("/api/card-requests", cardRequestsRouter);
app.use("/api", validateRouter);
app.use("/", paymentLegacyRouter);

// Admin dashboard static assets
const adminDir = path.resolve(process.cwd(), "public", "admin");
app.use("/admin", express.static(adminDir));
// Express 5 path-to-regexp requires a parameter name for wildcard; use regex for catch-all
app.get(/^\/admin\/.*$/, (_req, res) => {
  res.sendFile(path.join(adminDir, "index.html"));
});

// Global error handler
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = err?.message || "Unexpected error";
  const status = err?.status || 500;
  res.status(status).json({ ok: false, error: message });
});

app.listen(PORT, () => {
  console.log(`StroWallet proxy listening on port ${PORT}`);
});

function safeCompareHex(a: string, b: string) {
  try {
    const aBuf = Buffer.from(a, "hex");
    const bBuf = Buffer.from(b, "hex");
    if (aBuf.length !== bBuf.length) return false;
    return crypto.timingSafeEqual(aBuf, bBuf);
  } catch {
    return false;
  }
}

process.on("SIGINT", async () => {
  console.log("Shutting down...");
  await disconnectDB();
  process.exit(0);
});
