"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const morgan_1 = __importDefault(require("morgan"));
const dotenv_1 = __importDefault(require("dotenv"));
const crypto_1 = __importDefault(require("crypto"));
const path_1 = __importDefault(require("path"));
const strowallet_1 = __importDefault(require("./routes/strowallet"));
const payments_1 = __importDefault(require("./routes/payments"));
const paymentLegacy_1 = __importDefault(require("./routes/paymentLegacy"));
const deposits_1 = __importDefault(require("./routes/deposits"));
const wallet_1 = __importDefault(require("./routes/wallet"));
const cardRequests_1 = __importDefault(require("./routes/cardRequests"));
const validate_1 = __importDefault(require("./routes/validate"));
const db_1 = require("./db");
const botService_1 = require("./services/botService");
const webhookProcessor_1 = require("./services/webhookProcessor");
dotenv_1.default.config();
const app = (0, express_1.default)();
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
// Connect DB and init bot
(0, db_1.connectDB)().catch((e) => console.error("DB init failed:", e));
(0, botService_1.initBot)();
// Webhook route uses raw body parser; declare before json middleware
app.post("/api/webhook/strowallet", express_1.default.raw({ type: "*/*" }), (req, res) => {
    try {
        const raw = req.body?.toString("utf8") || "";
        const payload = raw ? JSON.parse(raw) : {};
        const secret = process.env.STROWALLET_WEBHOOK_SECRET;
        const signatureHeader = (req.headers["x-strowallet-signature"] || req.headers["x-strowallet-signature"]);
        if (secret && signatureHeader) {
            const hmac = crypto_1.default.createHmac("sha256", secret);
            const digest = hmac.update(raw).digest("hex");
            const valid = safeCompareHex(digest, signatureHeader);
            if (!valid) {
                return res.status(400).json({ ok: false, error: "Invalid webhook signature" });
            }
        }
        // Persist + notify
        (0, webhookProcessor_1.processStroWalletEvent)(payload).catch((e) => console.error("Webhook processing error:", e));
        console.log("StroWallet webhook received:", payload?.id, payload?.type);
        return res.status(200).json({ ok: true });
    }
    catch (err) {
        return res.status(400).json({ ok: false, error: "Malformed webhook payload" });
    }
});
// Global middlewares
app.use((0, cors_1.default)());
app.use((0, morgan_1.default)("dev"));
app.use(express_1.default.json());
// Health check
app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "strowallet-proxy", version: "1.0.0" });
});
// Mount StroWallet proxy router
app.use("/api/strowallet", strowallet_1.default);
app.use("/api/payments", payments_1.default);
app.use("/api/payment", deposits_1.default);
app.use("/api/wallet", wallet_1.default);
app.use("/api/card-requests", cardRequests_1.default);
app.use("/api", validate_1.default);
app.use("/", paymentLegacy_1.default);
// Admin dashboard static assets
const adminDir = path_1.default.resolve(process.cwd(), "public", "admin");
app.use("/admin", express_1.default.static(adminDir));
// Express 5 path-to-regexp requires a parameter name for wildcard; use regex for catch-all
app.get(/^\/admin\/.*$/, (_req, res) => {
    res.sendFile(path_1.default.join(adminDir, "index.html"));
});
// Global error handler
app.use((err, _req, res, _next) => {
    const message = err?.message || "Unexpected error";
    const status = err?.status || 500;
    res.status(status).json({ ok: false, error: message });
});
app.listen(PORT, () => {
    console.log(`StroWallet proxy listening on port ${PORT}`);
});
function safeCompareHex(a, b) {
    try {
        const aBuf = Buffer.from(a, "hex");
        const bBuf = Buffer.from(b, "hex");
        if (aBuf.length !== bBuf.length)
            return false;
        return crypto_1.default.timingSafeEqual(aBuf, bBuf);
    }
    catch {
        return false;
    }
}
process.on("SIGINT", async () => {
    console.log("Shutting down...");
    await (0, db_1.disconnectDB)();
    process.exit(0);
});
