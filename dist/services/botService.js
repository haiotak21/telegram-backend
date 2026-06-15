"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.initBot = initBot;
exports.notifyByCardId = notifyByCardId;
exports.notifyByEmail = notifyByEmail;
exports.notifyCardStatusChanged = notifyCardStatusChanged;
exports.notifyUserBalanceReconciled = notifyUserBalanceReconciled;
exports.notifyCardRequestApproved = notifyCardRequestApproved;
exports.notifyCardLinkedToUser = notifyCardLinkedToUser;
exports.notifyCardRequestDeclined = notifyCardRequestDeclined;
exports.notifyDepositCredited = notifyDepositCredited;
exports.notifyDepositReviewDeclined = notifyDepositReviewDeclined;
exports.sendBroadcastToUser = sendBroadcastToUser;
exports.sendFriendlyError = sendFriendlyError;
const node_telegram_bot_api_1 = __importDefault(require("node-telegram-bot-api"));
const os_1 = __importDefault(require("os"));
const crypto_1 = __importDefault(require("crypto"));
const axios_1 = __importDefault(require("axios"));
const mongoose_1 = __importDefault(require("mongoose"));
const TelegramLink_1 = require("../models/TelegramLink");
const BotLock_1 = __importDefault(require("../models/BotLock"));
const CardRequest_1 = __importDefault(require("../models/CardRequest"));
const Card_1 = __importDefault(require("../models/Card"));
const paymentVerification_1 = require("./paymentVerification");
const Transaction_1 = __importDefault(require("../models/Transaction"));
const User_1 = __importDefault(require("../models/User"));
const Customer_1 = __importDefault(require("../models/Customer"));
const pricingService_1 = require("./pricingService");
const prisma_1 = __importDefault(require("../utils/prisma"));
const persistence_1 = require("../utils/persistence");
let bot = null;
const pendingActions = new Map();
const bankTransferSessions = new Map();
const electricitySessions = new Map();
const bankListCache = new Map();
function chatKey(value) {
    return value != null ? String(value) : null;
}
function escapeHtml(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}
function buildUsdtAddressMessage(address, created) {
    const heading = created ? "🎉 USDT Address Created" : "🪙 USDT Wallet (TRC20)";
    const tip = "Tap and hold the address to copy it.";
    const body = created
        ? "Your wallet is ready. Send USDT (TRC20) to this address to fund your wallet."
        : "Send USDT (TRC20) to this address to fund your wallet.";
    return [
        heading,
        `Address: <code>${escapeHtml(address)}</code>`,
        tip,
        body,
    ].join("\n");
}
function clearPendingAction(value) {
    const key = chatKey(value);
    if (key)
        pendingActions.delete(key);
}
const createCardSessions = new Map();
const cardProfileSessions = new Map();
const PROFILE_PHONE_REGEX = /^[1-9]\d{10,14}$/;
const PROFILE_DOB_REGEX = /^\d{2}\/\d{2}\/\d{4}$/;
const PROFILE_STATIC_COUNTRY = process.env.KYC_STATIC_COUNTRY || "Ghana";
const PROFILE_STATIC_STATE = process.env.KYC_STATIC_STATE || "Accra";
const PROFILE_STATIC_CITY = process.env.KYC_STATIC_CITY || "Accra";
const PROFILE_STATIC_IDTYPE = (process.env.KYC_STATIC_IDTYPE || "PASSPORT");
const WALLET_URL = process.env.WALLET_URL || "https://strowallet.com/app";
const SUPPORT_URL = process.env.SUPPORT_URL || "https://t.me/Bunacardsupport";
const NEWS_URL = process.env.NEWS_URL || "https://t.me/paytelegram082";
const API_BASE = process.env.BOT_API_BASE || "http://localhost:3000/api/strowallet/";
const BACKEND_BASE = process.env.BOT_BACKEND_BASE || "http://localhost:3000";
const EXPECTED_RECEIVER_NAME = (process.env.RECEIVER_NAME || process.env.CBE_RECEIVER_NAME || "Addisu melke admasu").trim();
const EXPECTED_TELEBIRR_NAME = (process.env.TELEBIRR_RECEIVER_NAME || "Addisu melke admasu").trim();
const CBE_STRICT_RECEIVER = String(process.env.CBE_STRICT_RECEIVER || "true").toLowerCase() === "true";
const TELEBIRR_STRICT_RECEIVER = String(process.env.TELEBIRR_STRICT_RECEIVER || "true").toLowerCase() === "true";
const EXPECTED_TELEBIRR_PHONE = (process.env.TELEBIRR_PHONE_NUMBER || "0908025718").trim();
const EXPECTED_CBE_ACCOUNT = (process.env.CBE_ACCOUNT_NUMBER || "1000139256208").trim();
function getDefaultMode() {
    return process.env.STROWALLET_DEFAULT_MODE || (process.env.NODE_ENV !== "production" ? "sandbox" : undefined);
}
function normalizeMode(mode) {
    if (!mode)
        return undefined;
    const m = String(mode).toLowerCase();
    if (m === "live")
        return undefined;
    return m;
}
const MIN_DEPOSIT_ETB = 1000;
const DEPOSIT_AMOUNTS = [1000, 2000, 3000, 5000, 10000];
const DEPOSIT_ACCOUNTS = {
    cbe: { title: "CBE Deposit", account: "1000139256208", name: "Addisu melke admasu", typeLabel: "CBE" },
    telebirr: { title: "Telebirr Deposit", account: "0908025718", name: "Addisu melke admasu", typeLabel: "Telebirr" },
};
const BOT_LOCK_KEY = "telegram-bot";
const BOT_LOCK_TTL_MS = Number(process.env.TELEGRAM_BOT_LOCK_TTL_MS || 90000);
const TELEGRAM_BOT_USE_DB_LOCK = String(process.env.TELEGRAM_BOT_USE_DB_LOCK ?? "true").toLowerCase() !== "false";
const STROWALLET_LOW_BALANCE_THRESHOLD_USD = Number(process.env.STROWALLET_LOW_BALANCE_THRESHOLD_USD || 50);
const STROWALLET_LOW_BALANCE_ALERT_CHAT_ID = (process.env.STROWALLET_LOW_BALANCE_ALERT_CHAT_ID || "504201714").trim();
const STROWALLET_LOW_BALANCE_ALERT_COOLDOWN_MS = Number(process.env.STROWALLET_LOW_BALANCE_ALERT_COOLDOWN_MS || 900000);
const BOT_DEPOSIT_FIXED_FEE_USD = Number(process.env.BOT_DEPOSIT_FIXED_FEE_USD || 1.9);
const BOT_DEPOSIT_PERCENT_FEE = Number(process.env.BOT_DEPOSIT_PERCENT_FEE || 1.9);
let lastLowBalanceAlertAt = 0;
function isLowBalanceErrorMessage(message) {
    const m = String(message || "").toLowerCase();
    return (m.includes("insufficient balance") ||
        m.includes("not enough balance") ||
        m.includes("low balance") ||
        m.includes("insufficient wallet"));
}
async function notifyAdminLowBalanceIssue(detail) {
    if (!bot)
        return;
    const now = Date.now();
    if (now - lastLowBalanceAlertAt < STROWALLET_LOW_BALANCE_ALERT_COOLDOWN_MS)
        return;
    lastLowBalanceAlertAt = now;
    const lines = [
        "⚠️ StroWallet balance issue detected",
        "Users may have delayed card provisioning due to provider balance.",
        detail ? `Detail: ${detail}` : undefined,
        `Time: ${new Date().toISOString()}`,
    ].filter(Boolean);
    try {
        const targetChat = /^-?\d+$/.test(STROWALLET_LOW_BALANCE_ALERT_CHAT_ID)
            ? Number(STROWALLET_LOW_BALANCE_ALERT_CHAT_ID)
            : STROWALLET_LOW_BALANCE_ALERT_CHAT_ID;
        await bot.sendMessage(targetChat, lines.join("\n"), {
            disable_web_page_preview: true,
            reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
        });
    }
    catch (e) {
        console.error("[bot] Failed to send admin low balance alert", e);
    }
}
// Tracks the last amount a user selected per payment method so we can validate against receipt
const depositSelections = new Map();
const depositConversionSelections = new Map();
const cardRequestSelections = new Map();
const recentCallbackActions = new Map();
const recentOutgoing = new Map();
const recentUpdates = new Map();
function isMongoReady() {
    return mongoose_1.default.connection.readyState === 1;
}
function isPrismaOnlyMode() {
    return (0, persistence_1.isPrismaPersistenceEnabled)() && !isMongoReady();
}
async function upsertTelegramIdentity(msg) {
    const telegramId = msg?.from?.id != null ? String(msg.from.id) : undefined;
    const chatId = msg?.chat?.id != null ? String(msg.chat.id) : undefined;
    if (!telegramId || !chatId)
        return;
    const username = msg?.from?.username ? String(msg.from.username) : undefined;
    if ((0, persistence_1.isPrismaPersistenceEnabled)()) {
        await prisma_1.default.user.upsert({
            where: { userId: telegramId },
            create: {
                userId: telegramId,
                telegramId,
                chatId,
                username,
            },
            update: {
                telegramId,
                chatId,
                username,
            },
        });
        return;
    }
    await User_1.default.findOneAndUpdate({ $or: [{ telegramId }, { userId: telegramId }] }, {
        $set: {
            telegramId,
            chatId,
            username,
        },
        $setOnInsert: {
            userId: telegramId,
        },
    }, { upsert: true, new: true });
}
async function findUserForChat(chatId) {
    const userId = String(chatId);
    if ((0, persistence_1.isPrismaPersistenceEnabled)()) {
        return prisma_1.default.user.findUnique({ where: { userId } });
    }
    return User_1.default.findOne({ userId }).lean();
}
async function findActiveCardsForUser(userId) {
    if ((0, persistence_1.isPrismaPersistenceEnabled)()) {
        const user = await prisma_1.default.user.findUnique({ where: { userId } });
        const customerEmail = user?.customerEmail || undefined;
        return prisma_1.default.card.findMany({
            where: {
                OR: [{ userId }, ...(customerEmail ? [{ customerEmail }] : [])],
                status: { in: ["active", "ACTIVE", "frozen", "FROZEN"] },
            },
            orderBy: { updatedAt: "desc" },
        });
    }
    return Card_1.default.find({ userId, status: { $in: ["active", "ACTIVE", "frozen", "FROZEN"] } }).lean();
}
async function getUserAndCustomerContext(userId) {
    if ((0, persistence_1.isPrismaPersistenceEnabled)()) {
        const user = await prisma_1.default.user.findUnique({ where: { userId } });
        const customer = user
            ? {
                userId,
                email: user.customerEmail,
            }
            : null;
        return { user, customer };
    }
    const [user, customer] = await Promise.all([
        User_1.default.findOne({ userId }).lean(),
        Customer_1.default.findOne({ userId }).lean(),
    ]);
    return { user, customer };
}
const MENU_BUTTON = { text: "📋 Menu", callback_data: "MENU" };
const MENU_KEYBOARD = [
    [
        { text: "➕ Request Card", callback_data: "MENU_CREATE_CARD" },
        { text: "💳 My Cards", callback_data: "MENU_MY_CARDS" },
    ],
    [
        { text: "💰 Deposit", callback_data: "MENU_DEPOSIT" },
        { text: "💸 Transfer", callback_data: "MENU_TRANSFER" },
    ],
    [
        { text: "🧾 Pay Bills", callback_data: "MENU_PAY_BILLS" },
        { text: "👛 Wallet", callback_data: "MENU_WALLET" },
    ],
    [
        { text: "👫 Invite Friends", callback_data: "MENU_INVITE" },
        { text: "🆘 Support", url: SUPPORT_URL },
    ],
    [
        { text: "📢 News", url: NEWS_URL },
    ],
];
async function initBot() {
    const killSwitch = String(process.env.TELEGRAM_BOT_DISABLED || "false").toLowerCase() === "true";
    if (killSwitch) {
        console.log(`
╔════════════════════════════════════════════════════════════════════╗
║                    EMERGENCY BOT KILL SWITCH                       ║
║               POLLING IS DISABLED VIA ENV                          ║
║                                                                    ║
║ Set TELEGRAM_BOT_DISABLED=false to enable bot                      ║
╚════════════════════════════════════════════════════════════════════╝
  `);
        return;
    }
    console.log(`
╔════════════════════════════════════════════╗
║ BOT INSTANCE STARTED                       ║
║ PID: ${process.pid}                        ║
║ Replica: ${process.env.RAILWAY_REPLICA_ID || process.env.REPLICA_ID || "none"}  ║
║ Time: ${new Date().toISOString()}          ║
╚════════════════════════════════════════════╝
`);
    console.log("Machine / container info:", {
        hostname: os_1.default.hostname(),
        platform: os_1.default.platform(),
        arch: os_1.default.arch(),
        cpus: os_1.default.cpus().length,
        totalmem: Math.round(os_1.default.totalmem() / 1024 / 1024 / 1024) + " GB",
        pid: process.pid,
        replica: process.env.RAILWAY_REPLICA_ID || process.env.REPLICA_ID || "none",
        railwayDeploymentId: process.env.RAILWAY_DEPLOYMENT_ID || "none",
    });
    if (bot) {
        return;
    }
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
        console.warn("TELEGRAM_BOT_TOKEN not set; bot disabled");
        return;
    }
    const activeToken = token;
    const pollingEnabled = String(process.env.TELEGRAM_POLLING_ENABLED ?? "true").toLowerCase() !== "false";
    const replicaId = process.env.RAILWAY_REPLICA_ID || process.env.REPLICA_ID;
    if (replicaId && replicaId !== "0") {
        console.warn(`Replica detected (${replicaId}); relying on bot lock to prevent multiple pollers.`);
    }
    if (!pollingEnabled) {
        console.warn("TELEGRAM_POLLING_ENABLED is false; bot polling disabled");
        return;
    }
    const lockOwner = buildInstanceId();
    let hasLock = true;
    const useDbLock = TELEGRAM_BOT_USE_DB_LOCK && mongoose_1.default.connection.readyState === 1;
    if (!useDbLock) {
        console.warn("Telegram bot DB lock disabled or Mongo unavailable; starting without distributed lock.");
    }
    else {
        hasLock = await acquireBotLock(lockOwner, BOT_LOCK_TTL_MS);
        if (!hasLock) {
            console.warn("Telegram bot lock not acquired; another instance is active.");
            return;
        }
    }
    const botRef = new node_telegram_bot_api_1.default(activeToken, { polling: false });
    await botRef.deleteWebHook({ drop_pending_updates: true }).catch(() => { });
    botRef.on("polling_error", (err) => {
        console.error("Telegram polling error:", err);
    });
    await botRef.startPolling();
    bot = botRef;
    console.log("Telegram bot started");
    botRef.getMe().then((me) => {
        console.log(`Telegram bot identity: @${me.username} (${me.id})`);
    }).catch(() => { });
    if (useDbLock) {
        startBotLockHeartbeat(lockOwner, botRef, BOT_LOCK_TTL_MS);
    }
    botRef.setMyCommands([
        { command: "start", description: "Show welcome message" },
        { command: "menu", description: "Show main menu" },
        { command: "help", description: "Show available commands" },
        { command: "usdt", description: "Show your USDT address" },
        { command: "usdtbalance", description: "Show USDT wallet balance" },
        { command: "usdthistory", description: "Show USDT transaction history" },
        { command: "sendusdt", description: "Send USDT (/sendusdt address amount)" },
        { command: "airtime", description: "Buy airtime (provider phone amount)" },
        { command: "dataplans", description: "List data plans (/dataplans mtn-data)" },
        { command: "buydata", description: "Buy data (/buydata mtn-data variation phone amount)" },
        { command: "card_request", description: "Request a virtual card" },
        { command: "requestcard", description: "Request a virtual card" },
        { command: "mycard", description: "View your card details" },
        { command: "cardstatus", description: "View your card status" },
        { command: "transactions", description: "View all transactions" },
        { command: "freeze", description: "Freeze your card" },
        { command: "unfreeze", description: "Unfreeze your card" },
        { command: "linkemail", description: "Link your email: /linkemail your@example.com" },
        { command: "linkcard", description: "Link a card: /linkcard CARD_ID" },
        { command: "unlink", description: "Remove all linked identifiers" },
        { command: "status", description: "Show current links" },
        { command: "verify", description: "Verify a payment transaction" },
    ]).catch(() => { });
    botRef.onText(/^\/start(?:@[\w_]+)?(?:\s+.*)?$/i, async (msg) => {
        const chatId = msg.chat.id;
        console.log("Telegram /start received", {
            chatId,
            from: msg.from?.username || msg.from?.id,
            text: msg.text,
        });
        const existingUser = await findUserForChat(chatId);
        await upsertTelegramIdentity(msg);
        if (shouldSuppressOutgoing(chatId, "start", 10000)) {
            console.warn("/start suppressed by rate limit", { chatId });
            return;
        }
        if (shouldSkipCommand(msg, "start", 10000)) {
            console.warn("/start skipped as duplicate", { chatId });
            return;
        }
        const isNewUser = !existingUser;
        try {
            if (isNewUser) {
                await bot.sendMessage(chatId, buildWelcomeMessage(), {
                    parse_mode: "HTML",
                    disable_web_page_preview: true,
                    reply_markup: { inline_keyboard: MENU_KEYBOARD },
                });
            }
            else {
                await bot.sendMessage(chatId, "Main menu", {
                    disable_web_page_preview: true,
                    reply_markup: { inline_keyboard: MENU_KEYBOARD },
                });
            }
        }
        catch (err) {
            console.error("Failed to respond to /start", { chatId, err });
        }
    });
    botRef.onText(/^\/menu$/i, async (msg) => {
        if (shouldSkipCommand(msg, "menu", 4000))
            return;
        await sendMenu(msg.chat.id);
    });
    botRef.onText(/^\/help$/i, async (msg) => {
        if (shouldSkipCommand(msg, "help"))
            return;
        await bot.sendMessage(msg.chat.id, "Commands:\n/card_request\n/requestcard\n/mycard\n/cardstatus\n/transactions\n/freeze\n/unfreeze\n/linkemail your@example.com\n/linkcard CARD_ID\n/unlink (remove all links)\n/status\n/verify\n/deposit\n/usdt\n/usdtbalance\n/usdthistory\n/sendusdt address amount\n/airtime\n/dataplans\n/buydata");
    });
    botRef.onText(/^\/deposit$/i, async (msg) => {
        if (shouldSkipCommand(msg, "deposit"))
            return;
        await sendDepositInfo(msg.chat.id);
    });
    botRef.onText(/^\/virtualaccount$/i, async (msg) => {
        if (shouldSkipCommand(msg, "virtualaccount"))
            return;
        await bot.sendMessage(msg.chat.id, "Virtual accounts are available for Nigerian users only. Use the USDT wallet instead.", { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
    });
    botRef.onText(/^\/usdt$/i, async (msg) => {
        if (shouldSkipCommand(msg, "usdt"))
            return;
        await sendUsdtAddress(msg.chat.id);
    });
    botRef.onText(/^\/usdtbalance$/i, async (msg) => {
        if (shouldSkipCommand(msg, "usdtbalance"))
            return;
        await sendUsdtBalance(msg.chat.id);
    });
    botRef.onText(/^\/usdthistory(?:\s+(.+))?$/i, async (msg, match) => {
        if (shouldSkipCommand(msg, "usdthistory"))
            return;
        const address = match?.[1] ? String(match[1]).trim() : "";
        if (address) {
            await sendUsdtHistory(msg.chat.id, address);
            return;
        }
        await sendUsdtHistory(msg.chat.id);
    });
    botRef.onText(/^\/sendusdt(?:\s+(.+))?$/i, async (msg, match) => {
        if (shouldSkipCommand(msg, "sendusdt"))
            return;
        const args = match?.[1];
        if (!args) {
            const key = chatKey(msg.chat.id);
            if (key)
                pendingActions.set(key, { type: "usdt_send" });
            await bot.sendMessage(msg.chat.id, "Send USDT in this format: address amount", {
                reply_markup: { force_reply: true },
            });
            return;
        }
        await handleUsdtSendRequest(msg.chat.id, args);
    });
    botRef.onText(/^\/airtime(?:\s+(.+))?$/i, async (msg, match) => {
        if (shouldSkipCommand(msg, "airtime"))
            return;
        const args = match?.[1];
        if (!args) {
            const key = chatKey(msg.chat.id);
            if (key)
                pendingActions.set(key, { type: "airtime" });
            await bot.sendMessage(msg.chat.id, "Send airtime in this format: provider phone amount\nExample: mtn 08031234567 500", { reply_markup: { force_reply: true } });
            return;
        }
        await handleAirtimeRequest(msg.chat.id, args);
    });
    botRef.onText(/^\/dataplans(?:\s+([\w-]+))?$/i, async (msg, match) => {
        if (shouldSkipCommand(msg, "dataplans"))
            return;
        const service = match?.[1];
        if (!service) {
            await bot.sendMessage(msg.chat.id, "Usage: /dataplans mtn-data", { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
            return;
        }
        await sendDataPlans(msg.chat.id, service);
    });
    botRef.onText(/^\/buydata(?:\s+(.+))?$/i, async (msg, match) => {
        if (shouldSkipCommand(msg, "buydata"))
            return;
        const args = match?.[1];
        if (!args) {
            await bot.sendMessage(msg.chat.id, "Usage: /buydata service_id variation_code phone amount\nExample: /buydata mtn-data mtn-50mb-200 08031234567 200", { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
            return;
        }
        await handleBuyDataRequest(msg.chat.id, args);
    });
    botRef.onText(/^\/verify$/i, async (msg) => {
        if (shouldSkipCommand(msg, "verify"))
            return;
        const chatId = msg.chat.id;
        await bot.sendMessage(chatId, "Choose payment method to verify:", {
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: "Telebirr", callback_data: "VERIFY_METHOD::telebirr" },
                        { text: "CBE", callback_data: "VERIFY_METHOD::cbe" },
                    ],
                    [MENU_BUTTON],
                ],
            },
        });
    });
    botRef.onText(/^\/requestcard$/i, async (msg) => {
        if (shouldSkipCommand(msg, "requestcard"))
            return;
        const chatId = msg.chat.id;
        await handleCardRequest(chatId, msg);
    });
    botRef.onText(/^\/mycard(s)?$/i, async (msg) => {
        if (shouldSkipCommand(msg, "mycard"))
            return;
        return sendMyCards(msg.chat.id, msg);
    });
    botRef.onText(/^\/cardstatus$/i, async (msg) => {
        if (shouldSkipCommand(msg, "cardstatus"))
            return;
        return sendCardStatus(msg.chat.id);
    });
    botRef.onText(/^\/transactions$/i, async (msg) => {
        if (shouldSkipCommand(msg, "transactions"))
            return;
        const chatId = msg.chat.id;
        await sendCardTransactions(chatId);
    });
    botRef.onText(/^\/(freeze|unfreeze)$/i, async (msg, match) => {
        if (shouldSkipCommand(msg, "freeze_toggle"))
            return;
        const action = match?.[1] === "unfreeze" ? "unfreeze" : "freeze";
        const card = await getPrimaryCardForUser(String(msg.chat.id));
        if (!card?.cardId) {
            await bot.sendMessage(msg.chat.id, "❌ No cards linked yet.", { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
            return;
        }
        await handleFreezeAction(msg.chat.id, card.cardId, action);
    });
    botRef.onText(/^\/card_request$/i, async (msg) => {
        if (shouldSkipCommand(msg, "card_request"))
            return;
        const chatId = msg.chat.id;
        await handleCardRequest(chatId, msg);
    });
    botRef.onText(/^\/linkemail(?:\s+([^\s]+))?$/i, async (msg, match) => {
        if (shouldSkipCommand(msg, "linkemail"))
            return;
        const email = match?.[1];
        if (!email) {
            const key = chatKey(msg.chat.id);
            if (!key)
                return;
            pendingActions.set(key, { type: "email" });
            return bot.sendMessage(msg.chat.id, "Please send your email now (or /cancel):", {
                reply_markup: { force_reply: true },
            });
        }
        const up = await TelegramLink_1.TelegramLink.findOneAndUpdate({ chatId: msg.chat.id }, { $set: { customerEmail: email } }, { new: true, upsert: true });
        await bot.sendMessage(msg.chat.id, `Linked email ${email}.`);
    });
    botRef.onText(/^\/linkcard(?:\s+([^\s]+))?$/i, async (msg, match) => {
        if (shouldSkipCommand(msg, "linkcard"))
            return;
        const cardId = match?.[1];
        if (!cardId) {
            const key = chatKey(msg.chat.id);
            if (!key)
                return;
            pendingActions.set(key, { type: "card" });
            return bot.sendMessage(msg.chat.id, "Please send the CARD_ID now (or /cancel):", {
                reply_markup: { force_reply: true },
            });
        }
        const up = await TelegramLink_1.TelegramLink.findOneAndUpdate({ chatId: msg.chat.id }, { $addToSet: { cardIds: cardId } }, { new: true, upsert: true });
        await bot.sendMessage(msg.chat.id, `Linked card ${cardId}.`);
    });
    botRef.onText(/^\/unlink$/i, async (msg) => {
        if (shouldSkipCommand(msg, "unlink"))
            return;
        await TelegramLink_1.TelegramLink.findOneAndUpdate({ chatId: msg.chat.id }, { $set: { customerEmail: undefined, cardIds: [] } }, { upsert: true });
        await bot.sendMessage(msg.chat.id, "All links removed.");
    });
    botRef.onText(/^\/status$/i, async (msg) => {
        if (shouldSkipCommand(msg, "status"))
            return;
        const [link, cards] = await Promise.all([
            isPrismaOnlyMode() ? Promise.resolve(null) : TelegramLink_1.TelegramLink.findOne({ chatId: msg.chat.id }).lean(),
            findActiveCardsForUser(String(msg.chat.id)),
        ]);
        const cardLabels = cards.map((c) => `${c.cardId}${c.last4 ? ` (••••${c.last4})` : ""}`);
        await bot.sendMessage(msg.chat.id, `Email: ${link?.customerEmail || "(none)"}\nCards: ${cardLabels.join(", ") || "(none)"}`);
    });
    botRef.onText(/^\/cancel$/i, async (msg) => {
        if (shouldSkipCommand(msg, "cancel"))
            return;
        clearPendingAction(msg.chat.id);
        cardRequestSelections.delete(msg.chat.id);
        cardProfileSessions.delete(msg.chat.id);
        createCardSessions.delete(msg.chat.id);
        bankTransferSessions.delete(msg.chat.id);
        electricitySessions.delete(msg.chat.id);
        await bot.sendMessage(msg.chat.id, "Cancelled pending action.");
    });
    botRef.on("callback_query", async (query) => {
        const chatId = query.message?.chat?.id;
        const action = query.data;
        if (!chatId || !action)
            return;
        const callbackKey = query.id ? `cb:${query.id}` : `cb:${chatId}:${action}`;
        if (isDuplicateUpdate(callbackKey, 20000)) {
            await bot.answerCallbackQuery(query.id).catch(() => { });
            return;
        }
        const now = Date.now();
        const last = recentCallbackActions.get(chatId);
        if (last && last.action === action && now - last.at < 1500) {
            await bot.answerCallbackQuery(query.id).catch(() => { });
            return;
        }
        recentCallbackActions.set(chatId, { action, at: now });
        if (action.startsWith("TRANSFER_BANK_CONFIRM::")) {
            await bot.answerCallbackQuery(query.id).catch(() => { });
            const decision = action.replace("TRANSFER_BANK_CONFIRM::", "");
            const session = bankTransferSessions.get(chatId);
            if (!session) {
                await bot.sendMessage(chatId, "Transfer session expired.", { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
                return;
            }
            if (decision !== "yes") {
                bankTransferSessions.delete(chatId);
                await bot.sendMessage(chatId, "Transfer cancelled.", { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
                return;
            }
            if (!session.data.bankCode || !session.data.accountNumber || !session.data.amount || !session.data.nameEnquiryReference) {
                await bot.sendMessage(chatId, "Transfer details are incomplete. Please restart the transfer.", {
                    reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
                });
                bankTransferSessions.delete(chatId);
                return;
            }
            try {
                const { user } = await getUserAndCustomerContext(String(chatId));
                const senderName = [user?.firstName, user?.lastName].filter(Boolean).join(" ") || user?.username || undefined;
                const payload = {
                    amount: toStroAmountString(session.data.amount || 0),
                    bank_code: session.data.bankCode,
                    account_number: session.data.accountNumber,
                    narration: session.data.narration || "Transfer",
                    name_enquiry_reference: session.data.nameEnquiryReference,
                    ...(senderName ? { SenderName: senderName } : {}),
                };
                const resp = await callStroWallet("banks/transfer", "post", payload);
                const data = resp?.data ?? resp;
                bankTransferSessions.delete(chatId);
                await bot.sendMessage(chatId, `✅ Transfer submitted.\n${JSON.stringify(data)}`, {
                    reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
                });
            }
            catch (err) {
                await bot.sendMessage(chatId, `❌ Transfer failed: ${err?.message || "Unexpected error"}`, {
                    reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
                });
            }
            return;
        }
        if (action.startsWith("ELECTRICITY_CONFIRM::")) {
            await bot.answerCallbackQuery(query.id).catch(() => { });
            const decision = action.replace("ELECTRICITY_CONFIRM::", "");
            const session = electricitySessions.get(chatId);
            if (!session) {
                await bot.sendMessage(chatId, "Electricity session expired.", { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
                return;
            }
            if (decision !== "yes") {
                electricitySessions.delete(chatId);
                await bot.sendMessage(chatId, "Electricity payment cancelled.", { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
                return;
            }
            if (!session.data.serviceName || !session.data.meterNumber || !session.data.meterType || !session.data.phone || !session.data.amount) {
                await bot.sendMessage(chatId, "Electricity payment details are incomplete. Please start again.", {
                    reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
                });
                electricitySessions.delete(chatId);
                return;
            }
            try {
                const payload = {
                    service_name: session.data.serviceName,
                    meter_number: session.data.meterNumber,
                    meter_type: session.data.meterType,
                    phone: session.data.phone,
                    amount: toStroAmountString(session.data.amount || 0),
                };
                const resp = await callStroWallet("bills/electricity", "post", payload);
                const data = resp?.data ?? resp;
                electricitySessions.delete(chatId);
                await bot.sendMessage(chatId, `✅ Electricity payment submitted.\n${JSON.stringify(data)}`, {
                    reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
                });
            }
            catch (err) {
                await bot.sendMessage(chatId, `❌ Electricity payment failed: ${err?.message || "Unexpected error"}`, {
                    reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
                });
            }
            return;
        }
        if (action.startsWith("PROFILE_CONFIRM::")) {
            const decision = action.replace("PROFILE_CONFIRM::", "");
            const session = cardProfileSessions.get(chatId);
            if (!session || session.step !== "confirm") {
                await bot.answerCallbackQuery(query.id, { text: "Profile session not active" }).catch(() => { });
                return;
            }
            await bot.answerCallbackQuery(query.id).catch(() => { });
            if (decision === "yes") {
                await persistCardProfile(String(chatId), session.data);
                cardProfileSessions.delete(chatId);
                await bot.sendMessage(chatId, "✅ Profile saved. Continuing card request...", {
                    reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
                });
                await handleCardRequest(chatId, query.message, { skipProfile: true });
            }
            else {
                cardProfileSessions.delete(chatId);
                await bot.sendMessage(chatId, "Profile setup cancelled.", { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
            }
            return;
        }
        if (action.startsWith("CARD_TYPE::")) {
            const cardType = action.replace("CARD_TYPE::", "");
            const session = createCardSessions.get(chatId);
            if (!session || session.step !== "type") {
                await bot.answerCallbackQuery(query.id, { text: "Card session not active" }).catch(() => { });
                return;
            }
            if (cardType !== "visa" && cardType !== "mastercard" && cardType !== "nfc")
                return;
            session.data.cardType = cardType;
            session.step = "amount";
            createCardSessions.set(chatId, session);
            await bot.answerCallbackQuery(query.id).catch(() => { });
            await promptCreateCardStep(chatId, session);
            return;
        }
        if (action.startsWith("CARD_AMOUNT::")) {
            const amount = action.replace("CARD_AMOUNT::", "");
            const session = createCardSessions.get(chatId);
            if (!session || session.step !== "amount") {
                await bot.answerCallbackQuery(query.id, { text: "Card session not active" }).catch(() => { });
                return;
            }
            if (amount === "skip") {
                session.data.amount = "3";
            }
            else {
                session.data.amount = amount;
            }
            session.step = "confirm";
            createCardSessions.set(chatId, session);
            await bot.answerCallbackQuery(query.id).catch(() => { });
            await promptCreateCardStep(chatId, session);
            return;
        }
        if (action.startsWith("CARD_CONFIRM::")) {
            const decision = action.replace("CARD_CONFIRM::", "");
            const session = createCardSessions.get(chatId);
            if (!session || session.step !== "confirm") {
                await bot.answerCallbackQuery(query.id, { text: "Card session not active" }).catch(() => { });
                return;
            }
            await bot.answerCallbackQuery(query.id).catch(() => { });
            if (decision === "yes") {
                await submitCreateCard(chatId, session);
            }
            else {
                createCardSessions.delete(chatId);
                await bot.sendMessage(chatId, "Card creation cancelled.", { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
            }
            return;
        }
        if (action === "CANCEL") {
            clearPendingAction(chatId);
            cardProfileSessions.delete(chatId);
            createCardSessions.delete(chatId);
            await bot.answerCallbackQuery(query.id, { text: "Cancelled" }).catch(() => { });
            await bot.sendMessage(chatId, "Cancelled pending action.", { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
            return;
        }
        if (action === "MENU") {
            await bot.answerCallbackQuery(query.id).catch(() => { });
            return sendMenu(chatId, query.message);
        }
        if (action === "CARD_TXN_NO_CARD") {
            await bot.answerCallbackQuery(query.id).catch(() => { });
            await sendCardTransactions(chatId);
            return;
        }
        if (action === "CARD_FREEZE_NO_CARD") {
            await bot.answerCallbackQuery(query.id).catch(() => { });
            await bot.sendMessage(chatId, "No card found. Use /card_request to create your virtual card.", {
                reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
            });
            return;
        }
        if (action === "TXN_BACK_ALL") {
            await bot.answerCallbackQuery(query.id).catch(() => { });
            await sendCardTransactions(chatId);
            return;
        }
        if (action.startsWith("CARD_REVEAL::")) {
            const cardId = action.replace("CARD_REVEAL::", "");
            await bot.answerCallbackQuery(query.id).catch(() => { });
            await sendCardRevealPrompt(chatId, cardId);
            return;
        }
        if (action.startsWith("CARD_REVEAL_CONFIRM::")) {
            const cardId = action.replace("CARD_REVEAL_CONFIRM::", "");
            await bot.answerCallbackQuery(query.id).catch(() => { });
            await sendCardSensitiveDetails(chatId, cardId);
            return;
        }
        if (action === "MENU_VERIFY") {
            await editOrSend(chatId, query.message, "Choose payment method to verify:", {
                inline_keyboard: [
                    [
                        { text: "Telebirr", callback_data: "VERIFY_METHOD::telebirr" },
                        { text: "CBE", callback_data: "VERIFY_METHOD::cbe" },
                    ],
                    [MENU_BUTTON],
                ],
            });
            return;
        }
        if (action.startsWith("VERIFY_METHOD::")) {
            const method = action.replace("VERIFY_METHOD::", "");
            if (method !== "telebirr" && method !== "cbe")
                return;
            await bot.answerCallbackQuery(query.id).catch(() => { });
            await startVerificationFlow(chatId, method);
            return;
        }
        if (action.startsWith("DEPOSIT_METHOD::")) {
            const method = action.replace("DEPOSIT_METHOD::", "");
            if (method !== "telebirr" && method !== "cbe")
                return;
            await bot.answerCallbackQuery(query.id).catch(() => { });
            const conversion = depositConversionSelections.get(chatId);
            if (conversion) {
                await sendDepositSummary(chatId, method, conversion.creditAmountEtb, {
                    payableAmountEtb: conversion.totalEtb,
                    displayAmountEtb: conversion.totalEtb,
                    creditedUsd: conversion.requestedUsd,
                    fromConversion: true,
                });
                return;
            }
            await sendDepositAmountSelect(chatId, method);
            return;
        }
        if (action.startsWith("DEPOSIT_CHANGE::")) {
            const method = action.replace("DEPOSIT_CHANGE::", "");
            if (method !== "telebirr" && method !== "cbe")
                return;
            await bot.answerCallbackQuery(query.id).catch(() => { });
            depositConversionSelections.delete(chatId);
            await sendDepositAmountSelect(chatId, method);
            return;
        }
        if (action.startsWith("DEPOSIT_AMOUNT::")) {
            const [, methodRaw, amountRaw] = action.split("::");
            const method = methodRaw;
            const amount = Number(amountRaw);
            if ((method !== "telebirr" && method !== "cbe") || !Number.isFinite(amount))
                return;
            await bot.answerCallbackQuery(query.id).catch(() => { });
            if (amount < MIN_DEPOSIT_ETB) {
                await bot.sendMessage(chatId, `Minimum deposit is ${MIN_DEPOSIT_ETB} ETB.`, {
                    reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
                });
                return;
            }
            depositConversionSelections.delete(chatId);
            await sendDepositSummary(chatId, method, amount);
            return;
        }
        if (action.startsWith("DEPOSIT_CUSTOM::")) {
            const method = action.replace("DEPOSIT_CUSTOM::", "");
            if (method !== "telebirr" && method !== "cbe")
                return;
            await bot.answerCallbackQuery(query.id).catch(() => { });
            {
                const key = chatKey(chatId);
                if (key)
                    pendingActions.set(key, { type: "deposit_amount", method });
            }
            await bot.sendMessage(chatId, `Enter the amount to deposit via ${method.toUpperCase()} (ETB, minimum ${MIN_DEPOSIT_ETB}).`, {
                reply_markup: { force_reply: true },
            });
            return;
        }
        if (action === "DEPOSIT_CONVERT") {
            await bot.answerCallbackQuery(query.id).catch(() => { });
            {
                const key = chatKey(chatId);
                if (key)
                    pendingActions.set(key, { type: "deposit_convert_amount" });
            }
            await bot.sendMessage(chatId, "Enter USD amount to convert (example: 5).", {
                reply_markup: { force_reply: true },
            });
            return;
        }
        if (action.startsWith("DEPOSIT_VERIFY::")) {
            const method = action.replace("DEPOSIT_VERIFY::", "");
            if (method !== "telebirr" && method !== "cbe")
                return;
            await bot.answerCallbackQuery(query.id).catch(() => { });
            const selected = depositSelections.get(chatId);
            if (!selected || selected.method !== method || !Number.isFinite(selected.amountEtb) || selected.amountEtb < MIN_DEPOSIT_ETB) {
                await bot.sendMessage(chatId, "Please select a deposit amount first, then verify payment.", {
                    reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
                });
                return;
            }
            await startVerificationFlow(chatId, method);
            return;
        }
        if (action.startsWith("CARDPAY_METHOD::")) {
            const method = action.replace("CARDPAY_METHOD::", "");
            if (method !== "telebirr" && method !== "cbe")
                return;
            await bot.answerCallbackQuery(query.id).catch(() => { });
            const selection = cardRequestSelections.get(chatId);
            if (!selection) {
                await bot.sendMessage(chatId, "Card request payment session expired. Please request a card again.", {
                    reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
                });
                return;
            }
            {
                const key = chatKey(chatId);
                if (key)
                    pendingActions.set(key, { type: "card_request_verify", method });
            }
            const meta = DEPOSIT_ACCOUNTS[method];
            const lines = [
                "💳 Card request payment",
                `Card amount: ${(selection.cardAmountUsd * selection.rate).toFixed(2)} ETB`,
                `Service fee: $${selection.feeUsd.toFixed(2)}`,
                `Total to pay: ${selection.totalEtb.toFixed(2)} ETB`,
                `${meta.typeLabel} account: ${meta.account}`,
                `Name: ${meta.name}`,
                "",
                "After paying, send your receipt reference:",
                buildVerificationHint(method),
            ];
            await bot.sendMessage(chatId, lines.join("\n"), {
                reply_markup: { force_reply: true },
            });
            return;
        }
        await bot.answerCallbackQuery(query.id).catch(() => { });
        await handleMenuSelection(action, chatId, query.message);
    });
    botRef.on("message", async (msg) => {
        const chatId = msg.chat.id;
        console.log("Telegram message received", {
            chatId,
            from: msg.from?.username || msg.from?.id,
            text: msg.text,
        });
        const messageKey = msg.message_id ? `msg:${chatId}:${msg.message_id}` : `msg:${chatId}:${Date.now()}`;
        if (isDuplicateUpdate(messageKey, 20000))
            return;
        const profile = cardProfileSessions.get(chatId);
        if (profile) {
            await handleCardProfileMessage(msg, profile);
            return;
        }
        const cardSession = createCardSessions.get(chatId);
        if (cardSession) {
            await handleCreateCardMessage(msg, cardSession);
            return;
        }
        const transferSession = bankTransferSessions.get(chatId);
        if (transferSession) {
            await handleBankTransferMessage(msg, transferSession);
            return;
        }
        const electricitySession = electricitySessions.get(chatId);
        if (electricitySession) {
            await handleElectricityMessage(msg, electricitySession);
            return;
        }
        if (!msg.text)
            return;
        const pendingKey = chatKey(chatId);
        if (!pendingKey)
            return;
        const pending = pendingActions.get(pendingKey);
        if (!pending)
            return;
        const text = String(msg.text).trim();
        if (pending.type === "email") {
            const email = text;
            const valid = /.+@.+\..+/.test(email);
            if (!valid) {
                return bot.sendMessage(msg.chat.id, "Invalid email format. Try again or /cancel.");
            }
            await TelegramLink_1.TelegramLink.findOneAndUpdate({ chatId: msg.chat.id }, { $set: { customerEmail: email } }, { new: true, upsert: true });
            clearPendingAction(msg.chat.id);
            await bot.sendMessage(msg.chat.id, `Linked email ${email}.`);
        }
        else if (pending.type === "card") {
            const cardId = text;
            if (!cardId) {
                return bot.sendMessage(msg.chat.id, "Card ID cannot be empty. Try again or /cancel.");
            }
            await TelegramLink_1.TelegramLink.findOneAndUpdate({ chatId: msg.chat.id }, { $addToSet: { cardIds: cardId } }, { new: true, upsert: true });
            clearPendingAction(msg.chat.id);
            await bot.sendMessage(msg.chat.id, `Linked card ${cardId}.`);
        }
        else if (pending.type === "usdt_history") {
            clearPendingAction(msg.chat.id);
            await sendUsdtHistory(msg.chat.id, text);
        }
        else if (pending.type === "usdt_send") {
            clearPendingAction(msg.chat.id);
            await handleUsdtSendRequest(msg.chat.id, text);
        }
        else if (pending.type === "verify") {
            const method = pending.method;
            if (!text) {
                return bot.sendMessage(msg.chat.id, "Transaction number cannot be empty. Try again or /cancel.");
            }
            // Allow users to paste full URLs (e.g., CBE deep links). Extract ?id=... when present.
            let txn = text;
            try {
                if (/^https?:\/\//i.test(text)) {
                    const u = new URL(text);
                    const id = u.searchParams.get("id");
                    if (id) {
                        txn = id;
                    }
                    else {
                        const parts = u.pathname.split("/").filter(Boolean);
                        if (parts.length)
                            txn = parts[parts.length - 1];
                    }
                }
            }
            catch { }
            const normalizedTxn = normalizeTxnRef(txn, pending.method);
            try {
                const already = await findUsedPaymentReference(method, normalizedTxn);
                if (already) {
                    await bot.sendMessage(msg.chat.id, "❌ This payment reference has already been used.", { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
                    clearPendingAction(msg.chat.id);
                    return;
                }
                const result = await (0, paymentVerification_1.verifyPayment)({ paymentMethod: method, transactionNumber: normalizedTxn });
                const b = result.body;
                if (b?.success) {
                    const selectedFromPending = Number.isFinite(pending.expectedAmount)
                        ? { method, amountEtb: Number(pending.expectedAmount), totalEtb: Number(pending.expectedAmount) }
                        : undefined;
                    const selectedFromSession = depositSelections.get(msg.chat.id);
                    const selected = selectedFromPending || selectedFromSession;
                    const validationErrors = validateVerificationResult({ method, body: b, selected });
                    if (validationErrors.length) {
                        const notice = [
                            "❌ Verification failed due to:",
                            ...validationErrors.map((v) => `- ${v}`),
                            "Please check your receipt and try again.",
                        ].join("\n");
                        await bot.sendMessage(msg.chat.id, notice, { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
                        clearPendingAction(msg.chat.id);
                        return;
                    }
                    const rawData = (b.raw?.data ?? b.raw ?? {});
                    const amountNum = parseMoney(b.amount ?? rawData?.settledAmount ?? rawData?.transferredAmount);
                    const feeNum = parseMoney(rawData?.serviceFee ?? rawData?.fee);
                    const feeVatNum = parseMoney(rawData?.serviceFeeVAT ?? rawData?.vat ?? rawData?.vatAmount);
                    const totalPaidNum = parseMoney(rawData?.totalPaidAmount ?? rawData?.totalPaid ?? rawData?.total_amount);
                    const inferredTotal = totalPaidNum ?? (amountNum != null && feeNum != null ? amountNum + feeNum : undefined);
                    const amountStr = amountNum != null ? formatMoney(amountNum, b.currency) : rawData?.settledAmount || rawData?.transferredAmount || undefined;
                    const feeStr = feeNum != null ? formatMoney(feeNum, b.currency) : rawData?.serviceFee || undefined;
                    const feeVatStr = feeVatNum != null ? formatMoney(feeVatNum, b.currency) : rawData?.serviceFeeVAT || undefined;
                    const totalStr = inferredTotal != null ? formatMoney(inferredTotal, b.currency) : rawData?.totalPaidAmount || undefined;
                    const payer = rawData?.payerName || rawData?.payer || undefined;
                    const receiver = rawData?.creditedPartyName || rawData?.receiver || undefined;
                    const date = rawData?.paymentDate || rawData?.date || undefined;
                    const lines = [
                        "✅ Verification Result",
                        `Provider: ${b.provider}`,
                        `Transaction: ${b.transactionNumber}`,
                        amountStr ? `Amount: ${amountStr}` : undefined,
                        feeStr ? `Fee: ${feeStr}${feeVatStr ? ` (VAT: ${feeVatStr})` : ""}` : undefined,
                        totalStr ? `Total Paid: ${totalStr}` : undefined,
                        payer ? `Payer: ${payer}` : undefined,
                        receiver ? `Receiver: ${receiver}` : undefined,
                        date ? `Date: ${date}` : undefined,
                        b.status ? `Status: ${b.status}` : undefined,
                        b.message ? `Message: ${b.message}` : undefined,
                    ].filter(Boolean);
                    // Record verification for idempotency/audit BEFORE sending success message
                    try {
                        const amountNum = typeof b.amount === "number" ? b.amount : undefined;
                        const rawData = (b.raw?.data ?? b.raw ?? {});
                        const verifiedKey = normalizeTxnRef(String(b.transactionNumber || normalizedTxn), method);
                        const altKey = normalizeTxnRef(String(rawData?.reference || normalizedTxn), method);
                        const enableTestVerification = String(process.env.ENABLE_TEST_VERIFICATION || "false").toLowerCase() === "true";
                        const testTransactionId = (process.env.TEST_TRANSACTION_ID || "").trim();
                        const isTestTelebirr = enableTestVerification &&
                            method === "telebirr" &&
                            testTransactionId &&
                            verifiedKey.toUpperCase() === testTransactionId.toUpperCase();
                        const transactionKey = isTestTelebirr ? `${verifiedKey}-TEST-${Date.now()}` : verifiedKey;
                        if (typeof amountNum !== "number" || amountNum <= 0) {
                            await bot.sendMessage(msg.chat.id, "❌ Verification succeeded but amount is missing from receipt.", {
                                reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
                            });
                            clearPendingAction(msg.chat.id);
                            return;
                        }
                        const amountEtb = Number(selected?.creditAmountEtb || amountNum);
                        const pricing = await (0, pricingService_1.loadPricingConfig)();
                        const quote = (0, pricingService_1.quoteDeposit)(amountEtb, pricing);
                        const primaryCard = await getPrimaryCardForUser(String(msg.chat.id));
                        if (!primaryCard?.cardId) {
                            await bot.sendMessage(msg.chat.id, "❌ No active card found. Deposit was verified but cannot be applied to a card. Please create a card or contact support.", { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
                            clearPendingAction(msg.chat.id);
                            return;
                        }
                        if (primaryCard.cardType && String(primaryCard.cardType).toLowerCase() !== "nfc") {
                            await bot.sendMessage(msg.chat.id, "❌ Your saved card is not NFC-compatible. Please create a new NFC card and try again.", { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
                            clearPendingAction(msg.chat.id);
                            return;
                        }
                        let providerResponse;
                        try {
                            providerResponse = await callStroWallet("fund-card", "post", {
                                card_id: String(primaryCard.cardId),
                                amount: toStroAmountString(quote.creditedUsdt),
                                mode: normalizeMode(getDefaultMode()),
                            });
                        }
                        catch (fundErr) {
                            const reason = fundErr?.message || "Card funding is not available right now.";
                            const userId = String(msg.chat.id);
                            const baseTxData = {
                                userId,
                                transactionType: "deposit",
                                paymentMethod: method,
                                amount: quote.creditedUsdt,
                                amountEtb,
                                amountUsdt: quote.creditedUsdt,
                                feeEtb: quote.feeEtb,
                                currency: "USDT",
                                rateSnapshot: quote.rate,
                                transactionNumber: transactionKey,
                                referenceNumber: altKey,
                                verified: true,
                                metadata: { cardId: String(primaryCard.cardId), destination: "card" },
                            };
                            if ((0, persistence_1.isPrismaPersistenceEnabled)()) {
                                const hasReference = Boolean(altKey);
                                await prisma_1.default.transaction.upsert({
                                    where: hasReference
                                        ? {
                                            transactionType_referenceNumber_userId: {
                                                transactionType: "deposit",
                                                referenceNumber: altKey,
                                                userId,
                                            },
                                        }
                                        : {
                                            transactionType_transactionNumber_userId: {
                                                transactionType: "deposit",
                                                transactionNumber: transactionKey,
                                                userId,
                                            },
                                        },
                                    create: {
                                        ...baseTxData,
                                        status: "failed",
                                        responseData: { verification: b.raw ?? b, fundError: reason },
                                    },
                                    update: {
                                        ...baseTxData,
                                        status: "failed",
                                        responseData: { verification: b.raw ?? b, fundError: reason },
                                    },
                                });
                            }
                            else {
                                await Transaction_1.default.findOneAndUpdate({
                                    userId,
                                    transactionType: "deposit",
                                    $or: [
                                        { transactionNumber: transactionKey },
                                        ...(altKey ? [{ referenceNumber: altKey }] : []),
                                    ],
                                }, {
                                    $set: {
                                        ...baseTxData,
                                        status: "failed",
                                        responseData: { verification: b.raw ?? b, fundError: reason },
                                    },
                                }, { upsert: true, new: true });
                            }
                            const friendlyReason = reason.includes("was not found")
                                ? "Card not found on provider. Please create a new NFC card and try again."
                                : reason;
                            await bot.sendMessage(msg.chat.id, `❌ Card top-up failed: ${friendlyReason}. Your wallet balance was not credited. Please contact support.`, { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
                            clearPendingAction(msg.chat.id);
                            return;
                        }
                        if ((0, persistence_1.isPrismaPersistenceEnabled)()) {
                            const userId = String(msg.chat.id);
                            const hasReference = Boolean(altKey);
                            await prisma_1.default.transaction.upsert({
                                where: hasReference
                                    ? {
                                        transactionType_referenceNumber_userId: {
                                            transactionType: "deposit",
                                            referenceNumber: altKey,
                                            userId,
                                        },
                                    }
                                    : {
                                        transactionType_transactionNumber_userId: {
                                            transactionType: "deposit",
                                            transactionNumber: transactionKey,
                                            userId,
                                        },
                                    },
                                create: {
                                    userId,
                                    transactionType: "deposit",
                                    paymentMethod: method,
                                    amount: quote.creditedUsdt,
                                    amountEtb,
                                    amountUsdt: quote.creditedUsdt,
                                    feeEtb: quote.feeEtb,
                                    currency: "USDT",
                                    rateSnapshot: quote.rate,
                                    transactionNumber: transactionKey,
                                    referenceNumber: altKey,
                                    status: "completed",
                                    verified: true,
                                    responseData: { verification: b.raw ?? b, fundResponse: providerResponse },
                                    metadata: { cardId: String(primaryCard.cardId), destination: "card" },
                                },
                                update: {
                                    paymentMethod: method,
                                    amount: quote.creditedUsdt,
                                    amountEtb,
                                    amountUsdt: quote.creditedUsdt,
                                    feeEtb: quote.feeEtb,
                                    currency: "USDT",
                                    rateSnapshot: quote.rate,
                                    transactionNumber: transactionKey,
                                    referenceNumber: altKey,
                                    status: "completed",
                                    verified: true,
                                    responseData: { verification: b.raw ?? b, fundResponse: providerResponse },
                                    metadata: { cardId: String(primaryCard.cardId), destination: "card" },
                                },
                            });
                        }
                        else {
                            await Transaction_1.default.findOneAndUpdate({
                                userId: String(msg.chat.id),
                                transactionType: "deposit",
                                $or: [
                                    { transactionNumber: transactionKey },
                                    ...(altKey ? [{ referenceNumber: altKey }] : []),
                                ],
                            }, {
                                $set: {
                                    paymentMethod: method,
                                    amount: quote.creditedUsdt,
                                    amountEtb,
                                    amountUsdt: quote.creditedUsdt,
                                    feeEtb: quote.feeEtb,
                                    currency: "USDT",
                                    rateSnapshot: quote.rate,
                                    transactionNumber: transactionKey,
                                    referenceNumber: altKey,
                                    status: "completed",
                                    verified: true,
                                    responseData: { verification: b.raw ?? b, fundResponse: providerResponse },
                                    metadata: { cardId: String(primaryCard.cardId), destination: "card" },
                                },
                            }, { upsert: true, new: true });
                        }
                        if ((0, persistence_1.isPrismaPersistenceEnabled)()) {
                            await prisma_1.default.transaction.create({
                                data: {
                                    userId: String(msg.chat.id),
                                    transactionType: "verification",
                                    paymentMethod: method,
                                    amount: amountNum ?? 0,
                                    transactionNumber: verifiedKey,
                                    referenceNumber: altKey,
                                    status: "completed",
                                    responseData: b.raw ?? b,
                                },
                            });
                        }
                        else {
                            await Transaction_1.default.create({
                                userId: String(msg.chat.id),
                                transactionType: "verification",
                                paymentMethod: method,
                                amount: amountNum ?? 0,
                                transactionNumber: verifiedKey,
                                referenceNumber: altKey,
                                status: "completed",
                                responseData: b.raw ?? b,
                            });
                        }
                        await bot.sendMessage(msg.chat.id, lines.join("\n"), { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
                        depositSelections.delete(msg.chat.id);
                        const autoTopupMessage = `Deposited to card: ${quote.creditedUsdt.toFixed(2)} USDT`;
                        // Show latest card data and wallet after deposit/top-up.
                        const liveCardDetail = primaryCard?.cardId ? await fetchCardDetailSafe(String(primaryCard.cardId)) : null;
                        const liveCardBalance = liveCardDetail?.available_balance || liveCardDetail?.balance;
                        const liveCardCurrency = (liveCardDetail?.currency || primaryCard?.currency || "USD").toUpperCase();
                        await bot.sendMessage(msg.chat.id, [
                            "✅ Payment Verified",
                            autoTopupMessage,
                            liveCardBalance != null
                                ? `Card balance: ${Number(liveCardBalance).toFixed(2)} ${liveCardCurrency}`
                                : "Your card balance will update shortly once the credit is posted.",
                            "Note: this deposit was applied directly to your card.",
                        ].filter(Boolean).join("\n"), { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
                        await notifyLowStroWalletBalanceIfNeeded({
                            userId: String(msg.chat.id),
                            paymentMethod: method,
                            creditedUsdt: Number(quote.creditedUsdt || 0),
                        });
                    }
                    catch (createErr) {
                        if (createErr?.code === 11000) {
                            await bot.sendMessage(msg.chat.id, "❌ This payment reference has already been used.", { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
                            clearPendingAction(msg.chat.id);
                            return;
                        }
                        await bot.sendMessage(msg.chat.id, `❌ Verification error: ${createErr?.message || "Unexpected error"}`, { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
                        clearPendingAction(msg.chat.id);
                        return;
                    }
                }
                else {
                    const selected = depositSelections.get(msg.chat.id);
                    let queued = { queued: false, transactionId: null };
                    try {
                        queued = await queueDepositManualReview({
                            userId: String(msg.chat.id),
                            paymentMethod: method,
                            transactionNumber: normalizedTxn,
                            expectedAmountEtb: selected?.amountEtb ?? pending.expectedAmount,
                            reason: b?.message || "Automatic verifier returned failure",
                            responseData: b,
                        });
                    }
                    catch (queueErr) {
                        console.error("Failed to queue manual review", {
                            userId: String(msg.chat.id),
                            paymentMethod: method,
                            transactionNumber: normalizedTxn,
                            error: queueErr?.message || String(queueErr),
                        });
                    }
                    depositSelections.delete(msg.chat.id);
                    if (queued.queued) {
                        await bot.sendMessage(msg.chat.id, [
                            "⏳ Automatic verification failed.",
                            "Your payment has been sent to admin for manual review.",
                            "You will be notified once it is approved or declined.",
                        ].join("\n"), { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
                    }
                    else {
                        await bot.sendMessage(msg.chat.id, `❌ Verification failed: ${b?.message || "Unknown error"}`, { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
                    }
                }
            }
            catch (e) {
                const selected = depositSelections.get(msg.chat.id);
                let queued = { queued: false, transactionId: null };
                try {
                    queued = await queueDepositManualReview({
                        userId: String(msg.chat.id),
                        paymentMethod: method,
                        transactionNumber: normalizedTxn,
                        expectedAmountEtb: selected?.amountEtb ?? pending.expectedAmount,
                        reason: e?.message || "Automatic verifier threw an error",
                        responseData: { error: e?.message || String(e) },
                    });
                }
                catch (queueErr) {
                    console.error("Failed to queue manual review after verifier error", {
                        userId: String(msg.chat.id),
                        paymentMethod: method,
                        transactionNumber: normalizedTxn,
                        error: queueErr?.message || String(queueErr),
                    });
                }
                depositSelections.delete(msg.chat.id);
                if (queued.queued) {
                    await bot.sendMessage(msg.chat.id, [
                        "⏳ Automatic verification failed.",
                        "Your payment has been sent to admin for manual review.",
                        "You will be notified once it is approved or declined.",
                    ].join("\n"), { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
                }
                else {
                    await bot.sendMessage(msg.chat.id, `❌ Verification error: ${e?.message || "Unexpected error"}`, { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
                }
            }
            finally {
                clearPendingAction(msg.chat.id);
            }
        }
        else if (pending.type === "card_request_verify") {
            const method = pending.method;
            if (!text) {
                return bot.sendMessage(msg.chat.id, "Transaction number cannot be empty. Try again or /cancel.");
            }
            let txn = text;
            try {
                if (/^https?:\/\//i.test(text)) {
                    const u = new URL(text);
                    const id = u.searchParams.get("id");
                    if (id) {
                        txn = id;
                    }
                    else {
                        const parts = u.pathname.split("/").filter(Boolean);
                        if (parts.length)
                            txn = parts[parts.length - 1];
                    }
                }
            }
            catch { }
            const normalizedTxn = normalizeTxnRef(txn, pending.method);
            try {
                const already = await findUsedPaymentReference(method, normalizedTxn);
                if (already) {
                    await bot.sendMessage(msg.chat.id, "❌ This payment reference has already been used.", {
                        reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
                    });
                    clearPendingAction(msg.chat.id);
                    return;
                }
                const result = await (0, paymentVerification_1.verifyPayment)({ paymentMethod: method, transactionNumber: normalizedTxn });
                const b = result.body;
                if (b?.success) {
                    const selection = cardRequestSelections.get(msg.chat.id);
                    if (!selection) {
                        await bot.sendMessage(msg.chat.id, "Card request payment session expired. Please request a card again.", {
                            reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
                        });
                        clearPendingAction(msg.chat.id);
                        return;
                    }
                    const validationErrors = validateVerificationResult({
                        method,
                        body: b,
                        selected: { method, amount: selection.totalEtb },
                    });
                    if (validationErrors.length) {
                        const queued = await queueCardRequestManualReview({
                            userId: String(msg.chat.id),
                            paymentMethod: method,
                            transactionNumber: normalizedTxn,
                            expectedAmountEtb: selection.totalEtb,
                            cardAmountUsd: selection.cardAmountUsd,
                            feeUsd: selection.feeUsd,
                            totalUsd: selection.totalUsd,
                            rate: selection.rate,
                            reason: `Receipt validation failed: ${validationErrors.join("; ")}`,
                            responseData: b,
                        });
                        if (queued.queued) {
                            await bot.sendMessage(msg.chat.id, [
                                "⏳ Automatic verification failed.",
                                "Your card-request payment was sent to admin for manual review.",
                                "You will be notified once approved or declined.",
                            ].join("\n"), { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
                        }
                        else {
                            const notice = [
                                "❌ Verification failed due to:",
                                ...validationErrors.map((v) => `- ${v}`),
                                "Please check your receipt and try again.",
                            ].join("\n");
                            await bot.sendMessage(msg.chat.id, notice, { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
                        }
                        clearPendingAction(msg.chat.id);
                        return;
                    }
                    const rawData = (b.raw?.data ?? b.raw ?? {});
                    const verifiedKey = normalizeTxnRef(String(b.transactionNumber || normalizedTxn), method);
                    const altKey = normalizeTxnRef(String(rawData?.reference || normalizedTxn), method);
                    try {
                        if ((0, persistence_1.isPrismaPersistenceEnabled)()) {
                            await prisma_1.default.transaction.create({
                                data: {
                                    userId: String(msg.chat.id),
                                    transactionType: "card",
                                    paymentMethod: method,
                                    amount: selection.totalEtb,
                                    amountEtb: selection.totalEtb,
                                    feeEtb: roundMoney(selection.feeUsd * selection.rate),
                                    status: "completed",
                                    transactionNumber: verifiedKey,
                                    referenceNumber: altKey,
                                    responseData: b.raw ?? b,
                                    metadata: {
                                        kind: "card_request",
                                        cardAmountUsd: selection.cardAmountUsd,
                                        feeUsd: selection.feeUsd,
                                        totalUsd: selection.totalUsd,
                                        totalEtb: selection.totalEtb,
                                        conversionRateEtbPerUsdt: selection.rate,
                                    },
                                },
                            });
                        }
                        else {
                            await Transaction_1.default.create({
                                userId: String(msg.chat.id),
                                transactionType: "card",
                                paymentMethod: method,
                                amount: selection.totalEtb,
                                amountEtb: selection.totalEtb,
                                feeEtb: roundMoney(selection.feeUsd * selection.rate),
                                status: "completed",
                                transactionNumber: verifiedKey,
                                referenceNumber: altKey,
                                responseData: b.raw ?? b,
                                metadata: {
                                    kind: "card_request",
                                    cardAmountUsd: selection.cardAmountUsd,
                                    feeUsd: selection.feeUsd,
                                    totalUsd: selection.totalUsd,
                                    totalEtb: selection.totalEtb,
                                    conversionRateEtbPerUsdt: selection.rate,
                                },
                            });
                        }
                    }
                    catch (createErr) {
                        if (createErr?.code !== 11000) {
                            await bot.sendMessage(msg.chat.id, `❌ Verification error: ${createErr?.message || "Unexpected error"}`, {
                                reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
                            });
                            clearPendingAction(msg.chat.id);
                            return;
                        }
                    }
                    const userId = String(msg.chat.id);
                    const { user, customer } = await getUserAndCustomerContext(userId);
                    const existingCard = (0, persistence_1.isPrismaPersistenceEnabled)()
                        ? await prisma_1.default.card.findFirst({ where: { userId }, orderBy: { updatedAt: "desc" } })
                        : await Card_1.default.findOne({ userId }).lean();
                    if (existingCard) {
                        await bot.sendMessage(msg.chat.id, "❌ You already have a card. Multiple cards are not allowed.", {
                            reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
                        });
                        clearPendingAction(msg.chat.id);
                        return;
                    }
                    await bot.sendMessage(msg.chat.id, "✅ Payment verified. Creating your virtual card...", {
                        reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
                    });
                    cardRequestSelections.delete(msg.chat.id);
                    await submitCardRequest(String(msg.chat.id), user, customer, undefined, selection.cardAmountUsd);
                }
                else {
                    const selection = cardRequestSelections.get(msg.chat.id);
                    if (!selection) {
                        await bot.sendMessage(msg.chat.id, `❌ Verification failed: ${b?.message || "Unknown error"}`, {
                            reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
                        });
                        clearPendingAction(msg.chat.id);
                        return;
                    }
                    const queued = await queueCardRequestManualReview({
                        userId: String(msg.chat.id),
                        paymentMethod: method,
                        transactionNumber: normalizedTxn,
                        expectedAmountEtb: selection.totalEtb,
                        cardAmountUsd: selection.cardAmountUsd,
                        feeUsd: selection.feeUsd,
                        totalUsd: selection.totalUsd,
                        rate: selection.rate,
                        reason: b?.message || "Automatic verifier returned failure",
                        responseData: b,
                    });
                    if (queued.queued) {
                        await bot.sendMessage(msg.chat.id, [
                            "⏳ Automatic verification failed.",
                            "Your card-request payment was sent to admin for manual review.",
                            "You will be notified once approved or declined.",
                        ].join("\n"), { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
                    }
                    else {
                        await bot.sendMessage(msg.chat.id, `❌ Verification failed: ${b?.message || "Unknown error"}`, {
                            reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
                        });
                    }
                }
            }
            catch (e) {
                const selection = cardRequestSelections.get(msg.chat.id);
                if (selection) {
                    const queued = await queueCardRequestManualReview({
                        userId: String(msg.chat.id),
                        paymentMethod: method,
                        transactionNumber: normalizedTxn,
                        expectedAmountEtb: selection.totalEtb,
                        cardAmountUsd: selection.cardAmountUsd,
                        feeUsd: selection.feeUsd,
                        totalUsd: selection.totalUsd,
                        rate: selection.rate,
                        reason: e?.message || "Automatic verifier threw an error",
                        responseData: { error: e?.message || String(e) },
                    });
                    if (queued.queued) {
                        await bot.sendMessage(msg.chat.id, [
                            "⏳ Automatic verification failed.",
                            "Your card-request payment was sent to admin for manual review.",
                            "You will be notified once approved or declined.",
                        ].join("\n"), { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
                    }
                    else {
                        await bot.sendMessage(msg.chat.id, `❌ Verification error: ${e?.message || "Unexpected error"}`, {
                            reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
                        });
                    }
                }
                else {
                    await bot.sendMessage(msg.chat.id, `❌ Verification error: ${e?.message || "Unexpected error"}`, {
                        reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
                    });
                }
            }
            finally {
                clearPendingAction(msg.chat.id);
            }
        }
        else if (pending.type === "deposit_amount") {
            const method = pending.method;
            const amount = Number(text.replace(/,/g, ""));
            if (!Number.isFinite(amount) || amount < MIN_DEPOSIT_ETB) {
                return bot.sendMessage(msg.chat.id, `Please enter a valid amount in ETB (minimum ${MIN_DEPOSIT_ETB}), or /cancel.`);
            }
            clearPendingAction(msg.chat.id);
            await sendDepositSummary(msg.chat.id, method, amount);
        }
        else if (pending.type === "deposit_convert_amount") {
            const usdAmount = Number(text.replace(/,/g, ""));
            clearPendingAction(msg.chat.id);
            await sendDepositConversionPreview(msg.chat.id, usdAmount);
        }
        else if (pending.type === "data_plans") {
            const service = text.toLowerCase();
            clearPendingAction(msg.chat.id);
            if (!service) {
                await bot.sendMessage(msg.chat.id, "Please enter a valid provider id (example: mtn-data).", {
                    reply_markup: { force_reply: true },
                });
                return;
            }
            await sendDataPlans(msg.chat.id, service);
        }
        else if (pending.type === "internet_plans") {
            const service = text.toLowerCase();
            clearPendingAction(msg.chat.id);
            if (!service) {
                await bot.sendMessage(msg.chat.id, "Please enter a valid internet provider id (example: spectranet).", {
                    reply_markup: { force_reply: true },
                });
                return;
            }
            await sendDataPlans(msg.chat.id, service);
        }
        else if (pending.type === "airtime") {
            clearPendingAction(msg.chat.id);
            await handleAirtimeRequest(msg.chat.id, text);
        }
    });
}
async function notifyByCardId(cardId, message) {
    if (!bot)
        return;
    if ((0, persistence_1.isPrismaPersistenceEnabled)()) {
        const card = await prisma_1.default.card.findUnique({ where: { cardId } });
        const chatId = Number(card?.userId);
        if (Number.isFinite(chatId)) {
            await bot.sendMessage(chatId, message, { disable_web_page_preview: true });
        }
        return;
    }
    const links = await TelegramLink_1.TelegramLink.find({ cardIds: cardId });
    const sent = new Set();
    for (const link of links) {
        const chatId = Number(link.chatId);
        if (!Number.isFinite(chatId))
            continue;
        sent.add(chatId);
        await bot.sendMessage(chatId, message, { disable_web_page_preview: true });
    }
    const card = await Card_1.default.findOne({ cardId }).lean();
    const chatId = card?.userId ? Number(card.userId) : NaN;
    if (Number.isFinite(chatId) && !sent.has(chatId)) {
        await bot.sendMessage(chatId, message, { disable_web_page_preview: true });
    }
}
async function notifyByEmail(email, message) {
    if (!bot)
        return;
    if ((0, persistence_1.isPrismaPersistenceEnabled)()) {
        const user = await prisma_1.default.user.findFirst({ where: { customerEmail: email } });
        const chatId = Number(user?.chatId || user?.userId);
        if (Number.isFinite(chatId)) {
            await bot.sendMessage(chatId, message, { disable_web_page_preview: true });
        }
        return;
    }
    const link = await TelegramLink_1.TelegramLink.findOne({ customerEmail: email });
    if (link) {
        await bot.sendMessage(link.chatId, message, { disable_web_page_preview: true });
        return;
    }
    const customer = await Customer_1.default.findOne({ email }).lean();
    if (customer?.userId) {
        const user = await User_1.default.findOne({ userId: customer.userId }).lean();
        const chatId = user?.chatId ? Number(user.chatId) : NaN;
        if (Number.isFinite(chatId)) {
            await bot.sendMessage(chatId, message, { disable_web_page_preview: true });
        }
    }
}
async function notifyCardStatusChanged(cardId, status) {
    if (!bot)
        return;
    const card = (0, persistence_1.isPrismaPersistenceEnabled)()
        ? await prisma_1.default.card.findUnique({ where: { cardId } })
        : await Card_1.default.findOne({ cardId }).lean();
    const suffix = card?.last4 ? `••••${card.last4}` : cardId;
    const text = status === "frozen"
        ? `❌ Your card ${suffix} has been frozen by admin.`
        : `✅ Your card ${suffix} has been reactivated.`;
    await notifyByCardId(cardId, text);
}
async function notifyUserBalanceReconciled(userId, cardId, balance, currency) {
    if (!bot)
        return;
    const chatId = Number(userId);
    if (!Number.isFinite(chatId))
        return;
    const lines = [
        "⚠️ Your card balance was updated after reconciliation.",
        `Card: ${cardId}`,
        `New Balance: ${balance.toFixed(2)}${currency ? ` ${currency}` : ""}`,
    ];
    await bot.sendMessage(chatId, lines.join("\n"), {
        disable_web_page_preview: true,
        reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
    });
}
async function notifyCardRequestApproved(userId, payload) {
    if (!bot)
        return;
    const lines = [
        "✅ Approved",
        "🎉 Your virtual card has been approved and created successfully.",
        "You can now view and manage your card from My Card.",
        payload.cardId ? `Card ID: ${payload.cardId}` : undefined,
    ].filter(Boolean);
    await bot.sendMessage(Number(userId), lines.join("\n"), { disable_web_page_preview: true, reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
}
async function notifyCardLinkedToUser(userId, payload) {
    if (!bot)
        return;
    const chatId = Number(userId);
    if (!Number.isFinite(chatId))
        return;
    const suffix = payload.last4 ? `••••${payload.last4}` : undefined;
    const lines = [
        "✅ Virtual card assigned",
        "A virtual card has been assigned to your account by admin.",
        payload.cardId ? `Card ID: ${payload.cardId}` : undefined,
        suffix ? `Card: ${suffix}` : undefined,
        payload.cardType ? `Type: ${payload.cardType}` : undefined,
        payload.nameOnCard ? `Name: ${payload.nameOnCard}` : undefined,
        "Open My Card to view details.",
    ].filter(Boolean);
    await bot.sendMessage(chatId, lines.join("\n"), {
        disable_web_page_preview: true,
        reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
    });
}
async function notifyCardRequestDeclined(userId, reason) {
    if (!bot)
        return;
    const lines = [
        "❌ Your card request was declined. Please contact support.",
        reason ? `Reason: ${reason}` : undefined,
    ].filter(Boolean);
    await bot.sendMessage(Number(userId), lines.join("\n"), { disable_web_page_preview: true, reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
}
async function notifyDepositCredited(userId, amountUsdt, newBalance) {
    if (!bot)
        return;
    const lines = [
        "✅ Deposit received",
        `Amount: ${amountUsdt} USDT`,
        newBalance != null ? `Wallet balance: ${newBalance} USDT` : undefined,
    ].filter(Boolean);
    await bot.sendMessage(Number(userId), lines.join("\n"), {
        disable_web_page_preview: true,
        reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
    });
}
async function notifyDepositReviewDeclined(userId, reason) {
    if (!bot)
        return;
    const lines = [
        "❌ Deposit review declined",
        reason ? `Reason: ${reason}` : undefined,
        "Please submit a new payment and try verification again.",
    ].filter(Boolean);
    await bot.sendMessage(Number(userId), lines.join("\n"), {
        disable_web_page_preview: true,
        reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
    });
}
async function sendBroadcastToUser(userId, messageText, imageUrl) {
    if (!bot)
        return { ok: false, error: "Bot is not initialized" };
    const chatId = Number(userId);
    if (!Number.isFinite(chatId))
        return { ok: false, error: "Invalid user id" };
    try {
        if (imageUrl) {
            const caption = messageText.length > 1024 ? `${messageText.slice(0, 1021)}...` : messageText;
            await bot.sendPhoto(chatId, imageUrl, {
                caption,
                disable_web_page_preview: true,
            });
        }
        else {
            await bot.sendMessage(chatId, messageText, {
                disable_web_page_preview: true,
            });
        }
        return { ok: true };
    }
    catch (e) {
        return { ok: false, error: e?.message || "Failed to send" };
    }
}
function buildInstanceId() {
    const replica = process.env.RAILWAY_REPLICA_ID || process.env.REPLICA_ID || "none";
    return `${os_1.default.hostname()}-${process.pid}-${replica}`;
}
async function acquireBotLock(ownerId, ttlMs) {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs);
    try {
        const lock = (await BotLock_1.default.findOneAndUpdate({ key: BOT_LOCK_KEY, $or: [{ expiresAt: { $lte: now } }, { ownerId }] }, { $set: { ownerId, expiresAt }, $setOnInsert: { key: BOT_LOCK_KEY, createdAt: now } }, { upsert: true, new: true }).lean());
        if (lock?.ownerId === ownerId)
            return true;
        // Recover from clock-skewed locks that stay in the future and block polling.
        const existing = (await BotLock_1.default.findOne({ key: BOT_LOCK_KEY }).lean());
        const maxSkewMs = ttlMs * 2;
        if (existing?.expiresAt && existing.expiresAt.getTime() - now.getTime() > maxSkewMs) {
            console.warn("Bot lock expires far in the future; forcing takeover.");
            const forced = (await BotLock_1.default.findOneAndUpdate({ key: BOT_LOCK_KEY }, { $set: { ownerId, expiresAt } }, { new: true }).lean());
            return forced?.ownerId === ownerId;
        }
        return false;
    }
    catch (err) {
        if (err?.code === 11000)
            return false;
        throw err;
    }
}
async function renewBotLock(ownerId, ttlMs) {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs);
    const res = await BotLock_1.default.updateOne({ key: BOT_LOCK_KEY, ownerId }, { $set: { expiresAt } });
    return res.modifiedCount > 0;
}
function startBotLockHeartbeat(ownerId, botRef, ttlMs) {
    const intervalMs = Math.max(15000, Math.floor(ttlMs / 2));
    const timer = setInterval(async () => {
        try {
            const ok = await renewBotLock(ownerId, ttlMs);
            if (!ok) {
                console.warn("Telegram bot lock lost; stopping polling.");
                await botRef.stopPolling().catch(() => { });
                clearInterval(timer);
            }
        }
        catch (err) {
            console.warn("Failed to renew Telegram bot lock:", err);
        }
    }, intervalMs);
    return timer;
}
function buildWelcomeMessage() {
    return [
        "👋 Welcome to <b>StroWallet</b> — manage cards and wallet in one place.",
        "Use the menu below to create cards or check balance.",
    ].join("\n");
}
function shouldSuppressOutgoing(chatId, key, ttlMs = 1500) {
    const now = Date.now();
    const last = recentOutgoing.get(chatId);
    if (last && last.key === key && now - last.at < ttlMs)
        return true;
    recentOutgoing.set(chatId, { key, at: now });
    return false;
}
function isDuplicateUpdate(key, ttlMs = 60000) {
    const now = Date.now();
    const last = recentUpdates.get(key);
    if (last && now - last < ttlMs)
        return true;
    recentUpdates.set(key, now);
    if (recentUpdates.size > 2000) {
        for (const [k, t] of recentUpdates.entries()) {
            if (now - t > ttlMs)
                recentUpdates.delete(k);
        }
    }
    return false;
}
function shouldSkipCommand(msg, key, ttlMs = 1500) {
    const chatId = msg?.chat?.id;
    const messageId = msg?.message_id;
    if (chatId != null && messageId != null) {
        if (isDuplicateUpdate(`cmdmsg:${chatId}:${messageId}`))
            return true;
    }
    if (chatId != null && shouldSuppressOutgoing(chatId, `cmd:${key}`, ttlMs))
        return true;
    return false;
}
function buildProfileCard(msg, link, cardCount = 0) {
    const firstName = msg.from?.first_name || "StroWallet User";
    const username = msg.from?.username ? `@${msg.from.username}` : undefined;
    const phone = link?.customerEmail ? undefined : "(not provided)";
    const lines = [
        "🧑‍💻 <b>Here's Your Profile:</b>",
        "",
        `👤 Name: ${firstName}${username ? ` (${username})` : ""}`,
        phone ? `📞 Phone: ${phone}` : undefined,
        link?.customerEmail ? `✉️ Email: ${link.customerEmail}` : "✉️ Email: (link with /linkemail)",
        `💳 Cards: ${cardCount}`,
        cardCount ? `➡️ /status to see cards` : "➕ Request a card to get started",
    ].filter(Boolean);
    return lines.join("\n");
}
async function sendMenu(chatId, message) {
    if (!bot)
        return;
    if (shouldSuppressOutgoing(chatId, "menu"))
        return;
    await editOrSend(chatId, message, "Main menu", { inline_keyboard: MENU_KEYBOARD });
}
function buildDepositMenuKeyboard() {
    return [
        [
            { text: "🏦 Bank Transfer", callback_data: "DEPOSIT_MENU_BANK" },
            { text: "📱 Mobile Money", callback_data: "DEPOSIT_MENU_MOBILE" },
        ],
        [
            { text: "💳 Card Deposit", callback_data: "DEPOSIT_MENU_CARD" },
            { text: "🌍 International", callback_data: "DEPOSIT_MENU_INTL" },
        ],
        [{ text: "🧮 Conversion", callback_data: "DEPOSIT_CONVERT" }],
        [MENU_BUTTON],
    ];
}
async function sendDepositMenu(chatId, message) {
    if (shouldSuppressOutgoing(chatId, "deposit_menu"))
        return;
    await editOrSend(chatId, message, "Choose a deposit method:", {
        inline_keyboard: buildDepositMenuKeyboard(),
    });
}
function buildTransferMenuKeyboard() {
    return [
        [
            { text: "📱 To Phone Number", callback_data: "TRANSFER_PHONE" },
            { text: "💳 To Card Number", callback_data: "TRANSFER_CARD" },
        ],
        [
            { text: "👤 To Username", callback_data: "TRANSFER_USERNAME" },
            { text: "🏦 To Bank Account", callback_data: "TRANSFER_BANK" },
        ],
        [MENU_BUTTON],
    ];
}
async function sendTransferMenu(chatId, message) {
    await editOrSend(chatId, message, "Choose a transfer type:", {
        inline_keyboard: buildTransferMenuKeyboard(),
    });
}
function extractBankList(payload) {
    const candidates = [
        payload?.data?.banks,
        payload?.data?.bankList,
        payload?.data?.data,
        payload?.banks,
        payload?.bankList,
        payload?.data,
        payload,
    ];
    const list = candidates.find((c) => Array.isArray(c)) || [];
    return list
        .map((item) => {
        const code = String(item?.bank_code || item?.bankCode || item?.code || "").trim();
        const name = String(item?.bank_name || item?.bankName || item?.name || "").trim();
        if (!code || !name)
            return null;
        return { code, name, raw: item };
    })
        .filter(Boolean);
}
async function fetchBankList(chatId) {
    const cached = bankListCache.get(chatId);
    if (cached && Date.now() - cached.fetchedAt < 5 * 60 * 1000)
        return cached.banks;
    const resp = await callStroWallet("banks/list", "get", {});
    const payload = resp?.data ?? resp;
    const banks = extractBankList(payload);
    bankListCache.set(chatId, { banks, fetchedAt: Date.now() });
    return banks;
}
function findBankByInput(input, banks) {
    const normalized = input.trim().toLowerCase();
    if (!normalized)
        return undefined;
    const byCode = banks.find((b) => b.code.toLowerCase() === normalized);
    if (byCode)
        return byCode;
    return banks.find((b) => b.name.toLowerCase() === normalized);
}
function formatBankListMessage(banks) {
    if (!banks.length)
        return "No bank list available. Send the bank code directly.";
    const preview = banks.slice(0, 20);
    const lines = [
        "🏦 Available Banks (send bank code):",
        ...preview.map((b) => `${b.code} - ${b.name}`),
    ];
    if (banks.length > preview.length)
        lines.push("...more banks available");
    return lines.join("\n");
}
async function startBankTransferFlow(chatId, message) {
    const session = { step: "bank", data: {} };
    bankTransferSessions.set(chatId, session);
    try {
        const banks = await fetchBankList(chatId);
        await editOrSend(chatId, message, formatBankListMessage(banks), { inline_keyboard: [[MENU_BUTTON]] });
        await bot.sendMessage(chatId, "Send the bank code (example: 058).", {
            reply_markup: { force_reply: true },
        });
    }
    catch (err) {
        bankTransferSessions.delete(chatId);
        await bot.sendMessage(chatId, `❌ Failed to load bank list: ${err?.message || "Unexpected error"}`);
    }
}
async function promptBankTransferStep(chatId, session) {
    if (session.lastPromptStep === session.step)
        return;
    session.lastPromptStep = session.step;
    switch (session.step) {
        case "bank":
            await bot.sendMessage(chatId, "Send the bank code (example: 058).", { reply_markup: { force_reply: true } });
            break;
        case "account":
            await bot.sendMessage(chatId, "Enter the account number:", { reply_markup: { force_reply: true } });
            break;
        case "amount":
            await bot.sendMessage(chatId, "Enter amount to transfer:", { reply_markup: { force_reply: true } });
            break;
        case "narration":
            await bot.sendMessage(chatId, "Enter narration (or type skip):", { reply_markup: { force_reply: true } });
            break;
        case "confirm":
            await bot.sendMessage(chatId, "Use the buttons to confirm transfer.", {
                reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
            });
            break;
    }
}
function buildBankTransferSummary(session) {
    const data = session.data;
    return [
        "💸 Bank Transfer Summary",
        data.bankName ? `Bank: ${data.bankName}` : data.bankCode ? `Bank code: ${data.bankCode}` : undefined,
        data.accountNumber ? `Account: ${data.accountNumber}` : undefined,
        data.accountName ? `Account name: ${data.accountName}` : undefined,
        data.amount != null ? `Amount: ${data.amount.toFixed(2)}` : undefined,
        data.narration ? `Narration: ${data.narration}` : undefined,
    ]
        .filter(Boolean)
        .join("\n");
}
async function handleBankTransferMessage(msg, session) {
    const chatId = msg.chat.id;
    const text = String(msg.text || "").trim();
    if (!text) {
        await bot.sendMessage(chatId, "Please send a text response.", { reply_markup: { force_reply: true } });
        return;
    }
    switch (session.step) {
        case "bank": {
            if (text.toLowerCase() === "list") {
                const banks = await fetchBankList(chatId);
                await bot.sendMessage(chatId, formatBankListMessage(banks));
                return;
            }
            const banks = await fetchBankList(chatId).catch(() => []);
            const match = findBankByInput(text, banks);
            if (!match && !/^\d+$/.test(text)) {
                await bot.sendMessage(chatId, "Invalid bank code. Please use the numeric bank code from the list.", {
                    reply_markup: { force_reply: true },
                });
                if (banks.length) {
                    await bot.sendMessage(chatId, formatBankListMessage(banks));
                }
                return;
            }
            session.data.bankCode = match?.code || text;
            session.data.bankName = match?.name || undefined;
            session.step = "account";
            bankTransferSessions.set(chatId, session);
            await promptBankTransferStep(chatId, session);
            return;
        }
        case "account": {
            const accountNumber = text.replace(/\s+/g, "");
            if (!/^\d{6,}$/.test(accountNumber)) {
                await bot.sendMessage(chatId, "Invalid account number. Try again.", { reply_markup: { force_reply: true } });
                return;
            }
            session.data.accountNumber = accountNumber;
            try {
                const resp = await callStroWallet("banks/resolve", "get", {
                    bank_code: session.data.bankCode,
                    account_number: accountNumber,
                });
                const payload = resp?.data ?? resp;
                const accountName = payload?.data?.account_name ||
                    payload?.data?.accountName ||
                    payload?.account_name ||
                    payload?.accountName ||
                    payload?.data?.name ||
                    payload?.name;
                const nameEnquiryReference = payload?.data?.name_enquiry_reference ||
                    payload?.data?.nameEnquiryReference ||
                    payload?.name_enquiry_reference ||
                    payload?.nameEnquiryReference;
                if (accountName)
                    session.data.accountName = String(accountName);
                if (nameEnquiryReference)
                    session.data.nameEnquiryReference = String(nameEnquiryReference);
            }
            catch (err) {
                await bot.sendMessage(chatId, `❌ Failed to resolve account name: ${err?.message || "Unexpected error"}`);
                session.step = "bank";
                bankTransferSessions.set(chatId, session);
                await bot.sendMessage(chatId, "Please re-enter the bank code (numeric).", {
                    reply_markup: { force_reply: true },
                });
                return;
            }
            if (!session.data.nameEnquiryReference) {
                await bot.sendMessage(chatId, "Bank verification did not return a reference. Please try again.", {
                    reply_markup: { force_reply: true },
                });
                session.step = "bank";
                bankTransferSessions.set(chatId, session);
                return;
            }
            session.step = "amount";
            bankTransferSessions.set(chatId, session);
            await promptBankTransferStep(chatId, session);
            return;
        }
        case "amount": {
            const amount = Number(text.replace(/,/g, ""));
            if (!Number.isFinite(amount) || amount <= 0) {
                await bot.sendMessage(chatId, "Invalid amount. Try again.", { reply_markup: { force_reply: true } });
                return;
            }
            session.data.amount = amount;
            session.step = "narration";
            bankTransferSessions.set(chatId, session);
            await promptBankTransferStep(chatId, session);
            return;
        }
        case "narration": {
            const narration = text.toLowerCase() === "skip" ? "Transfer" : text;
            session.data.narration = narration || "Transfer";
            session.step = "confirm";
            bankTransferSessions.set(chatId, session);
            const summary = buildBankTransferSummary(session);
            await bot.sendMessage(chatId, summary, {
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: "✅ Confirm Transfer", callback_data: "TRANSFER_BANK_CONFIRM::yes" },
                            { text: "❌ Cancel", callback_data: "TRANSFER_BANK_CONFIRM::no" },
                        ],
                        [MENU_BUTTON],
                    ],
                },
            });
            return;
        }
        case "confirm": {
            await bot.sendMessage(chatId, "Use the buttons to confirm the transfer.", {
                reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
            });
            return;
        }
    }
}
async function startElectricityFlow(chatId, message) {
    const session = { step: "service", data: {} };
    electricitySessions.set(chatId, session);
    const lines = [
        "⚡️ Electricity Payment",
        "Send the service name (example: ikeja-electric).",
        "Options: ikeja-electric, eko-electric, kano-electric, portharcourt-electric, jos-electric, kaduna-electric, abuja-electric, ibadan-electric, enugu-electric, benin-electric, aba-electric, yola-electric",
    ];
    await editOrSend(chatId, message, lines.join("\n"), { inline_keyboard: [[MENU_BUTTON]] });
    await bot.sendMessage(chatId, "Enter service name:", { reply_markup: { force_reply: true } });
}
async function promptElectricityStep(chatId, session) {
    if (session.lastPromptStep === session.step)
        return;
    session.lastPromptStep = session.step;
    switch (session.step) {
        case "service":
            await bot.sendMessage(chatId, "Enter service name:", { reply_markup: { force_reply: true } });
            break;
        case "meter":
            await bot.sendMessage(chatId, "Enter meter number:", { reply_markup: { force_reply: true } });
            break;
        case "type":
            await bot.sendMessage(chatId, "Enter meter type (prepaid or postpaid):", { reply_markup: { force_reply: true } });
            break;
        case "phone":
            await bot.sendMessage(chatId, "Enter phone number:", { reply_markup: { force_reply: true } });
            break;
        case "amount":
            await bot.sendMessage(chatId, "Enter amount:", { reply_markup: { force_reply: true } });
            break;
        case "confirm":
            await bot.sendMessage(chatId, "Use the buttons to confirm payment.", {
                reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
            });
            break;
    }
}
function buildElectricitySummary(session) {
    const data = session.data;
    return [
        "⚡️ Electricity Payment Summary",
        data.serviceName ? `Service: ${data.serviceName}` : undefined,
        data.meterNumber ? `Meter: ${data.meterNumber}` : undefined,
        data.meterType ? `Type: ${data.meterType}` : undefined,
        data.phone ? `Phone: ${data.phone}` : undefined,
        data.amount != null ? `Amount: ${data.amount.toFixed(2)}` : undefined,
    ]
        .filter(Boolean)
        .join("\n");
}
async function handleElectricityMessage(msg, session) {
    const chatId = msg.chat.id;
    const text = String(msg.text || "").trim();
    if (!text) {
        await bot.sendMessage(chatId, "Please send a text response.", { reply_markup: { force_reply: true } });
        return;
    }
    switch (session.step) {
        case "service": {
            session.data.serviceName = text.toLowerCase();
            session.step = "meter";
            electricitySessions.set(chatId, session);
            await promptElectricityStep(chatId, session);
            return;
        }
        case "meter": {
            session.data.meterNumber = text.replace(/\s+/g, "");
            session.step = "type";
            electricitySessions.set(chatId, session);
            await promptElectricityStep(chatId, session);
            return;
        }
        case "type": {
            const normalized = text.toLowerCase();
            if (normalized !== "prepaid" && normalized !== "postpaid") {
                await bot.sendMessage(chatId, "Meter type must be prepaid or postpaid.", { reply_markup: { force_reply: true } });
                return;
            }
            session.data.meterType = normalized;
            session.step = "phone";
            electricitySessions.set(chatId, session);
            await promptElectricityStep(chatId, session);
            return;
        }
        case "phone": {
            const phone = text.replace(/[^\d]/g, "");
            if (!phone) {
                await bot.sendMessage(chatId, "Invalid phone number.", { reply_markup: { force_reply: true } });
                return;
            }
            session.data.phone = phone;
            session.step = "amount";
            electricitySessions.set(chatId, session);
            await promptElectricityStep(chatId, session);
            return;
        }
        case "amount": {
            const amount = Number(text.replace(/,/g, ""));
            if (!Number.isFinite(amount) || amount <= 0) {
                await bot.sendMessage(chatId, "Invalid amount. Try again.", { reply_markup: { force_reply: true } });
                return;
            }
            session.data.amount = amount;
            session.step = "confirm";
            electricitySessions.set(chatId, session);
            const summary = buildElectricitySummary(session);
            await bot.sendMessage(chatId, summary, {
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: "✅ Confirm Payment", callback_data: "ELECTRICITY_CONFIRM::yes" },
                            { text: "❌ Cancel", callback_data: "ELECTRICITY_CONFIRM::no" },
                        ],
                        [MENU_BUTTON],
                    ],
                },
            });
            return;
        }
        case "confirm": {
            await bot.sendMessage(chatId, "Use the buttons to confirm the payment.", {
                reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
            });
            return;
        }
    }
}
function buildPayBillsMenuKeyboard() {
    return [
        [
            { text: "⚡️ Electricity", callback_data: "BILLS_ELECTRICITY" },
            { text: "💧 Water", callback_data: "BILLS_WATER" },
        ],
        [
            { text: "📶 Airtime", callback_data: "BILLS_AIRTIME" },
            { text: "🌐 Internet", callback_data: "BILLS_INTERNET" },
        ],
        [
            { text: "📺 TV Package", callback_data: "BILLS_TV" },
            { text: "➕ More", callback_data: "BILLS_MORE" },
        ],
        [MENU_BUTTON],
    ];
}
async function sendPayBillsMenu(chatId, message) {
    await editOrSend(chatId, message, "Choose a bill to pay:", {
        inline_keyboard: buildPayBillsMenuKeyboard(),
    });
}
function buildWalletMenuKeyboard() {
    return [
        [
            { text: "💵 Balance", callback_data: "WALLET_BALANCE" },
            { text: "🔍 My Card", callback_data: "WALLET_MY_CARD" },
        ],
        [
            { text: "💵 Usdt Wallet", callback_data: "WALLET_USDT_ADDRESS" },
        ],
        [
            { text: "📊 USDT Balance", callback_data: "WALLET_USDT_BALANCE" },
            { text: "🧾 USDT History", callback_data: "WALLET_USDT_HISTORY" },
        ],
        [
            { text: "💸 Send USDT", callback_data: "WALLET_USDT_SEND" },
        ],
        [
            { text: "📊 Transaction History", callback_data: "WALLET_TRANSACTIONS" },
            { text: "⬇️ Withdraw", callback_data: "WALLET_WITHDRAW" },
        ],
        [MENU_BUTTON],
    ];
}
async function sendWalletMenu(chatId, message) {
    await editOrSend(chatId, message, "Wallet options:", {
        inline_keyboard: buildWalletMenuKeyboard(),
    });
}
async function editOrSend(chatId, message, text, replyMarkup, parseMode) {
    if (!bot)
        return;
    const messageId = message?.message_id;
    if (messageId) {
        try {
            await bot.editMessageText(text, {
                chat_id: chatId,
                message_id: messageId,
                reply_markup: replyMarkup,
                parse_mode: parseMode,
                disable_web_page_preview: true,
            });
            return;
        }
        catch { }
    }
    await bot.sendMessage(chatId, text, {
        reply_markup: replyMarkup,
        parse_mode: parseMode,
        disable_web_page_preview: true,
    });
}
function buildVerificationHint(method) {
    return method === "telebirr"
        ? [
            "Send your Telebirr reference (from the SMS receipt).",
            "Example: DA91OELAQ1",
            "You can paste the whole SMS text; we will extract the ID.",
            "Or tap /cancel to stop.",
        ].join("\n")
        : [
            "Send your CBE receipt reference.",
            "You can send any of these formats:",
            "- https://apps.cbe.com.et:100/?id=FT26066RPTJ439256208",
            "- FT26066RPTJ439256208",
            "- FT26066RPTJ4&39256208",
            "- The full link, or",
            "- Just the reference: FT26066RPTJ4",
            "We will extract reference/suffix automatically.",
            "Or tap /cancel to stop.",
        ].join("\n");
}
async function startVerificationFlow(chatId, method) {
    const key = chatKey(chatId);
    if (key) {
        const selected = depositSelections.get(chatId);
        const expectedAmount = selected && selected.method === method ? selected.amountEtb : undefined;
        pendingActions.set(key, { type: "verify", method, expectedAmount });
    }
    await bot.sendMessage(chatId, buildVerificationHint(method), {
        reply_markup: { force_reply: true },
    });
}
function normalizeTxnRef(raw, method) {
    if (!raw)
        return "";
    const trimmed = raw.trim();
    if (method === "cbe") {
        let decoded = trimmed;
        try {
            decoded = decodeURIComponent(trimmed);
        }
        catch {
            decoded = trimmed; // fall back to raw if malformed URI
        }
        let candidate = decoded;
        try {
            const url = new URL(decoded);
            const id = (url.searchParams.get("id") || "").trim();
            if (id) {
                candidate = id;
            }
            else {
                const parts = url.pathname.split("/").filter(Boolean);
                if (parts.length)
                    candidate = parts[parts.length - 1];
            }
        }
        catch {
            candidate = decoded;
        }
        const text = String(candidate || decoded).trim();
        const amp = text.split("&").map((p) => p.trim()).filter(Boolean);
        if (amp.length >= 2) {
            const ref = (amp[0].match(/FT[A-Z0-9]{10}/i)?.[0] || amp[0]).toUpperCase();
            const suffix = (amp[1].match(/\d{8}/)?.[0] || "").trim();
            return suffix ? `${ref}&${suffix}` : ref;
        }
        const concat = text.match(/(FT[A-Z0-9]{10})(\d{8})$/i);
        if (concat) {
            return `${concat[1].toUpperCase()}&${concat[2]}`;
        }
        const refOnly = text.match(/FT[A-Z0-9]{10}/i);
        if (refOnly)
            return refOnly[0].toUpperCase();
        return text.toUpperCase();
    }
    // Telebirr: attempt to extract reference from SMS text or embedded link
    try {
        const urlMatch = trimmed.match(/https?:\/\/[^\s]*transactioninfo\.ethiotelecom\.et\/receipt\/([A-Za-z0-9]+)/i);
        if (urlMatch && urlMatch[1])
            return urlMatch[1].toUpperCase();
        const phraseMatch = trimmed.match(/transaction\s+number\s+is\s+([A-Za-z0-9]+)/i);
        if (phraseMatch && phraseMatch[1])
            return phraseMatch[1].toUpperCase();
        // Fallback: choose the last likely uppercase alphanumeric token of length 8-14
        const tokens = trimmed.match(/[A-Z0-9]{8,14}/g);
        if (tokens && tokens.length)
            return tokens[tokens.length - 1].toUpperCase();
    }
    catch { }
    return trimmed;
}
function normalizeName(value) {
    const raw = (value || "").toLowerCase().normalize("NFKD");
    return raw
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\bh\s*\/?\s*mariam\b/g, "hailemariam")
        .replace(/\bhay?ilemariyam\b/g, "hailemariam")
        .replace(/\bmekonen\b/g, "mekonnen")
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}
function normalizeDigits(value) {
    return (value || "").replace(/\D+/g, "");
}
function namesMatch(expectedRaw, actualRaw) {
    const expected = normalizeName(expectedRaw);
    const actual = normalizeName(actualRaw);
    if (!expected || !actual)
        return false;
    if (expected === actual)
        return true;
    const expectedTokens = expected.split(" ").filter((t) => t.length > 1);
    const actualTokens = actual.split(" ").filter((t) => t.length > 1);
    if (!expectedTokens.length || !actualTokens.length)
        return false;
    const actualSet = new Set(actualTokens);
    let overlap = 0;
    for (const token of expectedTokens) {
        if (actualSet.has(token))
            overlap += 1;
    }
    if (overlap >= expectedTokens.length)
        return true;
    return overlap >= 2 && overlap >= Math.min(expectedTokens.length, actualTokens.length) - 1;
}
async function findUsedPaymentReference(paymentMethod, normalizedTxn) {
    const enableTestVerification = String(process.env.ENABLE_TEST_VERIFICATION || "false").toLowerCase() === "true";
    const testTransactionId = (process.env.TEST_TRANSACTION_ID || "").trim();
    if (enableTestVerification &&
        paymentMethod === "telebirr" &&
        testTransactionId &&
        normalizedTxn.toUpperCase() === testTransactionId.toUpperCase()) {
        return null;
    }
    if ((0, persistence_1.isPrismaPersistenceEnabled)()) {
        return prisma_1.default.transaction.findFirst({
            where: {
                paymentMethod,
                transactionType: { in: ["deposit", "verification", "card"] },
                OR: [{ transactionNumber: normalizedTxn }, { referenceNumber: normalizedTxn }],
            },
            orderBy: { createdAt: "desc" },
        });
    }
    return await Transaction_1.default.findOne({
        paymentMethod,
        transactionType: { $in: ["deposit", "verification", "card"] },
        $or: [{ transactionNumber: normalizedTxn }, { referenceNumber: normalizedTxn }],
    }).lean();
}
function digitsMatch(expectedRaw, actualRaw) {
    const expected = normalizeDigits(expectedRaw);
    const actual = normalizeDigits(actualRaw);
    if (!expected || !actual)
        return false;
    if (expected === actual)
        return true;
    // Allow last 4 or 6 digits match for masked numbers
    const last4 = expected.slice(-4);
    if (last4 && actual.endsWith(last4))
        return true;
    const last6 = expected.slice(-6);
    if (last6 && actual.endsWith(last6))
        return true;
    return false;
}
function parseMoney(value) {
    if (typeof value === "number")
        return value;
    if (typeof value !== "string")
        return undefined;
    const cleaned = value.replace(/[^\d.,-]/g, "").replace(/,/g, "");
    const num = parseFloat(cleaned);
    return Number.isFinite(num) ? num : undefined;
}
function formatMoney(value, currency) {
    const label = currency && currency !== "ETB" ? currency : "Birr";
    return `${value.toFixed(2)} ${label}`;
}
function extractReceiptFields(body) {
    const raw = body?.raw ?? body ?? {};
    const candidate = raw?.transactionDetails || raw?.data?.transactionDetails || raw?.data || raw;
    const receiverName = candidate?.creditedPartyName || candidate?.receiverName || candidate?.receiver || candidate?.recipientName || candidate?.to || candidate?.payeeName || candidate?.creditedName || raw?.creditedPartyName;
    const payerName = candidate?.payerName || candidate?.payer || candidate?.from || candidate?.senderName || raw?.payerName;
    const receiverAccount = candidate?.accountNumber || candidate?.receiverAccountNumber || candidate?.creditedAccount || candidate?.creditedAccountNumber || candidate?.account || candidate?.accountNo || candidate?.receiverAccount || candidate?.creditedPartyAccountNo || raw?.accountNumber;
    const receiverPhone = candidate?.receiverPhone || candidate?.receiverMSISDN || candidate?.receiverMobile || candidate?.destination || candidate?.toPhone || candidate?.payeePhone || candidate?.creditedPartyAccountNo;
    const payerPhone = candidate?.payerPhone || candidate?.payerMSISDN || candidate?.payerMobile || candidate?.fromPhone || candidate?.senderPhone;
    const amountFromBody = typeof body?.amount === "number" ? body.amount : undefined;
    const amountCandidate = parseMoney(candidate?.settledAmount) ?? parseMoney(candidate?.totalPaidAmount) ?? parseMoney(candidate?.amount) ?? amountFromBody;
    const serviceFee = parseMoney(candidate?.serviceFee ?? candidate?.fee);
    const serviceFeeVAT = parseMoney(candidate?.serviceFeeVAT ?? candidate?.vat ?? candidate?.vatAmount);
    const totalPaid = parseMoney(candidate?.totalPaidAmount ?? candidate?.totalPaid ?? candidate?.total_amount);
    return { receiverName, payerName, payerPhone, receiverAccount, receiverPhone, amount: amountCandidate, serviceFee, serviceFeeVAT, totalPaid };
}
function validateVerificationResult(params) {
    const { method, body, selected } = params;
    const enableTestVerification = String(process.env.ENABLE_TEST_VERIFICATION || "false").toLowerCase() === "true";
    const testTransactionId = (process.env.TEST_TRANSACTION_ID || "").trim();
    const normalizedTxn = String(body?.transactionNumber || body?.reference || body?.raw?.data?.receiptNo || body?.raw?.receiptNo || "").trim();
    const isTestTelebirr = enableTestVerification &&
        method === "telebirr" &&
        testTransactionId &&
        normalizedTxn.toUpperCase() === testTransactionId.toUpperCase();
    const { receiverName, receiverAccount, receiverPhone, payerPhone, amount, totalPaid } = extractReceiptFields(body);
    const errors = [];
    const expectedName = method === "telebirr" ? EXPECTED_TELEBIRR_NAME : EXPECTED_RECEIVER_NAME;
    const strictNameCheck = method === "telebirr" ? TELEBIRR_STRICT_RECEIVER : CBE_STRICT_RECEIVER;
    if (!isTestTelebirr && strictNameCheck && expectedName) {
        if (!receiverName)
            errors.push("Receiver name missing on receipt");
        else if (!namesMatch(expectedName, receiverName))
            errors.push("Receiver name does not match the expected payment account.");
    }
    if (!isTestTelebirr && method === "telebirr" && EXPECTED_TELEBIRR_PHONE) {
        const expectedPhone = EXPECTED_TELEBIRR_PHONE;
        const masked = receiverPhone && receiverPhone.includes("*");
        const phoneToCheck = receiverPhone || payerPhone;
        if (!phoneToCheck) {
            errors.push("Receiver phone missing on Telebirr receipt");
        }
        else if (masked) {
            // For masked numbers, allow lenient suffix match
            if (!digitsMatch(expectedPhone, phoneToCheck)) {
                // Do not hard-fail masked mismatch; only warn if payer phone also mismatches
                if (payerPhone && !digitsMatch(expectedPhone, payerPhone)) {
                    errors.push("Receiver phone number does not match");
                }
            }
        }
        else if (!digitsMatch(expectedPhone, phoneToCheck)) {
            errors.push("Receiver phone number does not match");
        }
    }
    if (method === "cbe" && EXPECTED_CBE_ACCOUNT) {
        // Be lenient for CBE: many receipts mask or route through settlement accounts.
        // Do not fail verification purely on account mismatch.
        // If needed, we can enable strict checking via an env flag in the future.
    }
    if (selected && selected.method === method) {
        const expectedTotal = Number(selected.totalEtb ?? selected.amountEtb ?? selected.amount ?? NaN);
        // Prefer the transferred/settled amount for validation. Some providers include
        // extra provider-side charges in totalPaidAmount that users don't control.
        const paid = typeof amount === "number" ? amount : totalPaid;
        if (!Number.isFinite(expectedTotal)) {
            errors.push("Expected payment amount could not be determined.");
        }
        else if (typeof paid !== "number") {
            errors.push("Payment total is missing in provider response.");
        }
        else if (Math.abs(paid - expectedTotal) > 2) {
            errors.push("Payment total does not match the expected amount (including service fee).");
        }
    }
    return errors;
}
async function queueDepositManualReview(params) {
    const { userId, paymentMethod, transactionNumber, expectedAmountEtb, reason, responseData } = params;
    const txn = normalizeTxnRef(transactionNumber, paymentMethod);
    if (!txn)
        return { queued: false, transactionId: null };
    if ((0, persistence_1.isPrismaPersistenceEnabled)()) {
        const existing = await prisma_1.default.transaction.findFirst({
            where: {
                userId,
                transactionType: "deposit",
                OR: [{ transactionNumber: txn }, { referenceNumber: txn }],
            },
            orderBy: { createdAt: "desc" },
        });
        if (existing?.status === "completed") {
            return { queued: false, transactionId: String(existing.id) };
        }
        const amountEtb = Number.isFinite(expectedAmountEtb) ? Number(expectedAmountEtb) : undefined;
        const data = {
            paymentMethod,
            amount: amountEtb ?? 0,
            amountEtb,
            referenceNumber: txn,
            status: "pending",
            verified: false,
            responseData: responseData || undefined,
            metadata: {
                manualReviewRequired: true,
                expectedAmountEtb: amountEtb,
                verificationMode: "manual_fallback",
                verificationFailureReason: reason,
                queuedAt: new Date(),
            },
            currency: "ETB",
        };
        if (existing) {
            const updated = await prisma_1.default.transaction.update({ where: { id: existing.id }, data });
            return { queued: true, transactionId: String(updated.id) };
        }
        const created = await prisma_1.default.transaction.create({
            data: {
                userId,
                transactionType: "deposit",
                transactionNumber: txn,
                ...data,
            },
        });
        return { queued: true, transactionId: String(created.id) };
    }
    const existing = await Transaction_1.default.findOne({
        userId,
        transactionType: "deposit",
        transactionNumber: txn,
    }).lean();
    if (existing?.status === "completed") {
        return { queued: false, transactionId: String(existing._id) };
    }
    const amountEtb = Number.isFinite(expectedAmountEtb) ? Number(expectedAmountEtb) : undefined;
    try {
        const doc = await Transaction_1.default.findOneAndUpdate({
            userId,
            transactionType: "deposit",
            $or: [{ transactionNumber: txn }, { referenceNumber: txn }],
        }, {
            $set: {
                paymentMethod,
                amount: amountEtb ?? 0,
                amountEtb,
                referenceNumber: txn,
                status: "pending",
                verified: false,
                responseData,
                metadata: {
                    manualReviewRequired: true,
                    expectedAmountEtb: amountEtb,
                    verificationMode: "manual_fallback",
                    verificationFailureReason: reason,
                    queuedAt: new Date(),
                },
            },
            $setOnInsert: {
                transactionNumber: txn,
                referenceNumber: txn,
                currency: "ETB",
            },
        }, { upsert: true, new: true });
        return { queued: true, transactionId: String(doc._id) };
    }
    catch (err) {
        if (err?.code === 11000) {
            const duplicate = await Transaction_1.default.findOne({
                userId,
                transactionType: "deposit",
                $or: [{ transactionNumber: txn }, { referenceNumber: txn }],
            }).lean();
            if (duplicate) {
                return { queued: true, transactionId: String(duplicate._id) };
            }
        }
        throw err;
    }
}
async function queueCardRequestManualReview(params) {
    const { userId, paymentMethod, transactionNumber, expectedAmountEtb, cardAmountUsd, feeUsd, totalUsd, rate, reason, responseData, } = params;
    const txn = normalizeTxnRef(transactionNumber, paymentMethod);
    if (!txn)
        return { queued: false, transactionId: null };
    if ((0, persistence_1.isPrismaPersistenceEnabled)()) {
        const existing = await prisma_1.default.transaction.findFirst({
            where: {
                userId,
                transactionType: "deposit",
                OR: [{ transactionNumber: txn }, { referenceNumber: txn }],
            },
            orderBy: { createdAt: "desc" },
        });
        if (existing?.status === "completed" && existing.metadata?.kind === "card_request_manual") {
            return { queued: false, transactionId: String(existing.id) };
        }
        const data = {
            paymentMethod,
            amount: expectedAmountEtb,
            amountEtb: expectedAmountEtb,
            referenceNumber: txn,
            status: "pending",
            verified: false,
            responseData: responseData || undefined,
            metadata: {
                kind: "card_request_manual",
                manualReviewRequired: true,
                expectedAmountEtb,
                cardAmountUsd,
                feeUsd,
                totalUsd,
                conversionRateEtbPerUsdt: rate,
                verificationMode: "manual_fallback",
                verificationFailureReason: reason,
                queuedAt: new Date(),
            },
            currency: "ETB",
        };
        if (existing) {
            const updated = await prisma_1.default.transaction.update({ where: { id: existing.id }, data });
            return { queued: true, transactionId: String(updated.id) };
        }
        const created = await prisma_1.default.transaction.create({
            data: {
                userId,
                transactionType: "deposit",
                transactionNumber: txn,
                ...data,
            },
        });
        return { queued: true, transactionId: String(created.id) };
    }
    const existing = await Transaction_1.default.findOne({
        userId,
        transactionType: "deposit",
        $or: [{ transactionNumber: txn }, { referenceNumber: txn }],
        "metadata.kind": "card_request_manual",
    }).lean();
    if (existing?.status === "completed") {
        return { queued: false, transactionId: String(existing._id) };
    }
    try {
        const doc = await Transaction_1.default.findOneAndUpdate({
            userId,
            transactionType: "deposit",
            $or: [{ transactionNumber: txn }, { referenceNumber: txn }],
        }, {
            $set: {
                paymentMethod,
                amount: expectedAmountEtb,
                amountEtb: expectedAmountEtb,
                referenceNumber: txn,
                status: "pending",
                verified: false,
                responseData,
                metadata: {
                    kind: "card_request_manual",
                    manualReviewRequired: true,
                    expectedAmountEtb,
                    cardAmountUsd,
                    feeUsd,
                    totalUsd,
                    conversionRateEtbPerUsdt: rate,
                    verificationMode: "manual_fallback",
                    verificationFailureReason: reason,
                    queuedAt: new Date(),
                },
            },
            $setOnInsert: {
                transactionNumber: txn,
                referenceNumber: txn,
                currency: "ETB",
            },
        }, { upsert: true, new: true });
        return { queued: true, transactionId: String(doc._id) };
    }
    catch (err) {
        if (err?.code === 11000) {
            const duplicate = await Transaction_1.default.findOne({
                userId,
                transactionType: "deposit",
                $or: [{ transactionNumber: txn }, { referenceNumber: txn }],
            }).lean();
            if (duplicate) {
                return { queued: true, transactionId: String(duplicate._id) };
            }
        }
        throw err;
    }
}
async function handleMenuSelection(action, chatId, message) {
    if (shouldSuppressOutgoing(chatId, `menu_action:${action}`, 1200))
        return;
    if (action.startsWith("TXN_PAGE_ALL::")) {
        const [, pageRaw, daysRaw] = action.split("::");
        const page = Number(pageRaw);
        const days = Number(daysRaw);
        return sendCardTransactions(chatId, undefined, Number.isFinite(page) ? page : 1, Number.isFinite(days) ? days : 0);
    }
    if (action.startsWith("TXN_PAGE_CARD::")) {
        const [, cardId, pageRaw, daysRaw] = action.split("::");
        const page = Number(pageRaw);
        const days = Number(daysRaw);
        if (!cardId) {
            return sendCardTransactions(chatId, undefined, Number.isFinite(page) ? page : 1, Number.isFinite(days) ? days : 0);
        }
        return sendCardTransactions(chatId, cardId, Number.isFinite(page) ? page : 1, Number.isFinite(days) ? days : 0);
    }
    if (action.startsWith("TXN_FILTER_ALL::")) {
        const days = Number(action.replace("TXN_FILTER_ALL::", ""));
        return sendCardTransactions(chatId, undefined, 1, Number.isFinite(days) ? days : 0);
    }
    if (action.startsWith("TXN_FILTER_CARD::")) {
        const [, cardId, daysRaw] = action.split("::");
        const days = Number(daysRaw);
        if (!cardId)
            return sendCardTransactions(chatId, undefined, 1, Number.isFinite(days) ? days : 0);
        return sendCardTransactions(chatId, cardId, 1, Number.isFinite(days) ? days : 0);
    }
    if (action.startsWith("CARD_DETAIL::")) {
        const cardId = action.replace("CARD_DETAIL::", "");
        return sendCardDetail(chatId, cardId);
    }
    if (action.startsWith("CARD_TXN::")) {
        const cardId = action.replace("CARD_TXN::", "");
        return sendCardTransactions(chatId, cardId);
    }
    if (action.startsWith("TXN_DETAIL::")) {
        const txnId = action.replace("TXN_DETAIL::", "");
        return sendCardTransactionDetail(chatId, txnId);
    }
    if (action.startsWith("CARD_FREEZE::")) {
        const cardId = action.replace("CARD_FREEZE::", "");
        return handleFreezeAction(chatId, cardId, "freeze");
    }
    if (action.startsWith("CARD_UNFREEZE::")) {
        const cardId = action.replace("CARD_UNFREEZE::", "");
        return handleFreezeAction(chatId, cardId, "unfreeze");
    }
    switch (action) {
        case "MENU_CREATE_CARD":
            return handleCardRequest(chatId, message);
        case "MENU_MY_CARDS":
            return sendMyCards(chatId, message);
        case "MENU_USER_INFO":
            return sendUserInfo(chatId, message);
        case "MENU_DEPOSIT":
            return sendDepositMenu(chatId, message);
        case "MENU_TRANSFER":
            return sendTransferMenu(chatId, message);
        case "MENU_PAY_BILLS":
            return sendPayBillsMenu(chatId, message);
        case "MENU_WALLET":
            return sendWalletMenu(chatId, message);
        case "DEPOSIT_MENU_BANK":
            return sendDepositAmountSelect(chatId, "cbe");
        case "DEPOSIT_MENU_MOBILE":
            return sendDepositAmountSelect(chatId, "telebirr");
        case "DEPOSIT_MENU_CARD":
            return bot.sendMessage(chatId, "Card deposits are not available yet.", {
                reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
            });
        case "DEPOSIT_MENU_INTL":
            return bot.sendMessage(chatId, "International deposits are not available yet.", {
                reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
            });
        case "TRANSFER_PHONE":
        case "TRANSFER_CARD":
        case "TRANSFER_USERNAME":
            return bot.sendMessage(chatId, "Only bank transfers are available right now.", {
                reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
            });
        case "TRANSFER_BANK":
            return startBankTransferFlow(chatId, message);
        case "BILLS_ELECTRICITY":
            return startElectricityFlow(chatId, message);
        case "BILLS_WATER":
            return bot.sendMessage(chatId, "Water payments are not available yet.", {
                reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
            });
        case "BILLS_TV":
            return bot.sendMessage(chatId, "TV packages are not available yet.", {
                reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
            });
        case "BILLS_MORE":
            return bot.sendMessage(chatId, "More bill types are coming soon.", {
                reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
            });
        case "BILLS_AIRTIME":
            return sendAirtimePrompt(chatId, message);
        case "BILLS_INTERNET":
            {
                const key = chatKey(chatId);
                if (key)
                    pendingActions.set(key, { type: "internet_plans" });
            }
            return bot.sendMessage(chatId, "Send the internet provider id (example: spectranet or smile-direct).", {
                reply_markup: { force_reply: true },
            });
        case "WALLET_BALANCE":
            return sendWalletSummary(chatId, message);
        case "WALLET_MY_CARD":
            return sendMyCards(chatId, message);
        case "WALLET_VIRTUAL_ACCOUNT":
            return bot.sendMessage(chatId, "Virtual accounts are available for Nigerian users only.", {
                reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
            });
        case "WALLET_CREATE_VIRTUAL_ACCOUNT":
            return bot.sendMessage(chatId, "Virtual accounts are available for Nigerian users only.", {
                reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
            });
        case "WALLET_USDT_ADDRESS":
            return sendUsdtAddress(chatId, message);
        case "WALLET_CREATE_USDT_ADDRESS":
            return sendUsdtAddress(chatId, message, { forceCreate: true });
        case "WALLET_USDT_BALANCE":
            return sendUsdtBalance(chatId, message);
        case "WALLET_USDT_HISTORY":
            return sendUsdtHistory(chatId, undefined, message);
        case "WALLET_USDT_SEND":
            return sendUsdtSendPrompt(chatId, message);
        case "WALLET_TRANSACTIONS":
            return sendCardTransactions(chatId);
        case "WALLET_WITHDRAW":
            return bot.sendMessage(chatId, "Withdraw is not available yet.", {
                reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
            });
        case "WALLET_AIRTIME":
            return sendAirtimePrompt(chatId, message);
        case "WALLET_DATA_PLANS":
            return sendDataPlans(chatId, "mtn-data", message);
        case "MENU_INVITE":
            return bot.sendMessage(chatId, "Invite friends and earn rewards: share your referral link from the app.", {
                reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
            });
        default:
            return bot.sendMessage(chatId, "Action not recognized. Use the menu again.", { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
    }
}
async function sendDepositInfo(chatId, message) {
    if (shouldSuppressOutgoing(chatId, "deposit_menu"))
        return;
    await editOrSend(chatId, message, "Choose a payment method to deposit:", {
        inline_keyboard: buildDepositMethodKeyboard(),
    });
}
function buildDepositMethodKeyboard() {
    return [
        [
            { text: "Telebirr", callback_data: "DEPOSIT_METHOD::telebirr" },
            { text: "CBE", callback_data: "DEPOSIT_METHOD::cbe" },
        ],
        [{ text: "🧮 Conversion", callback_data: "DEPOSIT_CONVERT" }],
        [MENU_BUTTON],
    ];
}
function buildCardRequestMethodKeyboard() {
    return [
        [
            { text: "Telebirr", callback_data: "CARDPAY_METHOD::telebirr" },
            { text: "CBE", callback_data: "CARDPAY_METHOD::cbe" },
        ],
        [MENU_BUTTON],
    ];
}
function roundMoney(value) {
    return Math.round(value * 100) / 100;
}
function computeDepositQuoteByEtb(amountEtb, rate) {
    const amountUsd = amountEtb / rate;
    const feeUsd = BOT_DEPOSIT_FIXED_FEE_USD + (amountUsd * BOT_DEPOSIT_PERCENT_FEE) / 100;
    const totalUsd = amountUsd + feeUsd;
    const totalEtb = totalUsd * rate;
    return {
        amountUsd: roundMoney(amountUsd),
        feeUsd: roundMoney(feeUsd),
        totalUsd: roundMoney(totalUsd),
        totalEtb: roundMoney(totalEtb),
    };
}
function normalizePayableEtb(value) {
    if (!Number.isFinite(value) || value <= 0)
        return value;
    const hasFraction = Math.abs(value - Math.trunc(value)) > 0.00001;
    if (!hasFraction)
        return value;
    return Math.ceil(value / 50) * 50;
}
async function sendDepositConversionPreview(chatId, usdAmount) {
    if (!Number.isFinite(usdAmount) || usdAmount <= 0) {
        await bot.sendMessage(chatId, "Please enter a valid USD amount greater than 0.", {
            reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
        });
        return;
    }
    const config = await (0, pricingService_1.loadPricingConfig)();
    const rate = Number(config.usdtRate) > 0 ? Number(config.usdtRate) : 220;
    const feeUsd = BOT_DEPOSIT_FIXED_FEE_USD + (usdAmount * BOT_DEPOSIT_PERCENT_FEE) / 100;
    const totalUsd = usdAmount + feeUsd;
    const creditAmountEtb = usdAmount * rate;
    const totalEtb = normalizePayableEtb(totalUsd * rate);
    depositConversionSelections.set(chatId, {
        requestedUsd: roundMoney(usdAmount),
        creditAmountEtb: roundMoney(creditAmountEtb),
        feeUsd: roundMoney(feeUsd),
        totalUsd: roundMoney(totalUsd),
        totalEtb: roundMoney(totalEtb),
        rate,
    });
    const lines = [
        "🧮 Deposit Converter",
        `Requested amount: $${usdAmount.toFixed(2)}`,
        `Service fee: $${BOT_DEPOSIT_FIXED_FEE_USD.toFixed(2)} + ${BOT_DEPOSIT_PERCENT_FEE.toFixed(2)}%`,
        `Total to pay: ${totalEtb.toFixed(2)} ETB`,
    ];
    await bot.sendMessage(chatId, lines.join("\n"), {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "Telebirr", callback_data: "DEPOSIT_METHOD::telebirr" },
                    { text: "CBE", callback_data: "DEPOSIT_METHOD::cbe" },
                ],
                [MENU_BUTTON],
            ],
        },
    });
}
async function sendDepositAmountSelect(chatId, method) {
    const methodLabel = method === "cbe" ? "CBE" : "Telebirr";
    const buttons = DEPOSIT_AMOUNTS.map((amt) => ({ text: `${amt} ETB`, callback_data: `DEPOSIT_AMOUNT::${method}::${amt}` }));
    const rows = chunk(buttons, 3);
    rows.push([{ text: "🧮 Enter custom amount", callback_data: `DEPOSIT_CUSTOM::${method}` }]);
    rows.push([{ text: "🔁 Choose method", callback_data: "MENU_DEPOSIT" }]);
    rows.push([MENU_BUTTON]);
    await bot.sendMessage(chatId, `Select amount for ${methodLabel} (minimum ${MIN_DEPOSIT_ETB} ETB):`, {
        reply_markup: { inline_keyboard: rows },
    });
}
async function sendDepositSummary(chatId, method, amount, options) {
    if (!Number.isFinite(amount) || amount < MIN_DEPOSIT_ETB) {
        await bot.sendMessage(chatId, `Minimum deposit is ${MIN_DEPOSIT_ETB} ETB.`, {
            reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
        });
        return;
    }
    const meta = DEPOSIT_ACCOUNTS[method];
    const config = await (0, pricingService_1.loadPricingConfig)();
    const rate = Number(config.usdtRate) > 0 ? Number(config.usdtRate) : 220;
    const quote = computeDepositQuoteByEtb(amount, rate);
    const payableEtb = Number.isFinite(options?.payableAmountEtb)
        ? Number(options.payableAmountEtb)
        : normalizePayableEtb(quote.totalEtb);
    const displayAmountEtb = Number.isFinite(options?.displayAmountEtb)
        ? Number(options.displayAmountEtb)
        : amount;
    const creditedUsd = Number.isFinite(options?.creditedUsd)
        ? Number(options.creditedUsd)
        : quote.amountUsd;
    depositSelections.set(chatId, {
        method,
        amountEtb: payableEtb,
        creditAmountEtb: amount,
        amountUsd: creditedUsd,
        feeUsd: quote.feeUsd,
        totalUsd: quote.totalUsd,
        totalEtb: payableEtb,
        rate,
    });
    const lines = [
        `${meta.title}:`,
        `Amount: ${displayAmountEtb.toFixed(2)} ETB`,
        `Service fee: $${BOT_DEPOSIT_FIXED_FEE_USD.toFixed(2)}+${BOT_DEPOSIT_PERCENT_FEE.toFixed(2)}%`,
        `Account: ${meta.account}`,
        `Name: ${meta.name}`,
        "",
        `Total to pay: ${payableEtb.toFixed(2)} ETB`,
        `💵 ${creditedUsd.toFixed(2)}$ will be deposited to your card`,
        "",
        "Tap Copy to copy the account number, pay, then Verify to share your receipt/reference.",
    ];
    const keyboard = [
        [{ text: "📋 Copy account", copy_text: { text: meta.account } }],
        [{ text: "✅ Verify payment", callback_data: `DEPOSIT_VERIFY::${method}` }],
        [{ text: "💵 Change amount", callback_data: options?.fromConversion ? `DEPOSIT_CHANGE::${method}` : `DEPOSIT_METHOD::${method}` }],
        [{ text: "🔁 Switch method", callback_data: "MENU_DEPOSIT" }],
        [MENU_BUTTON],
    ];
    await bot.sendMessage(chatId, lines.join("\n"), {
        reply_markup: { inline_keyboard: keyboard },
    });
}
async function handleCardRequest(chatId, message, options) {
    if (shouldSuppressOutgoing(chatId, "card_request"))
        return;
    const userId = String(chatId);
    const { user, customer: customerRecord } = await getUserAndCustomerContext(userId);
    const existingCard = (0, persistence_1.isPrismaPersistenceEnabled)()
        ? await prisma_1.default.card.findFirst({ where: { userId }, orderBy: { updatedAt: "desc" } })
        : await Card_1.default.findOne({ userId }).lean();
    const approvedRequest = (0, persistence_1.isPrismaPersistenceEnabled)()
        ? await prisma_1.default.cardRequest.findFirst({ where: { userId, status: "approved" }, orderBy: { updatedAt: "desc" } })
        : await CardRequest_1.default.findOne({ userId, status: "approved" }).lean();
    if (existingCard || approvedRequest) {
        await bot.sendMessage(chatId, "❌ You already have a card. Multiple cards are not allowed.", {
            reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
        });
        return;
    }
    if (!options?.skipProfile) {
        const missing = getCardProfileMissingFields(user, customerRecord);
        if (missing.length) {
            await startCardProfileFlow(chatId, message, user, customerRecord);
            return;
        }
    }
    const pendingRequest = (0, persistence_1.isPrismaPersistenceEnabled)()
        ? await prisma_1.default.cardRequest.findFirst({ where: { userId, status: "pending" }, orderBy: { updatedAt: "desc" } })
        : await CardRequest_1.default.findOne({ userId, status: "pending" }).lean();
    if (pendingRequest) {
        await bot.sendMessage(chatId, "⏳ Your card request is already being processed.", {
            reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
        });
        return;
    }
    const customerEmail = (customerRecord?.email || user?.customerEmail || "").trim();
    if (!customerEmail) {
        await bot.sendMessage(chatId, "❌ Missing email for card creation. Please provide your email.", {
            reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
        });
        return;
    }
    const config = await (0, pricingService_1.loadPricingConfig)();
    const rate = Number(config.usdtRate) > 0 ? Number(config.usdtRate) : 220;
    const cardAmountUsd = Math.max(0, Number(config.firstCardAmountUsd ?? 5));
    const feeUsd = Math.max(0, Number(config.firstCardFeeUsd ?? 0));
    const totalUsd = roundMoney(cardAmountUsd + feeUsd);
    const totalEtb = roundMoney(totalUsd * rate);
    cardRequestSelections.set(chatId, {
        cardAmountUsd,
        feeUsd,
        totalUsd,
        totalEtb,
        rate,
    });
    const lines = [
        "💳 Card request payment required.",
        `Card amount: ${(cardAmountUsd * rate).toFixed(2)} ETB`,
        `Service fee: $${feeUsd.toFixed(2)}`,
        `Total to pay: ${totalEtb.toFixed(2)} ETB`,
        "Choose a payment method:",
    ];
    await bot.sendMessage(chatId, lines.join("\n"), {
        reply_markup: { inline_keyboard: buildCardRequestMethodKeyboard() },
    });
}
function getCardProfileMissingFields(user, customer) {
    const idNumber = decryptKycIdNumber(customer?.idNumberEncrypted || user?.idNumberEncrypted);
    const fields = {
        firstName: user?.firstName || customer?.firstName,
        lastName: user?.lastName || customer?.lastName,
        dateOfBirth: user?.dateOfBirth || customer?.dateOfBirth,
        phoneNumber: user?.phoneNumber || customer?.phoneNumber,
        customerEmail: user?.customerEmail || customer?.email,
        line1: user?.line1 || customer?.line1,
        zipCode: user?.zipCode || customer?.zipCode,
        idNumber,
    };
    return Object.entries(fields)
        .filter(([, value]) => !String(value || "").trim())
        .map(([key]) => key);
}
function nextCardProfileStep(data) {
    if (!data.firstName)
        return "firstName";
    if (!data.lastName)
        return "lastName";
    if (!data.dateOfBirth)
        return "dateOfBirth";
    if (!data.phoneNumber)
        return "phoneNumber";
    if (!data.customerEmail)
        return "customerEmail";
    if (!data.line1)
        return "line1";
    if (!data.zipCode)
        return "zipCode";
    if (!data.idNumber)
        return "idNumber";
    return "confirm";
}
async function startCardProfileFlow(chatId, message, user, customer) {
    const data = {
        firstName: user?.firstName || customer?.firstName || message?.from?.first_name,
        lastName: user?.lastName || customer?.lastName || undefined,
        dateOfBirth: user?.dateOfBirth || customer?.dateOfBirth || undefined,
        phoneNumber: user?.phoneNumber || customer?.phoneNumber || undefined,
        customerEmail: user?.customerEmail || customer?.email || undefined,
        line1: user?.line1 || customer?.line1 || undefined,
        zipCode: user?.zipCode || customer?.zipCode || undefined,
        idNumber: decryptKycIdNumber(customer?.idNumberEncrypted || user?.idNumberEncrypted),
    };
    const step = nextCardProfileStep(data);
    cardProfileSessions.set(chatId, { step, data, origin: "card_request" });
    await bot.sendMessage(chatId, "💳 Card profile setup\nPlease provide these details to create your card.", { reply_markup: { inline_keyboard: [[{ text: "Cancel", callback_data: "CANCEL" }]] } });
    await promptCardProfileStep(chatId, cardProfileSessions.get(chatId));
}
async function handleCardProfileMessage(msg, session) {
    const chatId = msg.chat.id;
    const text = msg.text ? String(msg.text).trim() : "";
    if (!text) {
        await bot.sendMessage(chatId, "Please send a text response.", { reply_markup: { force_reply: true } });
        return;
    }
    switch (session.step) {
        case "firstName":
            session.data.firstName = text;
            break;
        case "lastName":
            session.data.lastName = text;
            break;
        case "dateOfBirth":
            if (!PROFILE_DOB_REGEX.test(text)) {
                await bot.sendMessage(chatId, "Invalid date format. Use MM/DD/YYYY.", { reply_markup: { force_reply: true } });
                return;
            }
            session.data.dateOfBirth = text;
            break;
        case "phoneNumber":
            if (!PROFILE_PHONE_REGEX.test(text)) {
                await bot.sendMessage(chatId, "Invalid phone number. Use international format without '+'.", { reply_markup: { force_reply: true } });
                return;
            }
            session.data.phoneNumber = text;
            break;
        case "customerEmail":
            if (!/.+@.+\..+/.test(text)) {
                await bot.sendMessage(chatId, "Invalid email format. Try again.", { reply_markup: { force_reply: true } });
                return;
            }
            session.data.customerEmail = text;
            break;
        case "line1":
            session.data.line1 = text;
            break;
        case "zipCode":
            session.data.zipCode = text;
            break;
        case "idNumber":
            session.data.idNumber = text;
            break;
        case "confirm":
            await bot.sendMessage(chatId, "Please use the buttons to confirm submission.", {
                reply_markup: { inline_keyboard: buildCardProfileConfirmKeyboard() },
            });
            return;
    }
    session.step = nextCardProfileStep(session.data);
    cardProfileSessions.set(chatId, session);
    await promptCardProfileStep(chatId, session);
}
async function promptCardProfileStep(chatId, session) {
    if (session.lastPromptStep === session.step)
        return;
    session.lastPromptStep = session.step;
    switch (session.step) {
        case "firstName":
            await bot.sendMessage(chatId, "Enter your first name:", { reply_markup: { force_reply: true } });
            break;
        case "lastName":
            await bot.sendMessage(chatId, "Enter your last name:", { reply_markup: { force_reply: true } });
            break;
        case "dateOfBirth":
            await bot.sendMessage(chatId, "Enter your date of birth (MM/DD/YYYY):", { reply_markup: { force_reply: true } });
            break;
        case "phoneNumber":
            await bot.sendMessage(chatId, "Enter your phone number (international, no '+'):", { reply_markup: { force_reply: true } });
            break;
        case "customerEmail":
            await bot.sendMessage(chatId, "Enter your email address:", { reply_markup: { force_reply: true } });
            break;
        case "line1":
            await bot.sendMessage(chatId, "Enter your street address (line1):", { reply_markup: { force_reply: true } });
            break;
        case "zipCode":
            await bot.sendMessage(chatId, "Enter your ZIP/postal code:", { reply_markup: { force_reply: true } });
            break;
        case "idNumber":
            await bot.sendMessage(chatId, "Enter your ID number:", { reply_markup: { force_reply: true } });
            break;
        case "confirm":
            await bot.sendMessage(chatId, buildCardProfileSummary(session.data), {
                reply_markup: { inline_keyboard: buildCardProfileConfirmKeyboard() },
                disable_web_page_preview: true,
            });
            break;
    }
}
function buildCardProfileConfirmKeyboard() {
    return [
        [
            { text: "✅ Save Profile", callback_data: "PROFILE_CONFIRM::yes" },
            { text: "❌ Cancel", callback_data: "PROFILE_CONFIRM::no" },
        ],
        [MENU_BUTTON],
    ];
}
function buildCardProfileSummary(data) {
    const lines = [
        "Please confirm your card profile details:",
        `First name: ${data.firstName || ""}`,
        `Last name: ${data.lastName || ""}`,
        `Date of birth: ${data.dateOfBirth || ""}`,
        `Phone: ${data.phoneNumber || ""}`,
        `Email: ${data.customerEmail || ""}`,
        `Address: ${data.line1 || ""}`,
        `ZIP: ${data.zipCode || ""}`,
        `Country: ${PROFILE_STATIC_COUNTRY}`,
        `State: ${PROFILE_STATIC_STATE}`,
        `City: ${PROFILE_STATIC_CITY}`,
        `ID type: ${PROFILE_STATIC_IDTYPE}`,
        `ID number: ${data.idNumber ? maskIdNumber(data.idNumber) : ""}`,
    ].filter(Boolean);
    return lines.join("\n");
}
async function persistCardProfile(userId, data) {
    const idNumberEncrypted = data.idNumber ? encryptKycIdNumber(data.idNumber) : undefined;
    const idNumberLast4 = data.idNumber ? data.idNumber.slice(-4) : undefined;
    const customerEmail = String(data.customerEmail || "").trim().toLowerCase();
    if ((0, persistence_1.isPrismaPersistenceEnabled)()) {
        await prisma_1.default.user.upsert({
            where: { userId },
            create: {
                userId,
                customerEmail,
                firstName: data.firstName,
                lastName: data.lastName,
                dateOfBirth: data.dateOfBirth,
                phoneNumber: data.phoneNumber,
                line1: data.line1,
                city: PROFILE_STATIC_CITY,
                state: PROFILE_STATIC_STATE,
                zipCode: data.zipCode,
                country: PROFILE_STATIC_COUNTRY,
                idType: PROFILE_STATIC_IDTYPE,
                idNumberEncrypted,
                idNumberLast4,
            },
            update: {
                customerEmail,
                firstName: data.firstName,
                lastName: data.lastName,
                dateOfBirth: data.dateOfBirth,
                phoneNumber: data.phoneNumber,
                line1: data.line1,
                city: PROFILE_STATIC_CITY,
                state: PROFILE_STATIC_STATE,
                zipCode: data.zipCode,
                country: PROFILE_STATIC_COUNTRY,
                idType: PROFILE_STATIC_IDTYPE,
                idNumberEncrypted,
                idNumberLast4,
            },
        });
        return;
    }
    await User_1.default.findOneAndUpdate({ userId }, {
        $set: {
            customerEmail,
            firstName: data.firstName,
            lastName: data.lastName,
            dateOfBirth: data.dateOfBirth,
            phoneNumber: data.phoneNumber,
            line1: data.line1,
            city: PROFILE_STATIC_CITY,
            state: PROFILE_STATIC_STATE,
            zipCode: data.zipCode,
            country: PROFILE_STATIC_COUNTRY,
            idType: PROFILE_STATIC_IDTYPE,
            idNumberEncrypted,
            idNumberLast4,
        },
    }, { upsert: true, new: true });
    await Customer_1.default.findOneAndUpdate({ userId }, {
        $set: {
            email: customerEmail,
            firstName: data.firstName,
            lastName: data.lastName,
            dateOfBirth: data.dateOfBirth,
            phoneNumber: data.phoneNumber,
            line1: data.line1,
            city: PROFILE_STATIC_CITY,
            state: PROFILE_STATIC_STATE,
            zipCode: data.zipCode,
            country: PROFILE_STATIC_COUNTRY,
            idType: PROFILE_STATIC_IDTYPE,
            idNumberEncrypted,
            idNumberLast4,
        },
    }, { upsert: true, new: true });
}
function extractCardIdFromPayload(payload) {
    if (!payload || typeof payload !== "object")
        return undefined;
    const priorityKeys = ["card_id", "cardId", "virtual_card_id", "virtualCardId", "id"];
    const seen = new Set();
    const candidates = [];
    const visit = (node) => {
        if (!node || typeof node !== "object" || seen.has(node))
            return;
        seen.add(node);
        for (const key of priorityKeys) {
            if (node[key] != null) {
                candidates.push(String(node[key]));
            }
        }
        for (const value of Object.values(node)) {
            if (Array.isArray(value)) {
                for (const item of value)
                    visit(item);
            }
            else if (value && typeof value === "object") {
                visit(value);
            }
        }
    };
    visit(payload);
    return candidates.find((c) => isLikelyCardId(c));
}
async function resolveCreatedCardId(params) {
    const maxAttempts = Math.max(1, Number(params.attempts || 3));
    const immediate = extractCardIdFromPayload(params.providerPayload);
    if (immediate)
        return immediate;
    for (let i = 0; i < maxAttempts; i += 1) {
        if (i > 0)
            await sleep(1200);
        if ((0, persistence_1.isPrismaPersistenceEnabled)()) {
            const card = await prisma_1.default.card.findFirst({
                where: {
                    OR: [
                        { userId: params.userId },
                        ...(params.customerEmail ? [{ customerEmail: params.customerEmail }] : []),
                    ],
                },
                orderBy: { updatedAt: "desc" },
            });
            if (card?.cardId && isLikelyCardId(card.cardId))
                return card.cardId;
        }
        else {
            const card = await Card_1.default.findOne({
                $or: [
                    { userId: params.userId },
                    ...(params.customerEmail ? [{ customerEmail: params.customerEmail }] : []),
                ],
            })
                .sort({ updatedAt: -1 })
                .lean();
            if (card?.cardId && isLikelyCardId(String(card.cardId)))
                return String(card.cardId);
        }
        if (params.customerEmail) {
            try {
                const lookup = await callStroWallet("getcardholder", "get", { customerEmail: params.customerEmail }, { silentOnStatus: [400, 403, 404] });
                const fromLookup = extractCardIdFromPayload(lookup);
                if (fromLookup)
                    return fromLookup;
            }
            catch {
                // Ignore transient lookup errors.
            }
        }
    }
    return undefined;
}
async function submitCardRequest(userId, user, customer, message, cardAmountUsd) {
    const nameOnCard = [user.firstName, user.lastName].filter(Boolean).join(" ") || message?.from?.first_name || "StroWallet User";
    const pricing = await (0, pricingService_1.loadPricingConfig)();
    const defaultAmountUsd = Math.max(1, Number(pricing.firstCardAmountUsd ?? 5));
    const parsedCardAmount = Number(cardAmountUsd);
    const safeCardAmount = Number.isFinite(parsedCardAmount) && parsedCardAmount >= 1
        ? parsedCardAmount
        : defaultAmountUsd;
    const amount = String(safeCardAmount);
    const customerEmail = user?.customerEmail || customer?.email;
    if (!customerEmail) {
        await bot.sendMessage(Number(userId), "❌ Missing email. Please update your card profile and try again.", {
            reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
        });
        return;
    }
    if ((0, persistence_1.isPrismaPersistenceEnabled)()) {
        try {
            const idNumber = decryptKycIdNumber(user?.idNumberEncrypted || customer?.idNumberEncrypted);
            const idType = mapIdTypeToNfc(user?.idType || PROFILE_STATIC_IDTYPE);
            const country = normalizeCountryCode(user?.country || PROFILE_STATIC_COUNTRY);
            if (!idNumber || !idType || !country) {
                throw new Error("Missing required profile fields for card creation. Please update your card profile.");
            }
            const payload = {
                name: nameOnCard,
                first_name: user?.firstName || nameOnCard.split(" ")[0] || "User",
                last_name: user?.lastName || nameOnCard.split(" ").slice(1).join(" ") || "",
                dob: user?.dateOfBirth,
                id_type: idType,
                id_number: idNumber,
                email: customerEmail,
                line1: user?.line1 || "",
                city: user?.city || PROFILE_STATIC_CITY,
                state: user?.state || PROFILE_STATIC_STATE,
                postal_code: user?.zipCode || "00000",
                country,
                amount_usd: amount,
                phone: user?.phoneNumber || "",
            };
            const resp = await callStroWallet("create-card", "post", payload);
            const data = resp?.data ?? resp;
            if (data?.success === false || data?.ok === false) {
                const providerMsg = data?.message || data?.error || "Card creation rejected";
                throw new Error(typeof providerMsg === "string" ? providerMsg : JSON.stringify(providerMsg));
            }
            const cardId = await resolveCreatedCardId({ userId, customerEmail, providerPayload: data, attempts: 3 });
            if (!cardId) {
                await prisma_1.default.cardRequest.create({
                    data: {
                        userId,
                        nameOnCard,
                        cardType: "nfc",
                        amount,
                        customerEmail,
                        mode: normalizeMode(getDefaultMode()) || null,
                        status: "pending",
                        responseData: data,
                    },
                });
                await bot.sendMessage(Number(userId), [
                    "✅ Payment Verified",
                    "Card request was accepted and is provisioning.",
                    "Please check My Cards again in a moment.",
                ].join("\n"), {
                    reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
                });
                return;
            }
            await prisma_1.default.cardRequest.create({
                data: {
                    userId,
                    nameOnCard,
                    cardType: "nfc",
                    amount,
                    customerEmail,
                    mode: normalizeMode(getDefaultMode()) || null,
                    status: "approved",
                    cardId,
                    cardNumber: data?.card_number || null,
                    cvc: data?.cvc || data?.cvv || null,
                    responseData: data,
                },
            });
            await prisma_1.default.card.upsert({
                where: { cardId },
                create: {
                    cardId,
                    userId,
                    customerEmail,
                    nameOnCard,
                    cardType: "nfc",
                    status: data?.status || data?.state || "active",
                    last4: data?.last4 || data?.card_last4 || (data?.card_number ? String(data.card_number).slice(-4) : null),
                    currency: data?.currency || data?.ccy || null,
                    balance: data?.balance != null ? String(data.balance) : (data?.available_balance != null ? String(data.available_balance) : null),
                    availableBalance: data?.available_balance != null ? String(data.available_balance) : null,
                },
                update: {
                    userId,
                    customerEmail,
                    nameOnCard,
                    cardType: "nfc",
                    status: data?.status || data?.state || "active",
                    last4: data?.last4 || data?.card_last4 || (data?.card_number ? String(data.card_number).slice(-4) : null),
                    currency: data?.currency || data?.ccy || null,
                    balance: data?.balance != null ? String(data.balance) : (data?.available_balance != null ? String(data.available_balance) : null),
                    availableBalance: data?.available_balance != null ? String(data.available_balance) : null,
                },
            });
            await bot.sendMessage(Number(userId), [
                "✅ Payment Verified",
                "Your virtual card has been created successfully.",
                `Card ID: ${cardId}`,
            ].join("\n"), {
                reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
            });
            return;
        }
        catch (e) {
            const rawMessageText = e?.response?.data?.error || e?.message || "Your card request could not be approved.";
            const messageText = typeof rawMessageText === "string" ? rawMessageText : JSON.stringify(rawMessageText);
            if (isLowBalanceErrorMessage(messageText)) {
                await notifyAdminLowBalanceIssue(messageText).catch(() => { });
                await bot.sendMessage(Number(userId), [
                    "✅ Payment received.",
                    "Your card request is being processed.",
                    "Provisioning may take a little longer than usual.",
                ].join("\n"), {
                    reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
                });
                return;
            }
            await bot.sendMessage(Number(userId), `❌ ${messageText}`, {
                reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
            });
            return;
        }
    }
    try {
        const resp = await axios_1.default.post(`${BACKEND_BASE}/api/card-requests`, {
            userId,
            nameOnCard,
            cardType: "nfc",
            amount,
            customerEmail,
        });
        if (resp?.data?.ok) {
            await bot.sendMessage(Number(userId), [
                "✅ Payment Verified",
                "Your virtual card has been created successfully.",
                resp?.data?.data?.cardId ? `Card ID: ${resp.data.data.cardId}` : undefined,
            ].filter(Boolean).join("\n"), {
                reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
            });
        }
        else {
            await bot.sendMessage(Number(userId), "❌ Your card request could not be approved.", {
                reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
            });
        }
    }
    catch (e) {
        const rawMessageText = e?.response?.data?.error || "Your card request could not be approved.";
        const messageText = typeof rawMessageText === "string" ? rawMessageText : JSON.stringify(rawMessageText);
        if (isLowBalanceErrorMessage(messageText)) {
            await notifyAdminLowBalanceIssue(messageText).catch(() => { });
            await bot.sendMessage(Number(userId), [
                "✅ Payment received.",
                "Your card request is being processed.",
                "Provisioning may take a little longer than usual.",
            ].join("\n"), {
                reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
            });
            return;
        }
        await bot.sendMessage(Number(userId), `❌ ${messageText}`, {
            reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
        });
    }
}
async function startCreateCardFlow(chatId, message) {
    const { user } = await getUserAndCustomerContext(String(chatId));
    const defaultName = [user?.firstName, user?.lastName].filter(Boolean).join(" ") || message?.from?.first_name || "StroWallet User";
    createCardSessions.set(chatId, { step: "name", data: { nameOnCard: defaultName } });
    await bot.sendMessage(chatId, "Enter name on card (or send an empty message to keep default):", {
        reply_markup: { force_reply: true },
    });
}
async function handleCreateCardMessage(msg, session) {
    const chatId = msg.chat.id;
    if (!msg.text) {
        await bot.sendMessage(chatId, "Please send a text response.", { reply_markup: { force_reply: true } });
        return;
    }
    const text = String(msg.text).trim();
    switch (session.step) {
        case "name":
            if (text)
                session.data.nameOnCard = text;
            session.step = "type";
            createCardSessions.set(chatId, session);
            await promptCreateCardStep(chatId, session);
            return;
        case "amount":
            if (!/^\d+(\.\d+)?$/.test(text) || Number(text) < 3) {
                await bot.sendMessage(chatId, "Enter a valid amount (minimum 3) or tap Skip.", { reply_markup: { force_reply: true } });
                return;
            }
            session.data.amount = text;
            session.step = "confirm";
            createCardSessions.set(chatId, session);
            await promptCreateCardStep(chatId, session);
            return;
        default:
            await bot.sendMessage(chatId, "Please use the buttons to continue.");
    }
}
async function promptCreateCardStep(chatId, session) {
    switch (session.step) {
        case "type":
            session.data.cardType = "nfc";
            session.step = "amount";
            createCardSessions.set(chatId, session);
            await promptCreateCardStep(chatId, session);
            break;
        case "amount":
            await bot.sendMessage(chatId, "Enter initial amount (minimum 3). You can skip to use 3:", {
                reply_markup: {
                    inline_keyboard: [[
                            { text: "Skip", callback_data: "CARD_AMOUNT::skip" },
                            { text: "5", callback_data: "CARD_AMOUNT::5" },
                            { text: "10", callback_data: "CARD_AMOUNT::10" },
                        ], [MENU_BUTTON]],
                },
            });
            break;
        case "confirm":
            await bot.sendMessage(chatId, buildCreateCardSummary(session.data), {
                reply_markup: {
                    inline_keyboard: [[
                            { text: "✅ Create Card", callback_data: "CARD_CONFIRM::yes" },
                            { text: "❌ Cancel", callback_data: "CARD_CONFIRM::no" },
                        ], [MENU_BUTTON]]
                },
            });
            break;
    }
}
function buildCreateCardSummary(data) {
    const lines = [
        "Please confirm card details:",
        `Name on card: ${data.nameOnCard || "-"}`,
        `Card type: ${data.cardType || "-"}`,
        `Amount: ${data.amount || "0"}`,
    ];
    return lines.join("\n");
}
async function submitCreateCard(chatId, session) {
    const userId = String(chatId);
    const { user } = await getUserAndCustomerContext(userId);
    const userRecord = user;
    const customerEmail = userRecord?.customerEmail;
    if (!customerEmail) {
        createCardSessions.delete(chatId);
        await bot.sendMessage(chatId, "❌ Missing email. Please update your card profile and try again.", {
            reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
        });
        return;
    }
    try {
        const idNumber = decryptKycIdNumber(userRecord?.idNumberEncrypted);
        const idType = mapIdTypeToNfc(userRecord?.idType || PROFILE_STATIC_IDTYPE);
        const country = normalizeCountryCode(userRecord?.country || PROFILE_STATIC_COUNTRY);
        if (!idNumber || !idType || !country) {
            throw new Error("Missing required profile fields for card creation. Please update your card profile.");
        }
        const payload = {
            name: session.data.nameOnCard || "Virtual Card",
            first_name: userRecord?.firstName || (session.data.nameOnCard || "User").split(" ")[0],
            last_name: userRecord?.lastName || (session.data.nameOnCard || "").split(" ").slice(1).join(" "),
            dob: userRecord?.dateOfBirth,
            id_type: idType,
            id_number: idNumber,
            email: customerEmail,
            line1: userRecord?.line1 || "",
            city: userRecord?.city || PROFILE_STATIC_CITY,
            state: userRecord?.state || PROFILE_STATIC_STATE,
            postal_code: userRecord?.zipCode || "00000",
            country,
            amount_usd: session.data.amount || "3",
            phone: userRecord?.phoneNumber || "",
        };
        const resp = await callStroWallet("create-card", "post", payload);
        const data = resp?.data ?? resp;
        if (data?.success === false || data?.ok === false) {
            const providerMsg = data?.message || data?.error || "Card creation rejected";
            throw new Error(typeof providerMsg === "string" ? providerMsg : JSON.stringify(providerMsg));
        }
        const cardId = await resolveCreatedCardId({ userId, customerEmail, providerPayload: data, attempts: 3 });
        if (cardId) {
            if (!isPrismaOnlyMode()) {
                await TelegramLink_1.TelegramLink.findOneAndUpdate({ chatId }, { $addToSet: { cardIds: cardId }, $set: { customerEmail } }, { upsert: true, new: true });
            }
            if ((0, persistence_1.isPrismaPersistenceEnabled)()) {
                await prisma_1.default.card.upsert({
                    where: { cardId },
                    create: {
                        cardId,
                        userId,
                        customerEmail,
                        nameOnCard: payload.name,
                        cardType: "nfc",
                        status: data?.status || data?.state || "active",
                        currency: data?.currency || data?.ccy || null,
                        balance: (data?.balance || data?.available_balance || null) != null ? String(data?.balance || data?.available_balance) : null,
                        availableBalance: data?.available_balance != null ? String(data?.available_balance) : null,
                        last4: data?.last4 || data?.card_last4 || null,
                    },
                    update: {
                        userId,
                        customerEmail,
                        nameOnCard: payload.name,
                        cardType: "nfc",
                        status: data?.status || data?.state || "active",
                        currency: data?.currency || data?.ccy || null,
                        balance: (data?.balance || data?.available_balance || null) != null ? String(data?.balance || data?.available_balance) : null,
                        availableBalance: data?.available_balance != null ? String(data?.available_balance) : null,
                        last4: data?.last4 || data?.card_last4 || null,
                    },
                });
            }
            else {
                await Card_1.default.findOneAndUpdate({ cardId }, {
                    $set: {
                        cardId,
                        userId,
                        customerEmail,
                        nameOnCard: payload.name,
                        cardType: "nfc",
                        status: data?.status || data?.state || "active",
                        currency: data?.currency || data?.ccy,
                        balance: data?.balance || data?.available_balance,
                        availableBalance: data?.available_balance,
                    },
                }, { upsert: true, new: true });
            }
        }
        createCardSessions.delete(chatId);
        await bot.sendMessage(chatId, cardId
            ? `✅ Your StroWallet card has been created!\nCard ID: ${cardId}`
            : "✅ Card request accepted by provider. Card is provisioning and will appear shortly in My Cards.", { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
    }
    catch (err) {
        createCardSessions.delete(chatId);
        const rawMsg = err?.response?.data?.message || err?.response?.data?.error || err?.message || "Card creation failed";
        const msg = typeof rawMsg === "string" ? rawMsg : JSON.stringify(rawMsg);
        await bot.sendMessage(chatId, `❌ ${msg}\nPlease try again.`, {
            reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
        });
    }
}
function maskIdNumber(idNumber) {
    if (!idNumber)
        return "";
    const last4 = idNumber.slice(-4);
    return `${"*".repeat(Math.max(0, idNumber.length - 4))}${last4}`;
}
function getKycEncryptionKey() {
    const raw = process.env.KYC_ENCRYPTION_KEY;
    if (!raw)
        return null;
    try {
        const buf = raw.length === 64 ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
        if (buf.length !== 32)
            return null;
        return buf;
    }
    catch {
        return null;
    }
}
function encryptKycIdNumber(idNumber) {
    const key = getKycEncryptionKey();
    if (!key)
        return undefined;
    const iv = crypto_1.default.randomBytes(12);
    const cipher = crypto_1.default.createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(idNumber, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
}
function decryptKycIdNumber(encrypted) {
    if (!encrypted)
        return undefined;
    if (!encrypted.startsWith("v1:"))
        return undefined;
    const key = getKycEncryptionKey();
    if (!key)
        return undefined;
    const parts = encrypted.split(":");
    if (parts.length !== 4)
        return undefined;
    const iv = Buffer.from(parts[1], "base64");
    const tag = Buffer.from(parts[2], "base64");
    const ciphertext = Buffer.from(parts[3], "base64");
    const decipher = crypto_1.default.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString("utf8");
}
function normalizeCountryCode(value) {
    const raw = String(value || "").trim();
    if (!raw)
        return undefined;
    if (raw.length === 3)
        return raw.toUpperCase();
    const normalized = raw.toLowerCase();
    const map = {
        ghana: "GHA",
        nigeria: "NGA",
        ethiopia: "ETH",
        kenya: "KEN",
        uganda: "UGA",
        tanzania: "TZA",
        rwanda: "RWA",
        burundi: "BDI",
        sudan: "SDN",
        "south sudan": "SSD",
    };
    return map[normalized];
}
function mapIdTypeToNfc(value) {
    const v = String(value || "").toLowerCase();
    if (v === "nin" || v === "national_id" || v === "nationalid")
        return "national_id";
    if (v === "passport")
        return "passport";
    if (v === "driving_license" || v === "drivers_license" || v === "drivinglicense")
        return "drivers_license";
    return undefined;
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function formatMaskedCard(last4) {
    return `**** **** **** ${last4 || "----"}`;
}
function formatCardMoney(value, currency) {
    const amount = Number(value);
    if (!Number.isFinite(amount))
        return undefined;
    const normalized = (currency || "USD").toUpperCase();
    if (normalized === "USD" || normalized === "USDT")
        return `$${amount.toFixed(2)}`;
    return `${amount.toFixed(2)} ${normalized}`;
}
function extractExpiry(detail) {
    if (!detail)
        return undefined;
    const month = detail?.exp_month || detail?.expiry_month || detail?.expMonth || detail?.expiryMonth;
    const year = detail?.exp_year || detail?.expiry_year || detail?.expYear || detail?.expiryYear;
    if (month && year)
        return `${String(month).padStart(2, "0")}/${String(year).slice(-2)}`;
    const raw = detail?.expiry || detail?.expiry_date || detail?.exp || detail?.expDate;
    return raw ? String(raw) : undefined;
}
function isFrozenStatus(raw) {
    return String(raw || "").toLowerCase().includes("frozen");
}
function pickNestedField(obj, keys) {
    if (!obj || typeof obj !== "object")
        return undefined;
    for (const key of keys) {
        if (obj[key] != null)
            return String(obj[key]);
    }
    for (const val of Object.values(obj)) {
        if (val && typeof val === "object") {
            const nested = pickNestedField(val, keys);
            if (nested != null)
                return nested;
        }
    }
    return undefined;
}
function normalizeCardDetail(raw) {
    if (!raw || typeof raw !== "object")
        return null;
    const cardNumber = pickNestedField(raw, ["card_number", "cardNumber"]);
    const cvc = pickNestedField(raw, ["cvc", "cvv"]);
    const status = pickNestedField(raw, ["card_status", "status", "state"]);
    const balance = pickNestedField(raw, ["balance", "available_balance", "availableBalance"]);
    const currency = pickNestedField(raw, ["currency", "ccy"]);
    const last4Raw = pickNestedField(raw, ["last4", "card_last4", "cardLast4", "cardSuffix"]);
    const last4 = last4Raw || (cardNumber ? cardNumber.slice(-4) : undefined);
    const cardType = pickNestedField(raw, ["card_type", "cardType", "brand"]);
    const nameOnCard = pickNestedField(raw, ["name_on_card", "nameOnCard", "name"]);
    const expMonth = pickNestedField(raw, ["exp_month", "expiry_month", "expMonth", "expiryMonth"]);
    const expYear = pickNestedField(raw, ["exp_year", "expiry_year", "expYear", "expiryYear"]);
    const expiry = pickNestedField(raw, ["expiry", "expiry_date", "exp", "expDate"]);
    const billingRaw = pickNestedField(raw, ["billing", "billing_address", "billingAddress"]);
    const billingStreet = pickNestedField(raw, ["billing_street", "billingStreet"]);
    const billingCity = pickNestedField(raw, ["billing_city", "billingCity"]);
    const billingState = pickNestedField(raw, ["billing_state", "billingState"]);
    const billingZip = pickNestedField(raw, ["billing_zip_code", "billing_zip", "billingZip", "billingZipCode"]);
    const billingCountry = pickNestedField(raw, ["billing_country", "billingCountry"]);
    const line1 = pickNestedField(raw, ["line1", "addressLine1", "address_line1"]);
    const city = pickNestedField(raw, ["city", "town"]);
    const state = pickNestedField(raw, ["state", "province", "region"]);
    const zip = pickNestedField(raw, ["zip", "zipCode", "postal", "postalCode"]);
    const country = pickNestedField(raw, ["country"]);
    const addressRaw = pickNestedField(raw, ["address", "address_full", "addressFull"]);
    const billingParts = [billingStreet || line1, billingCity || city].filter(Boolean).join(", ");
    const addressParts = [billingState || state, billingZip || zip, billingCountry || country].filter(Boolean).join(", ");
    const billing = billingRaw || (billingParts ? billingParts : undefined);
    const address = addressRaw || (addressParts ? addressParts : undefined);
    return {
        card_number: cardNumber,
        cvc,
        status,
        balance,
        available_balance: pickNestedField(raw, ["available_balance", "availableBalance"]),
        currency,
        last4,
        card_type: cardType,
        name_on_card: nameOnCard,
        exp_month: expMonth,
        exp_year: expYear,
        expiry,
        billing,
        address,
    };
}
async function sendUserInfo(chatId, message) {
    if (shouldSuppressOutgoing(chatId, "user_info"))
        return;
    const [link, profile, primaryCard] = await Promise.all([
        isPrismaOnlyMode() ? Promise.resolve(null) : TelegramLink_1.TelegramLink.findOne({ chatId }).lean(),
        getUserAndCustomerContext(String(chatId)),
        getPrimaryCardForUser(String(chatId)),
    ]);
    const { user, customer } = profile;
    const baseBalance = user?.balance ?? 0;
    const currency = user?.currency || "USDT";
    const email = user?.customerEmail || link?.customerEmail;
    const cardId = primaryCard?.cardId;
    const remoteDetail = cardId ? await fetchCardDetailSafe(cardId) : null;
    const walletBalance = Number(baseBalance);
    const cardBalance = Number(remoteDetail?.balance ?? remoteDetail?.available_balance ?? NaN);
    const last4 = remoteDetail?.last4 || primaryCard?.last4 || primaryCard?.cardNumber?.slice(-4);
    const cardStatusRaw = remoteDetail?.status || primaryCard?.status;
    const cardStatus = cardStatusRaw ? String(cardStatusRaw) : undefined;
    const cardStatusLabel = cardStatus ? cardStatus.charAt(0).toUpperCase() + cardStatus.slice(1) : undefined;
    const username = user?.username ? `@${String(user.username)}` : undefined;
    const nameSource = user?.firstName || user?.lastName
        ? `${user?.firstName || ""} ${user?.lastName || ""}`.trim()
        : (user?.username ? String(user.username) : "User");
    const hasProfile = getCardProfileMissingFields(user, customer).length === 0;
    const hasCard = Boolean(primaryCard);
    const lines = [
        "🧑‍💻 Here's Your Profile:",
        `👤 Name: ${nameSource}${username ? ` (${username})` : ""}`,
        `👤 User ID: ${chatId}`,
        `✉️ Email: ${email || "/linkemail"}`,
        `Card profile: ${hasProfile ? "Ready ✅" : "Incomplete"}`,
        `Wallet: ${Number.isFinite(walletBalance) ? walletBalance.toFixed(2) : "0.00"} ${currency}`,
        hasCard && Number.isFinite(cardBalance)
            ? `Card Balance: ${cardBalance.toFixed(2)} ${(remoteDetail?.currency || primaryCard?.currency || "USD").toUpperCase()}`
            : undefined,
        `Cards: ${hasCard ? "1" : "0"}`,
        "💳 Virtual Card",
        `• Status: ${hasCard ? (cardStatusLabel || "Active") : "No Card"}`,
        `• Last 4 digits: ${hasCard ? (last4 || "****") : "****"}`,
    ].filter(Boolean);
    await editOrSend(chatId, message, lines.join("\n"), {
        inline_keyboard: [
            [
                { text: "💼 Wallet", callback_data: "MENU_WALLET" },
                { text: "💳 My Cards", callback_data: "MENU_MY_CARDS" },
            ],
            [MENU_BUTTON],
        ],
    });
}
function chunk(items, size) {
    const rows = [];
    for (let i = 0; i < items.length; i += size) {
        rows.push(items.slice(i, i + size));
    }
    return rows;
}
async function sendWalletSummary(chatId, message) {
    if (shouldSuppressOutgoing(chatId, "wallet_summary"))
        return;
    const [link, user, primaryCard] = await Promise.all([
        isPrismaOnlyMode() ? Promise.resolve(null) : TelegramLink_1.TelegramLink.findOne({ chatId }).lean(),
        (0, persistence_1.isPrismaPersistenceEnabled)() ? prisma_1.default.user.findUnique({ where: { userId: String(chatId) } }) : User_1.default.findOne({ userId: String(chatId) }).lean(),
        getPrimaryCardForUser(String(chatId)),
    ]);
    const baseWalletBalance = user?.balance ?? 0;
    const currency = user?.currency || "USDT";
    const cardId = primaryCard?.cardId || link?.cardIds?.[0];
    const remoteDetail = cardId ? await fetchCardDetailSafe(cardId) : null;
    const walletBalance = Number(baseWalletBalance);
    const cardBalance = Number(remoteDetail?.balance ?? remoteDetail?.available_balance ?? NaN);
    const cardCurrency = (remoteDetail?.currency || primaryCard?.currency || "USD").toUpperCase();
    const last4 = remoteDetail?.last4 || primaryCard?.last4 || primaryCard?.cardNumber?.slice(-4);
    const lines = [
        "💼 Your Wallet",
        `Balance: ${(Number.isFinite(walletBalance) ? walletBalance : 0).toFixed(2)} ${currency}`,
        Number.isFinite(cardBalance) ? `Card Balance: ${cardBalance.toFixed(2)} ${cardCurrency}` : undefined,
        `Currency: ${currency}`,
        "Status: Active",
        "",
        cardId ? "Linked Card:" : "Linked Card: None",
        cardId ? `💳 Virtual Card (${last4 ? `**** ${last4}` : "linked"})` : undefined,
    ];
    await editOrSend(chatId, message, lines.join("\n"), {
        inline_keyboard: [
            [{ text: "🔍 My Cards", callback_data: "MENU_MY_CARDS" }],
            [{ text: "🪙 USDT Wallet", callback_data: "WALLET_USDT_ADDRESS" }],
            [
                { text: "📊 USDT Balance", callback_data: "WALLET_USDT_BALANCE" },
                { text: "🧾 USDT History", callback_data: "WALLET_USDT_HISTORY" },
            ],
            [{ text: "💸 Send USDT", callback_data: "WALLET_USDT_SEND" }],
            [
                { text: "📱 Buy Airtime", callback_data: "WALLET_AIRTIME" },
                { text: "📶 Data Plans", callback_data: "WALLET_DATA_PLANS" },
            ],
            [MENU_BUTTON],
        ],
    });
}
async function sendVirtualAccount(chatId, message, options) {
    if (!bot)
        return;
    if (options?.forceCreate && shouldSuppressOutgoing(chatId, "virtual_account_create", 3000))
        return;
    try {
        const payload = { userId: String(chatId), ...(options?.forceCreate ? { forceCreate: true } : {}) };
        const resp = await callStroWallet("virtual-bank/account", "post", payload);
        const data = resp?.data ?? resp;
        const account = data?.account ?? data;
        if (data?.pending) {
            await editOrSend(chatId, message, "Virtual account creation is already in progress. Please wait a moment and try again.", {
                inline_keyboard: [[MENU_BUTTON]],
            });
            return;
        }
        if (!account || !account.accountNumber) {
            await editOrSend(chatId, message, "No virtual account found yet. Tap below to create one.", {
                inline_keyboard: [
                    [{ text: "➕ Create Virtual Account", callback_data: "WALLET_CREATE_VIRTUAL_ACCOUNT" }],
                    [MENU_BUTTON],
                ],
            });
            return;
        }
        const lines = [
            "🏦 Virtual Account",
            `Account Number: ${account.accountNumber}`,
            account.accountName ? `Account Name: ${account.accountName}` : undefined,
            account.bankName ? `Bank: ${account.bankName}` : undefined,
            account.currency ? `Currency: ${String(account.currency).toUpperCase()}` : undefined,
            "Send money to this account to fund your wallet.",
        ].filter(Boolean);
        await editOrSend(chatId, message, lines.join("\n"), { inline_keyboard: [[MENU_BUTTON]] });
    }
    catch (err) {
        await bot.sendMessage(chatId, `❌ Failed to load virtual account: ${err?.message || "Unexpected error"}`, {
            reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
        });
    }
}
async function sendUsdtAddress(chatId, message, options) {
    if (!bot)
        return;
    if (options?.forceCreate && shouldSuppressOutgoing(chatId, "usdt_address_create", 3000))
        return;
    try {
        const payload = { userId: String(chatId), ...(options?.forceCreate ? { forceCreate: true } : {}) };
        const existingResp = await callStroWallet("usdt/address", "get", { userId: String(chatId) });
        const existingData = existingResp?.data ?? existingResp;
        const existingRecord = existingData?.address ?? existingData;
        const existingAddress = existingRecord?.address ? String(existingRecord.address) : null;
        if (existingAddress) {
            await editOrSend(chatId, message, buildUsdtAddressMessage(existingAddress, Boolean(options?.forceCreate)), {
                inline_keyboard: [
                    [
                        { text: "📊 USDT Balance", callback_data: "WALLET_USDT_BALANCE" },
                        { text: "🧾 USDT History", callback_data: "WALLET_USDT_HISTORY" },
                    ],
                    [{ text: "💸 Send USDT", callback_data: "WALLET_USDT_SEND" }],
                    [MENU_BUTTON],
                ],
            }, "HTML");
            return;
        }
        const resp = await callStroWallet("usdt/address", "post", payload);
        const data = resp?.data ?? resp;
        const created = Boolean(data?.created) || !existingAddress;
        const record = data?.address ?? data;
        const address = record?.address ? String(record.address) : existingAddress;
        if (data?.pending) {
            await editOrSend(chatId, message, "USDT address creation is already in progress. Please wait a moment and try again.", {
                inline_keyboard: [[MENU_BUTTON]],
            });
            return;
        }
        if (!address) {
            await editOrSend(chatId, message, "No USDT address found yet. Tap below to create one.", {
                inline_keyboard: [
                    [{ text: "➕ Create USDT Address", callback_data: "WALLET_CREATE_USDT_ADDRESS" }],
                    [
                        { text: "📊 USDT Balance", callback_data: "WALLET_USDT_BALANCE" },
                        { text: "🧾 USDT History", callback_data: "WALLET_USDT_HISTORY" },
                    ],
                    [{ text: "💸 Send USDT", callback_data: "WALLET_USDT_SEND" }],
                    [MENU_BUTTON],
                ],
            });
            return;
        }
        await editOrSend(chatId, message, buildUsdtAddressMessage(address, created), {
            inline_keyboard: [
                [
                    { text: "📊 USDT Balance", callback_data: "WALLET_USDT_BALANCE" },
                    { text: "🧾 USDT History", callback_data: "WALLET_USDT_HISTORY" },
                ],
                [{ text: "💸 Send USDT", callback_data: "WALLET_USDT_SEND" }],
                [MENU_BUTTON],
            ],
        }, "HTML");
    }
    catch (err) {
        const message = err?.response?.data?.error || err?.response?.data?.message || err?.message || "Unexpected error";
        if (String(message).toLowerCase().includes("email")) {
            await bot.sendMessage(chatId, "Please link your email first: /linkemail your@email.com", { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
            return;
        }
        await bot.sendMessage(chatId, `❌ Failed to load USDT address: ${message}`, { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
    }
}
async function resolveUsdtAddress(chatId) {
    try {
        const resp = await callStroWallet("usdt/address", "get", { userId: String(chatId) });
        const data = resp?.data ?? resp;
        const record = data?.address ?? data;
        const address = record?.address;
        return address ? String(address) : null;
    }
    catch {
        return null;
    }
}
function formatUsdtHistoryItem(item) {
    const amount = item?.amount || item?.centAmount || item?.value;
    const action = item?.action || item?.type || item?.event;
    const status = item?.status || item?.state;
    const time = item?.timestamp || item?.created_at || item?.createdAt || item?.date;
    const parts = [
        amount ? `Amount: ${amount}` : undefined,
        action ? `Action: ${action}` : undefined,
        status ? `Status: ${status}` : undefined,
        time ? `Time: ${time}` : undefined,
    ].filter(Boolean);
    return parts.length ? parts.join(" | ") : JSON.stringify(item);
}
async function sendUsdtBalance(chatId, message) {
    if (!bot)
        return;
    try {
        const resp = await callStroWallet("usdt/balance", "get", { userId: String(chatId) });
        const data = resp?.data ?? resp;
        const payload = data?.data ?? data;
        const balance = payload?.balance ?? payload?.available_balance ?? payload?.availableBalance;
        const currency = payload?.currency || "USDT";
        const lines = [
            "USDT Wallet Balance",
            balance != null ? `Balance: ${balance} ${currency}` : `Response: ${JSON.stringify(payload)}`,
        ];
        await editOrSend(chatId, message, lines.join("\n"), { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
    }
    catch (err) {
        await bot.sendMessage(chatId, `❌ Failed to load USDT balance: ${err?.message || "Unexpected error"}`, { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
    }
}
async function sendUsdtHistory(chatId, addressInput, message) {
    if (!bot)
        return;
    try {
        const address = addressInput?.trim() || (await resolveUsdtAddress(chatId));
        if (!address) {
            const key = chatKey(chatId);
            if (key)
                pendingActions.set(key, { type: "usdt_history" });
            await editOrSend(chatId, message, "No USDT address found. Send the address to view history or create one first.", {
                inline_keyboard: [
                    [{ text: "➕ Create USDT Address", callback_data: "WALLET_CREATE_USDT_ADDRESS" }],
                    [MENU_BUTTON],
                ],
            });
            return;
        }
        const userHistoryResp = await callStroWallet("usdt/transactions", "get", { userId: String(chatId), limit: 5 });
        const userHistoryData = userHistoryResp?.data ?? userHistoryResp;
        const userItems = Array.isArray(userHistoryData?.items) ? userHistoryData.items : [];
        let lines = ["USDT History", `Address: ${address}`];
        if (userItems.length) {
            lines = lines.concat([
                "Recent wallet deposits:",
                ...userItems.map((item) => {
                    const amount = Number(item?.amountUsdt ?? item?.amount ?? 0);
                    const status = item?.status || "completed";
                    const ref = item?.referenceNumber || item?.transactionNumber || item?.responseData?.hash || item?.responseData?.id || "-";
                    const date = item?.createdAt || item?.updatedAt || item?.responseData?.timestamp || item?.responseData?.createdAt || "";
                    const balanceSnapshot = item?.metadata?.balanceAfter || item?.metadata?.walletBalance || undefined;
                    const details = [
                        `+ ${amount.toFixed(2)} USDT`,
                        `Status: ${status}`,
                        ref ? `Ref: ${ref}` : undefined,
                        date ? `Time: ${date}` : undefined,
                        balanceSnapshot != null ? `Balance after: ${balanceSnapshot} USDT` : undefined,
                    ].filter(Boolean).join(" | ");
                    return details;
                }),
            ]);
        }
        else {
            const resp = await callStroWallet("usdt/history", "get", { address });
            const data = resp?.data ?? resp;
            const payload = data?.data ?? data;
            let items = [];
            if (Array.isArray(payload))
                items = payload;
            else if (Array.isArray(payload?.data))
                items = payload.data;
            else if (Array.isArray(payload?.history))
                items = payload.history;
            lines = lines.concat([
                items.length ? "Latest transactions:" : "No history found yet.",
                ...items.slice(0, 5).map(formatUsdtHistoryItem),
            ]);
        }
        await editOrSend(chatId, message, lines.filter(Boolean).join("\n"), { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
    }
    catch (err) {
        await bot.sendMessage(chatId, `❌ Failed to load USDT history: ${err?.message || "Unexpected error"}`, { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
    }
}
async function sendUsdtSendPrompt(chatId, message) {
    if (!bot)
        return;
    if (!process.env.STROWALLET_VIP_KEY) {
        await editOrSend(chatId, message, "Send USDT is available on VIP plan only. Receiving USDT still works.", {
            inline_keyboard: [[MENU_BUTTON]],
        });
        return;
    }
    const key = chatKey(chatId);
    if (key)
        pendingActions.set(key, { type: "usdt_send" });
    await editOrSend(chatId, message, "Send USDT in this format: address amount", {
        inline_keyboard: [[MENU_BUTTON]],
    });
}
async function handleUsdtSendRequest(chatId, text) {
    if (!bot)
        return;
    if (!process.env.STROWALLET_VIP_KEY) {
        await bot.sendMessage(chatId, "Send USDT is available on VIP plan only. Receiving USDT still works.", {
            reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
        });
        return;
    }
    const parts = String(text || "").trim().split(/\s+/);
    if (parts.length < 2) {
        await bot.sendMessage(chatId, "Usage: /sendusdt address amount", { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
        return;
    }
    const [address, amount] = parts;
    if (!address || !amount) {
        await bot.sendMessage(chatId, "Usage: /sendusdt address amount", { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
        return;
    }
    try {
        const resp = await callStroWallet("usdt/send", "post", { address, amount });
        const data = resp?.data ?? resp;
        await bot.sendMessage(chatId, `✅ USDT send initiated.\n${JSON.stringify(data)}`, { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
    }
    catch (err) {
        await bot.sendMessage(chatId, `❌ Failed to send USDT: ${err?.message || "Unexpected error"}`, { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
    }
}
async function sendAirtimePrompt(chatId, message) {
    if (!bot)
        return;
    const key = chatKey(chatId);
    if (key)
        pendingActions.set(key, { type: "airtime" });
    await editOrSend(chatId, message, "Send airtime in this format: provider phone amount\nExample: mtn 08031234567 500", { inline_keyboard: [[MENU_BUTTON]] });
}
async function handleAirtimeRequest(chatId, text) {
    if (!bot)
        return;
    const parts = String(text || "").trim().split(/\s+/);
    if (parts.length < 3) {
        await bot.sendMessage(chatId, "Invalid format. Use: provider phone amount", { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
        return;
    }
    const [provider, phoneRaw, amountRaw] = parts;
    const phone = phoneRaw.replace(/[^\d]/g, "");
    const amount = amountRaw.replace(/[^\d.]/g, "");
    if (!provider || !phone || !amount) {
        await bot.sendMessage(chatId, "Invalid format. Use: provider phone amount", { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
        return;
    }
    try {
        const resp = await callStroWallet("bills/airtime", "post", {
            service_name: provider.toLowerCase(),
            phone,
            amount,
        });
        const data = resp?.data ?? resp;
        await bot.sendMessage(chatId, `✅ Airtime request sent.\n${JSON.stringify(data)}`, {
            reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
        });
    }
    catch (err) {
        await bot.sendMessage(chatId, `❌ Airtime failed: ${err?.message || "Unexpected error"}`, {
            reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
        });
    }
}
async function sendDataPlans(chatId, serviceId, message) {
    if (!bot)
        return;
    try {
        const resp = await callStroWallet("bills/data/plans", "get", { service_name: serviceId });
        const data = resp?.data ?? resp;
        const plans = data?.data?.varations || data?.data?.variations || [];
        if (!Array.isArray(plans) || plans.length === 0) {
            await editOrSend(chatId, message, "No data plans found for that service.", { inline_keyboard: [[MENU_BUTTON]] });
            return;
        }
        const lines = [
            `📶 Data Plans (${serviceId})`,
            ...plans.slice(0, 10).map((p) => `${p.variation_code}: ${p.name} - ${p.variation_amount}`),
            "",
            "Buy: /buydata service_id variation_code phone amount",
        ];
        await editOrSend(chatId, message, lines.join("\n"), { inline_keyboard: [[MENU_BUTTON]] });
    }
    catch (err) {
        await bot.sendMessage(chatId, `❌ Failed to load data plans: ${err?.message || "Unexpected error"}`, {
            reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
        });
    }
}
async function handleBuyDataRequest(chatId, text) {
    if (!bot)
        return;
    const parts = String(text || "").trim().split(/\s+/);
    if (parts.length < 4) {
        await bot.sendMessage(chatId, "Usage: /buydata service_id variation_code phone amount", { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
        return;
    }
    const [serviceId, variationCode, phoneRaw, amountRaw] = parts;
    const phone = phoneRaw.replace(/[^\d]/g, "");
    const amount = amountRaw.replace(/[^\d.]/g, "");
    if (!serviceId || !variationCode || !phone || !amount) {
        await bot.sendMessage(chatId, "Invalid format. Use: /buydata service_id variation_code phone amount", { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
        return;
    }
    try {
        const resp = await callStroWallet("bills/data", "post", {
            service_name: serviceId,
            service_id: serviceId,
            variation_code: variationCode,
            phone,
            amount,
        });
        const data = resp?.data ?? resp;
        await bot.sendMessage(chatId, `✅ Data request sent.\n${JSON.stringify(data)}`, {
            reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
        });
    }
    catch (err) {
        await bot.sendMessage(chatId, `❌ Data purchase failed: ${err?.message || "Unexpected error"}`, {
            reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
        });
    }
}
async function sendMyCards(chatId, message) {
    if (!shouldSuppressOutgoing(chatId, "my_cards_loading", 1500)) {
        await editOrSend(chatId, message, "Loading your card...", {
            inline_keyboard: [[MENU_BUTTON]],
        });
    }
    const userId = String(chatId);
    if (isPrismaOnlyMode()) {
        const user = await prisma_1.default.user.findUnique({ where: { userId } });
        let card = await getPrimaryCardForUser(userId);
        if (!card) {
            const recoveredCardId = await resolveCreatedCardId({
                userId,
                customerEmail: user?.customerEmail || undefined,
                attempts: 1,
            });
            if (recoveredCardId) {
                card = await prisma_1.default.card.upsert({
                    where: { cardId: recoveredCardId },
                    create: {
                        cardId: recoveredCardId,
                        userId,
                        customerEmail: user?.customerEmail || null,
                        status: "active",
                    },
                    update: {
                        userId,
                        customerEmail: user?.customerEmail || null,
                        status: "active",
                    },
                });
            }
        }
        if (!card) {
            await editOrSend(chatId, message, [
                "💳 Your Virtual Card",
                "Status: ✅ None",
            ].join("\n"), {
                inline_keyboard: [[MENU_BUTTON]],
            });
            return;
        }
        const remoteDetail = await fetchCardDetailSafe(String(card.cardId));
        const mergedDetail = remoteDetail || null;
        const last4 = mergedDetail?.last4 || card.last4 || card?.cardNumber?.slice(-4);
        const cardType = String(mergedDetail?.card_type || card.cardType || "virtual").toLowerCase();
        const cvc = (mergedDetail?.cvc || card?.cvc || "").toString();
        const cardName = String(mergedDetail?.name_on_card || card?.nameOnCard || "").trim();
        const fullCardNumberRaw = String(mergedDetail?.card_number || card?.cardNumber || "").replace(/\s+/g, "").trim();
        const fullCardNumber = fullCardNumberRaw.length >= 12
            ? fullCardNumberRaw.replace(/(.{4})/g, "$1 ").trim()
            : undefined;
        const statusText = isFrozenStatus(card.status || undefined) ? "❄️ Frozen" : "✅ Active";
        const balanceLabel = formatCardMoney(mergedDetail?.balance ?? mergedDetail?.available_balance ?? card.balance, mergedDetail?.currency || card.currency || "USD");
        const expiry = extractExpiry(mergedDetail);
        const billing = mergedDetail?.billing;
        const address = mergedDetail?.address;
        const lines = [
            "💳 Your Virtual Card",
            `Card Type: ${cardType}`,
            `Status: ${statusText}`,
            cardName ? `Name: ${cardName}` : undefined,
            `Card Number: ${fullCardNumber || formatMaskedCard(last4)}`,
            `CVV: ${cvc || "None"}`,
            `Billing: ${billing || "None"}`,
            `Address: ${address || "None"}`,
            expiry ? `Valid Thru: ${expiry}` : undefined,
            balanceLabel ? `Balance: ${balanceLabel}` : undefined,
        ].filter(Boolean);
        const freezeAction = isFrozenStatus(card.status || undefined) ? "CARD_UNFREEZE" : "CARD_FREEZE";
        const freezeLabel = isFrozenStatus(card.status || undefined) ? "🔥 Unfreeze Card" : "❄️ Freeze Card";
        await editOrSend(chatId, message, lines.join("\n"), {
            inline_keyboard: [
                [
                    { text: "🔍 Transactions", callback_data: `CARD_TXN::${card.cardId}` },
                    { text: freezeLabel, callback_data: `${freezeAction}::${card.cardId}` },
                ],
                [MENU_BUTTON],
            ],
        });
        return;
    }
    const [user, customer, link, cardIds] = await Promise.all([
        User_1.default.findOne({ userId }).lean(),
        Customer_1.default.findOne({ userId }).lean(),
        TelegramLink_1.TelegramLink.findOne({ chatId }).lean(),
        getUserCardIds(chatId),
    ]);
    const customerEmail = customer?.email || user?.customerEmail || link?.customerEmail;
    const [latestRequest, primaryCard] = await Promise.all([
        CardRequest_1.default.findOne({ $or: [{ userId }, { customerEmail }] }).sort({ updatedAt: -1 }).lean(),
        Card_1.default.findOne({ $or: [{ userId }, { customerEmail }] }).sort({ updatedAt: -1 }).lean(),
    ]);
    const linkedCardId = cardIds[0];
    const linkedCard = linkedCardId ? await Card_1.default.findOne({ cardId: linkedCardId }).lean() : null;
    const resolvedCard = linkedCard || primaryCard;
    const resolvedCardId = resolvedCard?.cardId || latestRequest?.cardId || linkedCardId;
    const noCardLines = [
        "💳 Your Virtual Card",
        "Card Type: virtual",
        "Status: ✅ None",
        "Card Number: /card_request",
        "CVV: None",
        "Expiry Date: None",
        "Balance: __",
        "Billing: None",
        "Address: None",
    ];
    const noCardKeyboard = [
        [
            { text: "🔍 Transactions", callback_data: "CARD_TXN_NO_CARD" },
            { text: "❄️ Freeze Card", callback_data: "CARD_FREEZE_NO_CARD" },
        ],
        [MENU_BUTTON],
    ];
    const card = resolvedCard || (latestRequest?.cardId ? await Card_1.default.findOne({ cardId: latestRequest.cardId }).lean() : null);
    const cardId = card?.cardId || latestRequest?.cardId || linkedCardId;
    if (!card && !cardId) {
        await editOrSend(chatId, message, noCardLines.join("\n"), {
            inline_keyboard: noCardKeyboard,
        });
        return;
    }
    const activeCard = card || {
        cardId: cardId,
        status: latestRequest?.status === "approved" ? "active" : latestRequest?.status,
        cardType: latestRequest?.cardType,
        last4: latestRequest?.cardNumber?.slice(-4),
        currency: user?.currency || "USD",
        balance: user?.balance,
    };
    const remoteDetail = await fetchCardDetailSafe(activeCard.cardId);
    const mergedDetail = remoteDetail || null;
    const last4 = mergedDetail?.last4 || activeCard.last4 || latestRequest?.cardNumber?.slice(-4);
    const cardType = String(mergedDetail?.card_type || activeCard.cardType || latestRequest?.cardType || "virtual").toLowerCase();
    const cvc = (mergedDetail?.cvc || latestRequest?.cvc || "").toString();
    const cardName = String(mergedDetail?.name_on_card || activeCard?.nameOnCard || latestRequest?.nameOnCard || "").trim();
    const fullCardNumberRaw = String(mergedDetail?.card_number || latestRequest?.cardNumber || "").replace(/\s+/g, "").trim();
    const fullCardNumber = fullCardNumberRaw.length >= 12
        ? fullCardNumberRaw.replace(/(.{4})/g, "$1 ").trim()
        : undefined;
    const statusText = isFrozenStatus(activeCard.status) ? "❄️ Frozen" : "✅ Active";
    const balanceLabel = formatCardMoney(mergedDetail?.balance ?? mergedDetail?.available_balance ?? activeCard.balance ?? user?.balance, mergedDetail?.currency || activeCard.currency || user?.currency || "USD");
    const expiry = extractExpiry(mergedDetail) || extractExpiry(latestRequest?.responseData || latestRequest?.metadata || {});
    const billing = mergedDetail?.billing || latestRequest?.metadata?.billing;
    const address = mergedDetail?.address || latestRequest?.metadata?.address;
    const lines = [
        "💳 Your Virtual Card",
        `Card Type: ${cardType}`,
        `Status: ${statusText}`,
        cardName ? `Name: ${cardName}` : undefined,
        `Card Number: ${fullCardNumber || formatMaskedCard(last4)}`,
        `CVV: ${cvc || "None"}`,
        `Billing: ${billing || "None"}`,
        `Address: ${address || "None"}`,
        expiry ? `Valid Thru: ${expiry}` : undefined,
        balanceLabel ? `Balance: ${balanceLabel}` : undefined,
    ].filter(Boolean);
    const freezeAction = isFrozenStatus(activeCard.status) ? "CARD_UNFREEZE" : "CARD_FREEZE";
    const freezeLabel = isFrozenStatus(activeCard.status) ? "🔥 Unfreeze Card" : "❄️ Freeze Card";
    await editOrSend(chatId, message, lines.join("\n"), {
        inline_keyboard: [
            [
                { text: "🔍 Transactions", callback_data: `CARD_TXN::${activeCard.cardId}` },
                { text: freezeLabel, callback_data: `${freezeAction}::${activeCard.cardId}` },
            ],
            [MENU_BUTTON],
        ],
    });
}
function isLikelyCardId(value) {
    if (!value)
        return false;
    if (value.startsWith("/"))
        return false;
    if (value.length < 6)
        return false;
    return /^[A-Za-z0-9_-]+$/.test(value) || /^[A-Za-z0-9-]{6,}$/.test(value);
}
async function getUserCardIds(chatId) {
    const userId = String(chatId);
    let cards;
    if ((0, persistence_1.isPrismaPersistenceEnabled)()) {
        const user = await prisma_1.default.user.findUnique({ where: { userId } });
        const customerEmail = user?.customerEmail || undefined;
        cards = await prisma_1.default.card.findMany({
            where: {
                OR: [{ userId }, ...(customerEmail ? [{ customerEmail }] : [])],
            },
            orderBy: { updatedAt: "desc" },
        });
    }
    else {
        cards = await Card_1.default.find({ userId }).lean();
    }
    const cardIdsFromCards = cards.map((c) => c.cardId).filter(isLikelyCardId);
    if (cardIdsFromCards.length)
        return Array.from(new Set(cardIdsFromCards));
    const requests = isPrismaOnlyMode()
        ? []
        : await CardRequest_1.default.find({ userId, status: "approved", cardId: { $exists: true, $ne: "" } }).lean();
    const requestIds = requests.map((r) => String(r.cardId)).filter(isLikelyCardId);
    if (requestIds.length)
        return Array.from(new Set(requestIds));
    const legacyLink = isPrismaOnlyMode() ? null : await TelegramLink_1.TelegramLink.findOne({ chatId }).lean();
    const legacyIds = (legacyLink?.cardIds || []).filter(isLikelyCardId);
    if (!isPrismaOnlyMode() && legacyLink && legacyIds.length !== (legacyLink.cardIds || []).length) {
        await TelegramLink_1.TelegramLink.updateOne({ chatId }, { $set: { cardIds: legacyIds } });
    }
    return Array.from(new Set(legacyIds));
}
async function getPrimaryCardForUser(userId) {
    if ((0, persistence_1.isPrismaPersistenceEnabled)()) {
        const user = await prisma_1.default.user.findUnique({ where: { userId } });
        const customerEmail = user?.customerEmail || undefined;
        const card = await prisma_1.default.card.findFirst({
            where: {
                OR: [{ userId }, ...(customerEmail ? [{ customerEmail }] : [])],
            },
            orderBy: { updatedAt: "desc" },
        });
        if (card)
            return card;
        const request = await prisma_1.default.cardRequest.findFirst({
            where: {
                status: "approved",
                cardId: { not: null },
                OR: [{ userId }, ...(customerEmail ? [{ customerEmail }] : [])],
            },
            orderBy: { updatedAt: "desc" },
        });
        if (!request?.cardId)
            return null;
        return {
            cardId: String(request.cardId),
            cardType: request.cardType,
            status: "active",
            last4: request.cardNumber ? request.cardNumber.slice(-4) : undefined,
            balance: undefined,
            currency: undefined,
        };
    }
    const card = await Card_1.default.findOne({ userId })
        .sort({ updatedAt: -1 })
        .lean();
    if (card)
        return card;
    const request = await CardRequest_1.default.findOne({ userId, status: "approved", cardId: { $exists: true, $ne: "" } })
        .sort({ updatedAt: -1 })
        .lean();
    if (!request)
        return null;
    return {
        cardId: String(request.cardId),
        cardType: request.cardType,
        status: request?.responseData?.response?.card_status || "pending",
        last4: request.cardNumber ? request.cardNumber.slice(-4) : undefined,
        balance: undefined,
        currency: undefined,
    };
}
async function sendMyCardSummary(chatId) {
    const card = await getPrimaryCardForUser(String(chatId));
    if (!card) {
        await bot.sendMessage(chatId, "❌ No cards linked yet. Use /linkcard CARD_ID to link one.", { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
        return;
    }
    const status = card.status ? String(card.status) : "unknown";
    const balanceValue = card.balance != null ? String(card.balance) : "-";
    const currency = card.currency ? ` ${card.currency}` : "";
    const last4 = card.last4 ? `••••${card.last4}` : "(not available)";
    const cardType = card.cardType ? String(card.cardType) : "-";
    const lines = [
        "💳 Your Card",
        `Type: ${cardType}`,
        `Status: ${status}`,
        `Last 4 Digits: ${last4}`,
        `Balance: ${balanceValue}${currency}`,
    ];
    await bot.sendMessage(chatId, lines.join("\n"), { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
}
async function sendCardStatus(chatId) {
    const card = await getPrimaryCardForUser(String(chatId));
    if (!card) {
        await bot.sendMessage(chatId, "❌ No cards linked yet.", { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
        return;
    }
    const status = card.status ? String(card.status) : "unknown";
    await bot.sendMessage(chatId, `Status: ${status}`, { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
}
async function sendCardDetail(chatId, cardId) {
    try {
        const user = (0, persistence_1.isPrismaPersistenceEnabled)()
            ? await prisma_1.default.user.findUnique({ where: { userId: String(chatId) } })
            : await User_1.default.findOne({ userId: String(chatId) }).lean();
        const walletBalance = user?.balance ?? 0;
        const card = (0, persistence_1.isPrismaPersistenceEnabled)()
            ? await prisma_1.default.card.findUnique({ where: { cardId } })
            : await Card_1.default.findOne({ cardId }).lean();
        // If this card was generated locally, serve synthetic details and avoid upstream call
        const local = isPrismaOnlyMode() ? null : await CardRequest_1.default.findOne({ cardId, status: "approved" }).lean();
        if (local) {
            const detail = {
                card_id: cardId,
                name_on_card: local.nameOnCard || "Virtual Card",
                card_type: local.cardType || "virtual",
                status: card?.status || "active",
                balance: walletBalance,
                available_balance: local.amount || undefined,
                currency: card?.currency || "USD",
                last4: card?.last4,
                expiry: extractExpiry(local.responseData || local.metadata || {}),
            };
            const text = buildCardDetailMessage(detail, cardId);
            const freezeAction = isFrozenStatus(detail.status) ? "CARD_UNFREEZE" : "CARD_FREEZE";
            const freezeLabel = isFrozenStatus(detail.status) ? "🔥 Unfreeze" : "❄️ Freeze";
            await bot.sendMessage(chatId, text, {
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: "🔐 View Card Details", callback_data: `CARD_REVEAL::${cardId}` },
                            { text: "🔍 Transactions", callback_data: `CARD_TXN::${cardId}` },
                        ],
                        [{ text: freezeLabel, callback_data: `${freezeAction}::${cardId}` }],
                        [MENU_BUTTON],
                    ],
                },
            });
            return;
        }
        const remote = await fetchCardDetailSafe(cardId);
        const detail = {
            card_id: cardId,
            name_on_card: remote?.name_on_card || "Virtual Card",
            card_type: remote?.card_type || "virtual",
            status: remote?.status || card?.status || "active",
            balance: remote?.balance || remote?.available_balance || walletBalance,
            available_balance: remote?.available_balance,
            currency: remote?.currency || card?.currency || "USD",
            last4: remote?.last4 || card?.last4,
            expiry: extractExpiry(remote),
        };
        const text = buildCardDetailMessage(detail, cardId);
        const freezeAction = isFrozenStatus(detail.status) ? "CARD_UNFREEZE" : "CARD_FREEZE";
        const freezeLabel = isFrozenStatus(detail.status) ? "🔥 Unfreeze" : "❄️ Freeze";
        await bot.sendMessage(chatId, text, {
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: "🔐 View Card Details", callback_data: `CARD_REVEAL::${cardId}` },
                        { text: "🔍 Transactions", callback_data: `CARD_TXN::${cardId}` },
                    ],
                    [{ text: freezeLabel, callback_data: `${freezeAction}::${cardId}` }],
                    [MENU_BUTTON],
                ],
            },
        });
    }
    catch (err) {
        await sendFriendlyError(chatId, err?.requestId);
    }
}
async function sendCardRevealPrompt(chatId, cardId) {
    const lines = [
        "🔐 Confirm to view full card details.",
        "This helps prevent accidental exposure.",
    ];
    await bot.sendMessage(chatId, lines.join("\n"), {
        reply_markup: {
            inline_keyboard: [
                [{ text: "Show Details", callback_data: `CARD_REVEAL_CONFIRM::${cardId}` }],
                [{ text: "Cancel", callback_data: "MENU_MY_CARDS" }],
                [MENU_BUTTON],
            ],
        },
    });
}
async function sendCardSensitiveDetails(chatId, cardId) {
    if (!shouldSuppressOutgoing(chatId, `card_reveal:${cardId}`, 1500)) {
        await bot.sendMessage(chatId, "Loading card details...", {
            reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
        });
    }
    const { user, customer } = await getUserAndCustomerContext(String(chatId));
    const local = await CardRequest_1.default.findOne({ cardId, status: "approved" }).lean();
    const localExpiry = extractExpiry(local?.responseData || local?.metadata || {});
    const localBilling = local?.metadata?.billing;
    const localAddress = local?.metadata?.address;
    const remote = await fetchCardDetailSafe(cardId);
    const cardNumber = local?.cardNumber || remote?.card_number;
    const cvc = local?.cvc || remote?.cvc;
    const expiry = localExpiry || extractExpiry(remote);
    const billing = localBilling || remote?.billing;
    const address = localAddress || remote?.address;
    if (!cardNumber || !cvc) {
        await bot.sendMessage(chatId, "Full card details are not available. Please try again later or contact support.", {
            reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
        });
        return;
    }
    const lines = [
        "🔐 Card Details",
        `Card Number: ${cardNumber}`,
        `CVV: ${cvc}`,
        expiry ? `Expiry: ${expiry}` : undefined,
        billing ? `Billing: ${billing}` : undefined,
        address ? `Address: ${address}` : undefined,
    ].filter(Boolean);
    await bot.sendMessage(chatId, lines.join("\n"), {
        reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
    });
}
async function sendCardTransactions(chatId, cardId, pageRaw = 1, daysFilterRaw = 0) {
    try {
        const userId = String(chatId);
        const pageSize = 10;
        const requestedPage = Number.isFinite(pageRaw) ? Math.max(1, Math.floor(pageRaw)) : 1;
        const allowedFilters = new Set([0, 7, 30, 90]);
        const parsedDays = Number(daysFilterRaw);
        const daysFilter = Number.isFinite(parsedDays) && allowedFilters.has(parsedDays) ? parsedDays : 0;
        if (!shouldSuppressOutgoing(chatId, `user_txn_loading:${cardId || "all"}`, 1500)) {
            await bot.sendMessage(chatId, "Loading transactions...", {
                reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
            });
        }
        let txns = [];
        let totalCount = 0;
        let page = 1;
        if ((0, persistence_1.isPrismaPersistenceEnabled)()) {
            const since = daysFilter > 0 ? new Date(Date.now() - daysFilter * 24 * 60 * 60 * 1000) : null;
            const transactionTypes = ["card", "deposit", "withdrawal"];
            const rows = await prisma_1.default.transaction.findMany({
                where: {
                    userId,
                    transactionType: { in: [...transactionTypes] },
                    ...(since ? { createdAt: { gte: since } } : {}),
                },
                orderBy: { createdAt: "desc" },
                take: 500,
            });
            const filtered = cardId
                ? (() => {
                    const out = [];
                    for (const row of rows) {
                        const type = String(row.transactionType || "");
                        if (type === "deposit") {
                            out.push(row);
                            continue;
                        }
                        const metaCardId = String(row?.metadata?.cardId || "");
                        const respCardId = String(row?.responseData?.card_id || row?.responseData?.cardId || "");
                        if (metaCardId === cardId || respCardId === cardId)
                            out.push(row);
                    }
                    return out;
                })()
                : rows;
            totalCount = filtered.length;
            const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
            page = Math.min(requestedPage, totalPages);
            txns = filtered.slice((page - 1) * pageSize, page * pageSize);
        }
        else {
            const transactionTypes = ["card", "deposit", "withdrawal"];
            const query = { userId, transactionType: { $in: transactionTypes } };
            if (cardId) {
                query.$or = [
                    { transactionType: "deposit" },
                    { "metadata.cardId": cardId },
                    { "responseData.card_id": cardId },
                    { "responseData.cardId": cardId },
                ];
            }
            if (daysFilter > 0) {
                const since = new Date(Date.now() - daysFilter * 24 * 60 * 60 * 1000);
                query.createdAt = { $gte: since };
            }
            totalCount = await Transaction_1.default.countDocuments(query);
            const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
            page = Math.min(requestedPage, totalPages);
            txns = await Transaction_1.default.find(query)
                .sort({ createdAt: -1 })
                .skip((page - 1) * pageSize)
                .limit(pageSize)
                .lean();
        }
        const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
        if (!txns.length) {
            await bot.sendMessage(chatId, "No transactions found yet.", { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
            return;
        }
        const lines = [
            "📊 Transaction History",
            `Showing ${txns.length} of ${totalCount} (Page ${page}/${totalPages})`,
            `Range: ${daysFilter > 0 ? `Last ${daysFilter} days` : "All time"}`,
            "",
        ];
        const keyboard = [];
        for (const t of txns) {
            const meta = t.metadata || {};
            const type = String(t.transactionType || "transaction");
            const direction = meta.direction === "debit" || type === "withdrawal" ? "-" : "+";
            const amountValue = Number((t.amountUsdt ?? t.amount) || 0);
            const currency = t.currency || "USDT";
            const statusIcon = formatTxnStatusIcon(t.status || meta.rawStatus);
            const rawLabel = meta.description || type.replace(/_/g, " ");
            const label = formatTxnLabel(meta.direction, rawLabel);
            const dateLabel = formatTxnDate(meta.date) || formatTxnDate(t.createdAt);
            const amountLabel = `${direction} ${amountValue.toFixed(2)} ${currency}`;
            lines.push(`${statusIcon} ${label} (${type})`);
            lines.push(amountLabel);
            if (dateLabel)
                lines.push(`${dateLabel}`);
            lines.push("");
            keyboard.push([
                {
                    text: `${label} ${amountLabel}`,
                    callback_data: `TXN_DETAIL::${String(t.id || t._id)}`,
                },
            ]);
        }
        const buildFilterCallback = (days) => {
            if (cardId)
                return `TXN_FILTER_CARD::${cardId}::${days}`;
            return `TXN_FILTER_ALL::${days}`;
        };
        keyboard.push([
            {
                text: `${daysFilter === 7 ? "✅ " : ""}7d`,
                callback_data: buildFilterCallback(7),
            },
            {
                text: `${daysFilter === 30 ? "✅ " : ""}30d`,
                callback_data: buildFilterCallback(30),
            },
            {
                text: `${daysFilter === 90 ? "✅ " : ""}90d`,
                callback_data: buildFilterCallback(90),
            },
            {
                text: `${daysFilter === 0 ? "✅ " : ""}All`,
                callback_data: buildFilterCallback(0),
            },
        ]);
        if (totalPages > 1) {
            const navRow = [];
            if (page > 1) {
                navRow.push(cardId
                    ? { text: "⬅️ Prev", callback_data: `TXN_PAGE_CARD::${cardId}::${page - 1}::${daysFilter}` }
                    : { text: "⬅️ Prev", callback_data: `TXN_PAGE_ALL::${page - 1}::${daysFilter}` });
            }
            if (page < totalPages) {
                navRow.push(cardId
                    ? { text: "Next ➡️", callback_data: `TXN_PAGE_CARD::${cardId}::${page + 1}::${daysFilter}` }
                    : { text: "Next ➡️", callback_data: `TXN_PAGE_ALL::${page + 1}::${daysFilter}` });
            }
            if (navRow.length)
                keyboard.push(navRow);
        }
        keyboard.push([MENU_BUTTON]);
        await bot.sendMessage(chatId, lines.join("\n"), { reply_markup: { inline_keyboard: keyboard } });
    }
    catch (err) {
        await sendFriendlyError(chatId, err?.requestId);
    }
}
async function sendCardTransactionDetail(chatId, txnId) {
    if (!shouldSuppressOutgoing(chatId, `txn_detail_loading:${txnId}`, 1500)) {
        await bot.sendMessage(chatId, "Loading transaction details...", {
            reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
        });
    }
    const txn = (0, persistence_1.isPrismaPersistenceEnabled)()
        ? await prisma_1.default.transaction.findUnique({ where: { id: txnId } })
        : await Transaction_1.default.findById(txnId).lean();
    if (!txn) {
        await bot.sendMessage(chatId, "Transaction not found.", { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
        return;
    }
    const meta = txn.metadata || {};
    const responseData = txn.responseData || {};
    const direction = meta.direction === "debit" ? "-" : "+";
    const amountValue = Number(txn.amount || 0);
    const currency = txn.currency || "USD";
    const status = txn.status || meta.rawStatus || "completed";
    const statusIcon = formatTxnStatusIcon(status);
    const rawDescription = meta.description || responseData.description || responseData.merchant || responseData.merchant_name || responseData.narrative;
    const label = formatTxnLabel(meta.direction, rawDescription);
    const dateLabel = formatTxnDate(meta.date) || formatTxnDate(txn.createdAt);
    let reason = undefined;
    if (status === "failed") {
        reason = meta.reason || meta.declineReason || meta.rawStatus;
    }
    let cardSuffix = "";
    if (meta.cardId) {
        const card = (0, persistence_1.isPrismaPersistenceEnabled)()
            ? await prisma_1.default.card.findUnique({ where: { cardId: String(meta.cardId) } })
            : await Card_1.default.findOne({ cardId: meta.cardId }).lean();
        if (card?.last4)
            cardSuffix = `**** ${card.last4}`;
    }
    const lines = [
        `${statusIcon} ${label}`,
        `Amount: ${direction} $${amountValue.toFixed(2)}`,
        rawDescription ? `Description: ${rawDescription}` : undefined,
        `Status: ${statusIcon} ${status.charAt(0).toUpperCase() + status.slice(1)}`,
        dateLabel ? `Date: ${dateLabel}` : undefined,
        cardSuffix ? `Card: ${cardSuffix}` : undefined,
        reason ? `Reason: ${reason}` : undefined,
    ].filter(Boolean);
    await bot.sendMessage(chatId, lines.join("\n"), {
        reply_markup: { inline_keyboard: [[{ text: "⬅️ Back to Transactions", callback_data: "TXN_BACK_ALL" }], [MENU_BUTTON]] },
    });
}
function extractCardTransactions(payload) {
    if (!payload)
        return [];
    if (Array.isArray(payload))
        return payload;
    const candidates = [
        payload?.data?.transactions,
        payload?.data?.data,
        payload?.data?.response?.card_transactions,
        payload?.response?.card_transactions,
        payload?.data,
        payload?.transactions,
        payload?.response?.transactions,
        payload?.response?.data,
    ];
    for (const c of candidates) {
        if (Array.isArray(c))
            return c;
    }
    return [];
}
function normalizeTxnStatus(raw) {
    const v = (raw || "").toLowerCase();
    if (v.includes("fail") || v.includes("decline") || v.includes("deny"))
        return "failed";
    if (v.includes("pending") || v.includes("review"))
        return "pending";
    return "completed";
}
function normalizeTxnDirection(raw, amount) {
    const v = (raw || "").toLowerCase();
    if (v.includes("debit") || v.includes("out") || v.includes("dr"))
        return "debit";
    if (v.includes("credit") || v.includes("in") || v.includes("cr"))
        return "credit";
    if (amount != null)
        return amount < 0 ? "debit" : "credit";
    return "debit";
}
function normalizeTxnItem(item) {
    const amountRaw = item?.amount ?? item?.transactionAmount ?? item?.total ?? item?.value;
    const amount = amountRaw != null && !Number.isNaN(Number(amountRaw)) ? Number(amountRaw) : undefined;
    const description = item?.description || item?.merchant || item?.merchant_name || item?.narration || item?.narrative;
    const currency = item?.currency || item?.ccy || item?.iso_currency;
    const statusRaw = item?.status || item?.state || item?.result;
    const txnId = item?.transactionId || item?.transaction_id || item?.id || item?.ref || item?.reference;
    const directionRaw = item?.direction || item?.type || item?.transaction_type || item?.drCr;
    const direction = normalizeTxnDirection(directionRaw, amount);
    const dateRaw = item?.date || item?.created_at || item?.createdAt || item?.transactionDate || item?.time;
    return {
        transactionNumber: txnId ? String(txnId) : undefined,
        amount,
        currency,
        description,
        status: normalizeTxnStatus(statusRaw),
        direction,
        date: dateRaw ? String(dateRaw) : undefined,
    };
}
async function cacheCardTransactions(userId, cardId, items) {
    if (!items.length)
        return;
    const now = Date.now();
    let idx = 0;
    for (const item of items) {
        const normalized = normalizeTxnItem(item);
        if (normalized.amount == null)
            continue;
        const reference = normalized.transactionNumber || `${cardId}-${now}-${idx++}`;
        if ((0, persistence_1.isPrismaPersistenceEnabled)()) {
            await prisma_1.default.transaction.upsert({
                where: {
                    transactionType_transactionNumber_userId: {
                        transactionType: "card",
                        transactionNumber: reference,
                        userId,
                    },
                },
                update: {
                    paymentMethod: "strowallet",
                    amount: Math.abs(normalized.amount),
                    currency: normalized.currency || "USD",
                    status: normalized.status,
                    metadata: {
                        cardId,
                        direction: normalized.direction,
                        description: normalized.description,
                        rawStatus: normalized.status,
                        date: normalized.date,
                    },
                    responseData: item,
                },
                create: {
                    userId,
                    transactionType: "card",
                    paymentMethod: "strowallet",
                    amount: Math.abs(normalized.amount),
                    currency: normalized.currency || "USD",
                    status: normalized.status,
                    transactionNumber: reference,
                    metadata: {
                        cardId,
                        direction: normalized.direction,
                        description: normalized.description,
                        rawStatus: normalized.status,
                        date: normalized.date,
                    },
                    responseData: item,
                },
            });
        }
        else {
            await Transaction_1.default.findOneAndUpdate({ userId, transactionType: "card", transactionNumber: reference }, {
                $set: {
                    userId,
                    transactionType: "card",
                    paymentMethod: "strowallet",
                    amount: Math.abs(normalized.amount),
                    currency: normalized.currency || "USD",
                    status: normalized.status,
                    transactionNumber: reference,
                    metadata: {
                        cardId,
                        direction: normalized.direction,
                        description: normalized.description,
                        rawStatus: normalized.status,
                        date: normalized.date,
                    },
                    responseData: item,
                },
            }, { upsert: true, new: true });
        }
    }
}
function formatTxnDate(value) {
    if (!value)
        return undefined;
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime()))
        return undefined;
    const datePart = date.toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric" });
    const timePart = date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
    return `${datePart} · ${timePart}`;
}
function formatTxnStatusIcon(status) {
    const v = (status || "").toLowerCase();
    if (v.includes("fail") || v.includes("decline") || v.includes("deny"))
        return "🔴";
    if (v.includes("pending") || v.includes("review"))
        return "🟡";
    return "🟢";
}
function formatTxnLabel(direction, description) {
    const desc = (description || "").toLowerCase();
    if (desc.includes("fee"))
        return "Fee";
    if (desc.includes("top up") || desc.includes("top-up") || desc.includes("topup") || desc.includes("fund")) {
        return "Card Top-Up";
    }
    return direction === "credit" ? "Card Credit" : "Card Payment";
}
async function handleFreezeAction(chatId, cardId, action) {
    try {
        await callStroWallet("action/status", "post", { action, card_id: cardId });
        if ((0, persistence_1.isPrismaPersistenceEnabled)()) {
            await prisma_1.default.card.updateMany({
                where: { cardId },
                data: { status: action === "freeze" ? "frozen" : "active", lastSync: new Date() },
            });
        }
        else {
            await Card_1.default.findOneAndUpdate({ cardId }, { $set: { status: action === "freeze" ? "frozen" : "active", lastSync: new Date() } }, { new: true });
        }
        await bot.sendMessage(chatId, `${action === "freeze" ? "Card frozen" : "Card unfrozen"} for ${cardId}.`, {
            reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
        });
    }
    catch (err) {
        await sendFriendlyError(chatId, err?.requestId);
    }
}
function buildCardDetailMessage(detail, cardId) {
    const last4 = detail?.last4 || detail?.card_last4 || detail?.cardLast4;
    const status = detail?.status || detail?.state || "unknown";
    const balance = detail?.balance || detail?.available_balance || detail?.availableBalance;
    const currency = detail?.currency || detail?.ccy || "";
    const name = detail?.name_on_card || detail?.name || "Card";
    const brand = detail?.brand || detail?.card_type || "";
    const expiry = detail?.expiry || detail?.expiry_date || detail?.exp || detail?.expDate;
    const billing = detail?.billing;
    const address = detail?.address;
    const lines = [
        `💳 ${name}${brand ? ` (${brand})` : ""}`,
        `ID: ${cardId}${last4 ? ` (••••${last4})` : ""}`,
        expiry ? `Expiry: ${expiry}` : undefined,
        `Status: ${status}`,
        balance ? `Balance: ${balance}${currency ? ` ${currency}` : ""}` : undefined,
        billing ? `Billing: ${billing}` : undefined,
        address ? `Address: ${address}` : undefined,
    ].filter(Boolean);
    return lines.join("\n");
}
async function fetchCardDetailSafe(cardId) {
    try {
        const resp = await callStroWallet("fetch-card-detail", "post", { card_id: cardId }, { silentOnStatus: [400, 403, 404] });
        if (!resp)
            return null;
        const payload = resp?.data || resp?.response || resp;
        const raw = payload?.data || payload?.response || payload?.card || payload;
        return normalizeCardDetail(raw) || null;
    }
    catch {
        return null;
    }
}
function extractNumericBalance(payload) {
    const candidates = [
        payload?.balance,
        payload?.available_balance,
        payload?.availableBalance,
        payload?.data?.balance,
        payload?.data?.available_balance,
        payload?.data?.availableBalance,
        payload?.response?.balance,
        payload?.response?.available_balance,
        payload?.wallet_balance,
        payload?.walletBalance,
    ];
    for (const candidate of candidates) {
        const n = Number(candidate);
        if (Number.isFinite(n))
            return n;
        if (typeof candidate === "string") {
            const cleaned = candidate.replace(/[^\d.-]/g, "");
            const parsed = Number(cleaned);
            if (Number.isFinite(parsed))
                return parsed;
        }
    }
    return null;
}
async function fetchStroWalletUsdBalanceSafe() {
    try {
        const resp = await callStroWallet("wallet-balance/USD", "get", {}, { silentOnStatus: [400, 403, 404] });
        if (!resp || resp?.ok === false)
            return null;
        return extractNumericBalance(resp?.data || resp?.response || resp);
    }
    catch {
        return null;
    }
}
function toStroAmountString(amount) {
    if (!Number.isFinite(amount) || amount <= 0)
        return "0";
    const rounded = Math.round(amount * 100) / 100;
    return Number.isInteger(rounded) ? String(Math.trunc(rounded)) : rounded.toFixed(2).replace(/\.0+$/, "").replace(/(\.\d*[1-9])0+$/, "$1");
}
async function autoTopupCardFromWalletCredit(params) {
    const userId = String(params.userId);
    const cardId = String(params.cardId);
    const amountUsdt = Number(params.amountUsdt || 0);
    if (!Number.isFinite(amountUsdt) || amountUsdt <= 0) {
        return { success: false, message: "Invalid top-up amount" };
    }
    const txnNumber = `AUTO-TOPUP-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const amountString = toStroAmountString(amountUsdt);
    const mode = normalizeMode(getDefaultMode());
    const providerPayload = {
        card_id: cardId,
        amount: amountString,
        ...(mode ? { mode } : {}),
    };
    if ((0, persistence_1.isPrismaPersistenceEnabled)()) {
        let pendingTxId = null;
        let walletAfterReserve = 0;
        try {
            const reserve = await prisma_1.default.$transaction(async (tx) => {
                const user = await tx.user.findUnique({ where: { userId } });
                if (!user) {
                    throw new Error("User not found");
                }
                const decremented = await tx.user.updateMany({
                    where: { userId, balance: { gte: amountUsdt } },
                    data: { balance: { decrement: amountUsdt } },
                });
                if (!decremented?.count) {
                    throw new Error("Insufficient wallet balance for automatic card top-up");
                }
                const updatedUser = await tx.user.findUnique({ where: { userId } });
                const pendingTx = await tx.transaction.create({
                    data: {
                        userId,
                        transactionType: "withdrawal",
                        paymentMethod: "system",
                        amount: amountUsdt,
                        amountUsdt,
                        feeUsdt: 0,
                        currency: "USDT",
                        transactionNumber: txnNumber,
                        referenceNumber: txnNumber,
                        status: "pending",
                        verified: true,
                        metadata: { cardId, source: "auto_deposit_topup" },
                    },
                });
                return {
                    walletAfterReserve: Number(updatedUser?.balance || 0),
                    pendingTxId: String(pendingTx.id),
                };
            });
            walletAfterReserve = reserve.walletAfterReserve;
            pendingTxId = reserve.pendingTxId;
        }
        catch (e) {
            return { success: false, message: e?.message || "Automatic card top-up failed" };
        }
        try {
            const providerResponse = await callStroWallet("fund-card", "post", providerPayload);
            await prisma_1.default.transaction.update({
                where: { id: pendingTxId },
                data: { status: "completed", responseData: providerResponse },
            });
            return { success: true, newWalletBalance: walletAfterReserve, providerResponse };
        }
        catch (e) {
            const message = e?.message || "Automatic card top-up failed at provider";
            await prisma_1.default.$transaction(async (tx) => {
                await tx.user.update({ where: { userId }, data: { balance: { increment: amountUsdt } } });
                await tx.transaction.update({
                    where: { id: pendingTxId },
                    data: {
                        status: "failed",
                        responseData: { error: message },
                        metadata: { cardId, source: "auto_deposit_topup", refunded: true, failureReason: message },
                    },
                });
            });
            return { success: false, message };
        }
    }
    const session = await mongoose_1.default.startSession();
    session.startTransaction();
    let pendingTxId;
    let walletAfterReserve = 0;
    try {
        const updatedUser = await User_1.default.findOneAndUpdate({ userId, balance: { $gte: amountUsdt } }, { $inc: { balance: -amountUsdt } }, { new: true, session });
        if (!updatedUser) {
            throw new Error("Insufficient wallet balance for automatic card top-up");
        }
        const created = await Transaction_1.default.create([
            {
                userId,
                transactionType: "withdrawal",
                paymentMethod: "system",
                amount: amountUsdt,
                amountUsdt,
                feeUsdt: 0,
                currency: "USDT",
                transactionNumber: txnNumber,
                referenceNumber: txnNumber,
                status: "pending",
                verified: true,
                metadata: { cardId, source: "auto_deposit_topup" },
            },
        ], { session });
        pendingTxId = created?.[0]?._id;
        walletAfterReserve = Number(updatedUser.balance || 0);
        await session.commitTransaction();
        session.endSession();
    }
    catch (e) {
        try {
            await session.abortTransaction();
        }
        catch { }
        session.endSession();
        return { success: false, message: e?.message || "Automatic card top-up failed" };
    }
    try {
        const providerResponse = await callStroWallet("fund-card", "post", providerPayload);
        await Transaction_1.default.updateOne({ _id: pendingTxId }, { $set: { status: "completed", responseData: providerResponse } });
        return { success: true, newWalletBalance: walletAfterReserve, providerResponse };
    }
    catch (e) {
        const message = e?.message || "Automatic card top-up failed at provider";
        const refundSession = await mongoose_1.default.startSession();
        refundSession.startTransaction();
        try {
            await User_1.default.updateOne({ userId }, { $inc: { balance: amountUsdt } }, { session: refundSession });
            await Transaction_1.default.updateOne({ _id: pendingTxId }, {
                $set: {
                    status: "failed",
                    responseData: { error: message },
                    metadata: { cardId, source: "auto_deposit_topup", refunded: true, failureReason: message },
                },
            }, { session: refundSession });
            await refundSession.commitTransaction();
        }
        catch (rollbackErr) {
            try {
                await refundSession.abortTransaction();
            }
            catch { }
            console.error("[bot] failed to rollback wallet after top-up provider error", rollbackErr);
        }
        finally {
            refundSession.endSession();
        }
        return { success: false, message };
    }
}
async function notifyLowStroWalletBalanceIfNeeded(params) {
    if (!bot)
        return;
    const threshold = Number.isFinite(STROWALLET_LOW_BALANCE_THRESHOLD_USD)
        ? STROWALLET_LOW_BALANCE_THRESHOLD_USD
        : 50;
    if (threshold <= 0)
        return;
    const balance = await fetchStroWalletUsdBalanceSafe();
    if (balance == null || balance >= threshold)
        return;
    const now = Date.now();
    if (now - lastLowBalanceAlertAt < STROWALLET_LOW_BALANCE_ALERT_COOLDOWN_MS)
        return;
    lastLowBalanceAlertAt = now;
    const alertLines = [
        "⚠️ StroWallet Low Balance Alert",
        `Current balance: ${balance.toFixed(2)} USD`,
        `Threshold: ${threshold.toFixed(2)} USD`,
        `Last verified deposit: ${params.creditedUsdt.toFixed(2)} USDT (${params.paymentMethod.toUpperCase()})`,
        `User ID: ${params.userId}`,
        `Time: ${new Date().toISOString()}`,
    ];
    try {
        const targetChat = /^-?\d+$/.test(STROWALLET_LOW_BALANCE_ALERT_CHAT_ID)
            ? Number(STROWALLET_LOW_BALANCE_ALERT_CHAT_ID)
            : STROWALLET_LOW_BALANCE_ALERT_CHAT_ID;
        await bot.sendMessage(targetChat, alertLines.join("\n"), {
            disable_web_page_preview: true,
            reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
        });
    }
    catch (e) {
        console.error("[bot] Failed to send low balance alert", e);
    }
}
async function callStroWallet(path, method, data, options) {
    // Optional: allow synthetic card detail in non-production environments
    if (path === "fetch-card-detail" && String(process.env.STROWALLET_FAKE_FETCH || "").toLowerCase() === "true") {
        const cardId = data?.card_id || "CARD";
        return {
            ok: true,
            data: {
                card_id: cardId,
                name_on_card: "Virtual Card",
                card_type: "virtual",
                status: "active",
                available_balance: "0",
                currency: "USD",
            },
        };
    }
    const url = API_BASE.endsWith("/") ? `${API_BASE}${path}` : `${API_BASE}/${path}`;
    try {
        const resp = await (0, axios_1.default)({ url, method, data, params: method === "get" ? data : undefined, timeout: 15000 });
        return resp.data;
    }
    catch (e) {
        const requestId = e?.response?.data?.requestId || e?.response?.data?.id;
        const rawMessage = e?.response?.data?.error || e?.message || "Request failed";
        const message = typeof rawMessage === "string" ? rawMessage : JSON.stringify(rawMessage);
        const status = e?.response?.status;
        if (status && options?.silentOnStatus?.includes(status)) {
            return { ok: false, status, data: e?.response?.data };
        }
        // Surface context to logs to trace Telegram bot failures against the StroWallet proxy
        console.error("[bot] StroWallet call failed", {
            path,
            method,
            url,
            status,
            requestId,
            message,
            data: e?.response?.data,
        });
        const err = new Error(message);
        err.requestId = requestId;
        err.status = status;
        throw err;
    }
}
async function sendFriendlyError(chatId, requestId) {
    if (!bot)
        return;
    const id = requestId || `req_${Date.now().toString(36)}`;
    const text = [
        "🤖 Oops, something went wrong.",
        "Please try again later.",
        "",
        `Request ID: ${id}`,
        "Contact support if this keeps happening.",
    ].join("\n");
    await bot.sendMessage(chatId, text, {
        reply_markup: {
            inline_keyboard: [[{ text: "🆘 Contact Support", url: SUPPORT_URL }], [MENU_BUTTON]],
        },
    });
}
