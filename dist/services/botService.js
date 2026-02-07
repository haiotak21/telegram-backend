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
exports.notifyCardRequestDeclined = notifyCardRequestDeclined;
exports.notifyDepositCredited = notifyDepositCredited;
exports.notifyKycStatus = notifyKycStatus;
exports.pollPendingKycUpdates = pollPendingKycUpdates;
exports.sendFriendlyError = sendFriendlyError;
const node_telegram_bot_api_1 = __importDefault(require("node-telegram-bot-api"));
const crypto_1 = __importDefault(require("crypto"));
const axios_1 = __importDefault(require("axios"));
const sharp_1 = __importDefault(require("sharp"));
const path_1 = __importDefault(require("path"));
const fs_1 = require("fs");
const cloudinary_1 = require("cloudinary");
const TelegramLink_1 = require("../models/TelegramLink");
const CardRequest_1 = __importDefault(require("../models/CardRequest"));
const Card_1 = __importDefault(require("../models/Card"));
const paymentVerification_1 = require("./paymentVerification");
const Transaction_1 = __importDefault(require("../models/Transaction"));
const User_1 = __importDefault(require("../models/User"));
const pricingService_1 = require("./pricingService");
let bot = null;
const pendingActions = new Map();
const createCardSessions = new Map();
const kycSessions = new Map();
const KYC_ID_TYPES = [
    { label: "National ID (NIN)", value: "NIN" },
    { label: "Passport", value: "PASSPORT" },
    { label: "Driving License", value: "DRIVING_LICENSE" },
];
const KYC_PHONE_REGEX = /^[1-9]\d{10,14}$/;
const KYC_DOB_REGEX = /^\d{2}\/\d{2}\/\d{4}$/;
const KYC_STATIC_COUNTRY = process.env.KYC_STATIC_COUNTRY || "Ghana";
const KYC_STATIC_STATE = process.env.KYC_STATIC_STATE || "Accra";
const KYC_STATIC_CITY = process.env.KYC_STATIC_CITY || "Accra";
const KYC_STATIC_IDTYPE = (process.env.KYC_STATIC_IDTYPE || "PASSPORT");
const WALLET_URL = process.env.WALLET_URL || "https://strowallet.com/app";
const SUPPORT_URL = process.env.SUPPORT_URL || "https://t.me/hailetak12";
const NEWS_URL = process.env.NEWS_URL || "https://t.me/paytelegram082";
const API_BASE = process.env.BOT_API_BASE || "http://localhost:3000/api/strowallet/";
const BACKEND_BASE = process.env.BOT_BACKEND_BASE || "http://localhost:3000";
const EXPECTED_RECEIVER_NAME = (process.env.RECEIVER_NAME || process.env.CBE_RECEIVER_NAME || "Hailemariam Takele Mekonnen").trim();
const EXPECTED_TELEBIRR_NAME = (process.env.TELEBIRR_RECEIVER_NAME || "Hayilemariyam Takele Mekonen").trim();
const CBE_STRICT_RECEIVER = String(process.env.CBE_STRICT_RECEIVER || "false").toLowerCase() === "true";
const TELEBIRR_STRICT_RECEIVER = String(process.env.TELEBIRR_STRICT_RECEIVER || "true").toLowerCase() === "true";
const EXPECTED_TELEBIRR_PHONE = (process.env.TELEBIRR_PHONE_NUMBER || "0985656670").trim();
const EXPECTED_CBE_ACCOUNT = (process.env.CBE_ACCOUNT_NUMBER || "1000473027449").trim();
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
const DEPOSIT_AMOUNTS = [5, 10, 20, 100, 1000];
const DEPOSIT_ACCOUNTS = {
    cbe: { title: "CBE Deposit", account: "1000473027449", name: "Hailemariam Takele Mekonnen", typeLabel: "CBE" },
    telebirr: { title: "Telebirr Deposit", account: "0985656670", name: "Hayilemariyam Takele Mekonen", typeLabel: "Telebirr" },
};
const CARD_REQUEST_BASE_AMOUNT_ETB = Number(process.env.CARD_REQUEST_BASE_AMOUNT_ETB || 3);
// Tracks the last amount a user selected per payment method so we can validate against receipt
const depositSelections = new Map();
const cardRequestSelections = new Map();
const MENU_BUTTON = { text: "📋 Menu", callback_data: "MENU" };
const MENU_KEYBOARD = [
    [
        { text: "➕ Request Card", callback_data: "MENU_CREATE_CARD" },
        { text: "💳 My Cards", callback_data: "MENU_MY_CARDS" },
    ],
    [
        { text: "✅ Verify Payment", callback_data: "MENU_VERIFY" },
        { text: "💰 Deposit", callback_data: "MENU_DEPOSIT" },
    ],
    [
        { text: "👤 User Info", callback_data: "MENU_USER_INFO" },
        { text: "💰 Wallet", callback_data: "MENU_WALLET" },
    ],
    [
        { text: "🧑‍🤝‍🧑 Invite Friends", callback_data: "MENU_INVITE" },
        { text: "🆘 Support", url: SUPPORT_URL },
    ],
    [{ text: "📢 News", url: NEWS_URL }],
];
function initBot() {
    if (bot) {
        return;
    }
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
        console.warn("TELEGRAM_BOT_TOKEN not set; bot disabled");
        return;
    }
    bot = new node_telegram_bot_api_1.default(token, { polling: true });
    console.log("Telegram bot started");
    bot.setMyCommands([
        { command: "start", description: "Show welcome message" },
        { command: "menu", description: "Show main menu" },
        { command: "help", description: "Show available commands" },
        { command: "kyc", description: "Submit KYC verification" },
        { command: "kyc_status", description: "Check your KYC status" },
        { command: "kyc_edit", description: "Edit and resubmit KYC" },
        { command: "card_request", description: "Request a virtual card" },
        { command: "create_card", description: "Request a virtual card" },
        { command: "requestcard", description: "Request a virtual card" },
        { command: "mycard", description: "View your card details" },
        { command: "cardstatus", description: "View your card status" },
        { command: "transactions", description: "View card transactions" },
        { command: "freeze", description: "Freeze your card" },
        { command: "unfreeze", description: "Unfreeze your card" },
        { command: "linkemail", description: "Link your email: /linkemail your@example.com" },
        { command: "linkcard", description: "Link a card: /linkcard CARD_ID" },
        { command: "unlink", description: "Remove all linked identifiers" },
        { command: "status", description: "Show current links" },
        { command: "verify", description: "Verify a payment transaction" },
    ]).catch(() => { });
    bot.onText(/^\/start$/i, async (msg) => {
        const chatId = msg.chat.id;
        const [link, cardCount] = await Promise.all([
            TelegramLink_1.TelegramLink.findOne({ chatId }),
            Card_1.default.countDocuments({ userId: String(chatId), status: { $in: ["active", "ACTIVE", "frozen", "FROZEN"] } }),
        ]);
        await bot.sendMessage(chatId, buildWelcomeMessage(), {
            parse_mode: "HTML",
            disable_web_page_preview: true,
            reply_markup: { inline_keyboard: MENU_KEYBOARD },
        });
        await bot.sendMessage(chatId, buildProfileCard(msg, link || undefined, cardCount), {
            parse_mode: "HTML",
            disable_web_page_preview: true,
            reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
        });
    });
    bot.onText(/^\/menu$/i, async (msg) => {
        await sendMenu(msg.chat.id);
    });
    bot.onText(/^\/help$/i, async (msg) => {
        await bot.sendMessage(msg.chat.id, "Commands:\n/kyc\n/kyc_status\n/kyc_edit\n/card_request\n/create_card\n/requestcard\n/mycard\n/cardstatus\n/transactions\n/freeze\n/unfreeze\n/linkemail your@example.com\n/linkcard CARD_ID\n/unlink (remove all links)\n/status\n/verify\n/deposit");
    });
    bot.onText(/^\/deposit$/i, async (msg) => {
        await sendDepositInfo(msg.chat.id);
    });
    bot.onText(/^\/verify$/i, async (msg) => {
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
    bot.onText(/^\/kyc_status$/i, async (msg) => {
        const chatId = msg.chat.id;
        const user = await User_1.default.findOne({ userId: String(chatId) }).lean();
        if (!user) {
            await bot.sendMessage(chatId, "No KYC record found. Use /kyc to submit.", {
                reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
            });
            return;
        }
        const refreshed = await refreshKycStatusFromStroWallet(user);
        const status = refreshed || user.kycStatus || "not_started";
        const label = status === "declined" ? "rejected" : status;
        await bot.sendMessage(chatId, `Your KYC status: ${label}.`, {
            reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
        });
    });
    bot.onText(/^\/create_card$/i, async (msg) => {
        const chatId = msg.chat.id;
        await handleCardRequest(chatId, msg);
    });
    bot.onText(/^\/requestcard$/i, async (msg) => {
        const chatId = msg.chat.id;
        await handleCardRequest(chatId, msg);
    });
    bot.onText(/^\/mycard(s)?$/i, async (msg) => {
        return sendMyCardSummary(msg.chat.id);
    });
    bot.onText(/^\/cardstatus$/i, async (msg) => {
        return sendCardStatus(msg.chat.id);
    });
    bot.onText(/^\/transactions$/i, async (msg) => {
        const chatId = msg.chat.id;
        await sendCardTransactions(chatId);
    });
    bot.onText(/^\/(freeze|unfreeze)$/i, async (msg, match) => {
        const action = match?.[1] === "unfreeze" ? "unfreeze" : "freeze";
        const card = await getPrimaryCardForUser(String(msg.chat.id));
        if (!card?.cardId) {
            await bot.sendMessage(msg.chat.id, "❌ No cards linked yet.", { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
            return;
        }
        await handleFreezeAction(msg.chat.id, card.cardId, action);
    });
    bot.onText(/^\/card_request$/i, async (msg) => {
        const chatId = msg.chat.id;
        await handleCardRequest(chatId, msg);
    });
    bot.onText(/^\/kyc$/i, async (msg) => {
        const chatId = msg.chat.id;
        const user = await User_1.default.findOne({ userId: String(chatId) }).lean();
        const status = (user?.kycStatus || "not_started");
        if (status === "pending") {
            if (!user?.strowalletCustomerId) {
                await bot.sendMessage(chatId, "⚠️ KYC is pending but missing a customer ID. Please resubmit your KYC.", {
                    reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
                });
                await startKycFlow(chatId, msg, "create");
                return;
            }
            await bot.sendMessage(chatId, "✅ KYC already submitted. Status: pending approval.", {
                reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
            });
            return;
        }
        if (status === "approved") {
            await bot.sendMessage(chatId, "✅ KYC already approved.", {
                reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
            });
            return;
        }
        if (status === "declined") {
            await bot.sendMessage(chatId, "❌ Your KYC was rejected. Use /kyc_edit to resubmit.", {
                reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
            });
            return;
        }
        await startKycFlow(chatId, msg, "create");
    });
    bot.onText(/^\/kyc_edit$/i, async (msg) => {
        const chatId = msg.chat.id;
        const user = await User_1.default.findOne({ userId: String(chatId) }).lean();
        if (!user) {
            await bot.sendMessage(chatId, "No KYC record found. Use /kyc to submit.", {
                reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
            });
            return;
        }
        if (user.kycStatus === "approved") {
            await bot.sendMessage(chatId, "✅ KYC already approved. No edits required.", {
                reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
            });
            return;
        }
        if (!user.strowalletCustomerId) {
            await startKycFlow(chatId, msg, "create", user);
            return;
        }
        await startKycFlow(chatId, msg, "edit", user);
    });
    bot.onText(/^\/linkemail(?:\s+([^\s]+))?$/i, async (msg, match) => {
        const email = match?.[1];
        if (!email) {
            pendingActions.set(msg.chat.id, { type: "email" });
            return bot.sendMessage(msg.chat.id, "Please send your email now (or /cancel):", {
                reply_markup: { force_reply: true },
            });
        }
        const up = await TelegramLink_1.TelegramLink.findOneAndUpdate({ chatId: msg.chat.id }, { $set: { customerEmail: email } }, { new: true, upsert: true });
        await bot.sendMessage(msg.chat.id, `Linked email ${email}.`);
    });
    bot.onText(/^\/linkcard(?:\s+([^\s]+))?$/i, async (msg, match) => {
        const cardId = match?.[1];
        if (!cardId) {
            pendingActions.set(msg.chat.id, { type: "card" });
            return bot.sendMessage(msg.chat.id, "Please send the CARD_ID now (or /cancel):", {
                reply_markup: { force_reply: true },
            });
        }
        const up = await TelegramLink_1.TelegramLink.findOneAndUpdate({ chatId: msg.chat.id }, { $addToSet: { cardIds: cardId } }, { new: true, upsert: true });
        await bot.sendMessage(msg.chat.id, `Linked card ${cardId}.`);
    });
    bot.onText(/^\/unlink$/i, async (msg) => {
        await TelegramLink_1.TelegramLink.findOneAndUpdate({ chatId: msg.chat.id }, { $set: { customerEmail: undefined, cardIds: [] } }, { upsert: true });
        await bot.sendMessage(msg.chat.id, "All links removed.");
    });
    bot.onText(/^\/status$/i, async (msg) => {
        const [link, cards] = await Promise.all([
            TelegramLink_1.TelegramLink.findOne({ chatId: msg.chat.id }).lean(),
            Card_1.default.find({ userId: String(msg.chat.id), status: { $in: ["active", "ACTIVE", "frozen", "FROZEN"] } }).lean(),
        ]);
        const cardLabels = cards.map((c) => `${c.cardId}${c.last4 ? ` (••••${c.last4})` : ""}`);
        await bot.sendMessage(msg.chat.id, `Email: ${link?.customerEmail || "(none)"}\nCards: ${cardLabels.join(", ") || "(none)"}`);
    });
    bot.onText(/^\/cancel$/i, async (msg) => {
        pendingActions.delete(msg.chat.id);
        cardRequestSelections.delete(msg.chat.id);
        kycSessions.delete(msg.chat.id);
        createCardSessions.delete(msg.chat.id);
        await bot.sendMessage(msg.chat.id, "Cancelled pending action.");
    });
    bot.on("callback_query", async (query) => {
        const chatId = query.message?.chat?.id;
        const action = query.data;
        if (!chatId || !action)
            return;
        if (action.startsWith("KYC_IDTYPE::")) {
            const idType = action.replace("KYC_IDTYPE::", "");
            const session = kycSessions.get(chatId);
            if (!session || session.step !== "idType") {
                await bot.answerCallbackQuery(query.id, { text: "KYC session not active" }).catch(() => { });
                return;
            }
            if (!KYC_ID_TYPES.find((t) => t.value === idType)) {
                await bot.answerCallbackQuery(query.id, { text: "Invalid ID type" }).catch(() => { });
                return;
            }
            session.data.idType = idType;
            session.step = "idNumber";
            kycSessions.set(chatId, session);
            await bot.answerCallbackQuery(query.id).catch(() => { });
            await bot.sendMessage(chatId, "Enter your ID number:", { reply_markup: { force_reply: true } });
            return;
        }
        if (action.startsWith("KYC_CONFIRM::")) {
            const decision = action.replace("KYC_CONFIRM::", "");
            const session = kycSessions.get(chatId);
            if (!session || session.step !== "confirm") {
                await bot.answerCallbackQuery(query.id, { text: "KYC session not active" }).catch(() => { });
                return;
            }
            await bot.answerCallbackQuery(query.id).catch(() => { });
            if (decision === "yes") {
                await submitKyc(chatId, session);
            }
            else {
                kycSessions.delete(chatId);
                await bot.sendMessage(chatId, "KYC submission cancelled.", { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
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
            if (cardType !== "visa" && cardType !== "mastercard")
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
            pendingActions.delete(chatId);
            kycSessions.delete(chatId);
            createCardSessions.delete(chatId);
            await bot.answerCallbackQuery(query.id, { text: "Cancelled" }).catch(() => { });
            await bot.sendMessage(chatId, "Cancelled pending action.", { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
            return;
        }
        if (action === "MENU") {
            await bot.answerCallbackQuery(query.id).catch(() => { });
            return sendMenu(chatId);
        }
        if (action === "MENU_VERIFY") {
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
            await sendDepositSummary(chatId, method, amount);
            return;
        }
        if (action.startsWith("DEPOSIT_CUSTOM::")) {
            const method = action.replace("DEPOSIT_CUSTOM::", "");
            if (method !== "telebirr" && method !== "cbe")
                return;
            await bot.answerCallbackQuery(query.id).catch(() => { });
            pendingActions.set(chatId, { type: "deposit_amount", method });
            await bot.sendMessage(chatId, `Enter the amount to deposit via ${method.toUpperCase()} (ETB).`, {
                reply_markup: { force_reply: true },
            });
            return;
        }
        if (action.startsWith("DEPOSIT_VERIFY::")) {
            const method = action.replace("DEPOSIT_VERIFY::", "");
            if (method !== "telebirr" && method !== "cbe")
                return;
            await bot.answerCallbackQuery(query.id).catch(() => { });
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
            pendingActions.set(chatId, { type: "card_request_verify", method });
            const meta = DEPOSIT_ACCOUNTS[method];
            const lines = [
                "💳 Card request payment",
                `Base amount: ${selection.amountEtb} ETB`,
                `Fee: ${selection.feeEtb} ETB`,
                `Total to pay: ${selection.totalEtb} ETB`,
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
    bot.on("message", async (msg) => {
        const chatId = msg.chat.id;
        const kyc = kycSessions.get(chatId);
        if (kyc) {
            await handleKycMessage(msg, kyc);
            return;
        }
        const cardSession = createCardSessions.get(chatId);
        if (cardSession) {
            await handleCreateCardMessage(msg, cardSession);
            return;
        }
        if (!msg.text)
            return;
        const pending = pendingActions.get(chatId);
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
            pendingActions.delete(msg.chat.id);
            await bot.sendMessage(msg.chat.id, `Linked email ${email}.`);
        }
        else if (pending.type === "card") {
            const cardId = text;
            if (!cardId) {
                return bot.sendMessage(msg.chat.id, "Card ID cannot be empty. Try again or /cancel.");
            }
            await TelegramLink_1.TelegramLink.findOneAndUpdate({ chatId: msg.chat.id }, { $addToSet: { cardIds: cardId } }, { new: true, upsert: true });
            pendingActions.delete(msg.chat.id);
            await bot.sendMessage(msg.chat.id, `Linked card ${cardId}.`);
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
                // Idempotency: only short-circuit if a successful verification already exists
                const already = await Transaction_1.default.findOne({
                    transactionType: "verification",
                    userId: String(msg.chat.id),
                    paymentMethod: method,
                    status: "completed",
                    $or: [{ transactionNumber: normalizedTxn }, { referenceNumber: normalizedTxn }],
                }).lean();
                if (already) {
                    await bot.sendMessage(msg.chat.id, "ℹ️ You already verified this transaction.", { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
                    pendingActions.delete(msg.chat.id);
                    return;
                }
                const result = await (0, paymentVerification_1.verifyPayment)({ paymentMethod: method, transactionNumber: normalizedTxn });
                const b = result.body;
                if (b?.success) {
                    const selected = depositSelections.get(msg.chat.id);
                    const validationErrors = validateVerificationResult({ method, body: b, selected });
                    if (validationErrors.length) {
                        const notice = [
                            "❌ Verification failed due to:",
                            ...validationErrors.map((v) => `- ${v}`),
                            "Please check your receipt and try again.",
                        ].join("\n");
                        await bot.sendMessage(msg.chat.id, notice, { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
                        pendingActions.delete(msg.chat.id);
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
                        // Record a pending deposit request for admin review (idempotent on transactionNumber)
                        const existingDeposit = await Transaction_1.default.findOne({
                            userId: String(msg.chat.id),
                            transactionType: "deposit",
                            transactionNumber: verifiedKey,
                        }).lean();
                        if (!existingDeposit) {
                            try {
                                await Transaction_1.default.create({
                                    userId: String(msg.chat.id),
                                    transactionType: "deposit",
                                    paymentMethod: method,
                                    amount: amountNum ?? 0,
                                    amountEtb: amountNum,
                                    status: "pending",
                                    transactionNumber: verifiedKey,
                                    referenceNumber: altKey,
                                    responseData: b.raw ?? b,
                                });
                            }
                            catch (depErr) {
                                if (depErr?.code !== 11000) {
                                    console.warn("deposit-recording-error", depErr?.message || depErr);
                                }
                            }
                        }
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
                        await bot.sendMessage(msg.chat.id, lines.join("\n"), { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
                        depositSelections.delete(msg.chat.id);
                        await bot.sendMessage(msg.chat.id, "✅ Payment verified. Please wait ~10 minutes for admin to approve and credit your account.", { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
                    }
                    catch (createErr) {
                        if (createErr?.code === 11000) {
                            await bot.sendMessage(msg.chat.id, "ℹ️ You already verified this transaction.", { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
                            pendingActions.delete(msg.chat.id);
                            return;
                        }
                        await bot.sendMessage(msg.chat.id, `❌ Verification error: ${createErr?.message || "Unexpected error"}`, { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
                        pendingActions.delete(msg.chat.id);
                        return;
                    }
                }
                else {
                    await bot.sendMessage(msg.chat.id, `❌ Verification failed: ${b?.message || "Unknown error"}`, { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
                }
            }
            catch (e) {
                await bot.sendMessage(msg.chat.id, `❌ Verification error: ${e?.message || "Unexpected error"}`, { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
            }
            finally {
                pendingActions.delete(msg.chat.id);
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
                const already = await Transaction_1.default.findOne({
                    transactionType: "card",
                    userId: String(msg.chat.id),
                    paymentMethod: method,
                    status: "completed",
                    $or: [{ transactionNumber: normalizedTxn }, { referenceNumber: normalizedTxn }],
                }).lean();
                if (already) {
                    await bot.sendMessage(msg.chat.id, "ℹ️ You already verified this transaction.", {
                        reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
                    });
                    pendingActions.delete(msg.chat.id);
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
                        pendingActions.delete(msg.chat.id);
                        return;
                    }
                    const validationErrors = validateVerificationResult({
                        method,
                        body: b,
                        selected: { method, amount: selection.totalEtb },
                    });
                    if (validationErrors.length) {
                        const notice = [
                            "❌ Verification failed due to:",
                            ...validationErrors.map((v) => `- ${v}`),
                            "Please check your receipt and try again.",
                        ].join("\n");
                        await bot.sendMessage(msg.chat.id, notice, { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
                        pendingActions.delete(msg.chat.id);
                        return;
                    }
                    const rawData = (b.raw?.data ?? b.raw ?? {});
                    const verifiedKey = normalizeTxnRef(String(b.transactionNumber || normalizedTxn), method);
                    const altKey = normalizeTxnRef(String(rawData?.reference || normalizedTxn), method);
                    try {
                        await Transaction_1.default.create({
                            userId: String(msg.chat.id),
                            transactionType: "card",
                            paymentMethod: method,
                            amount: selection.totalEtb,
                            amountEtb: selection.totalEtb,
                            feeEtb: selection.feeEtb,
                            status: "completed",
                            transactionNumber: verifiedKey,
                            referenceNumber: altKey,
                            responseData: b.raw ?? b,
                            metadata: {
                                kind: "card_request",
                                baseAmountEtb: selection.amountEtb,
                                feeEtb: selection.feeEtb,
                                totalEtb: selection.totalEtb,
                            },
                        });
                    }
                    catch (createErr) {
                        if (createErr?.code !== 11000) {
                            await bot.sendMessage(msg.chat.id, `❌ Verification error: ${createErr?.message || "Unexpected error"}`, {
                                reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
                            });
                            pendingActions.delete(msg.chat.id);
                            return;
                        }
                    }
                    const user = await User_1.default.findOne({ userId: String(msg.chat.id) }).lean();
                    if (!user || user.kycStatus !== "approved") {
                        await bot.sendMessage(msg.chat.id, "❌ KYC is not approved. Please complete KYC before requesting a card.", {
                            reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
                        });
                        pendingActions.delete(msg.chat.id);
                        return;
                    }
                    const activeCard = await Card_1.default.findOne({ userId: String(msg.chat.id), status: { $in: ["active", "ACTIVE", "frozen", "FROZEN"] } }).lean();
                    if (activeCard) {
                        await bot.sendMessage(msg.chat.id, "❌ You already have a card. Multiple cards are not allowed.", {
                            reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
                        });
                        pendingActions.delete(msg.chat.id);
                        return;
                    }
                    const pendingRequest = await CardRequest_1.default.findOne({ userId: String(msg.chat.id), status: "pending" }).lean();
                    if (pendingRequest) {
                        await bot.sendMessage(msg.chat.id, "⏳ Your card request is already pending review.", {
                            reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
                        });
                        pendingActions.delete(msg.chat.id);
                        return;
                    }
                    await bot.sendMessage(msg.chat.id, "✅ Payment verified. Submitting your card request...", {
                        reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
                    });
                    cardRequestSelections.delete(msg.chat.id);
                    await submitCardRequest(String(msg.chat.id), user, undefined, selection.amountEtb);
                }
                else {
                    await bot.sendMessage(msg.chat.id, `❌ Verification failed: ${b?.message || "Unknown error"}`, {
                        reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
                    });
                }
            }
            catch (e) {
                await bot.sendMessage(msg.chat.id, `❌ Verification error: ${e?.message || "Unexpected error"}`, {
                    reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
                });
            }
            finally {
                pendingActions.delete(msg.chat.id);
            }
        }
        else if (pending.type === "deposit_amount") {
            const method = pending.method;
            const amount = Number(text.replace(/,/g, ""));
            if (!Number.isFinite(amount) || amount <= 0) {
                return bot.sendMessage(msg.chat.id, "Please enter a valid amount in ETB (greater than 0), or /cancel.");
            }
            pendingActions.delete(msg.chat.id);
            await sendDepositSummary(msg.chat.id, method, amount);
        }
    });
}
async function notifyByCardId(cardId, message) {
    if (!bot)
        return;
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
    const link = await TelegramLink_1.TelegramLink.findOne({ customerEmail: email });
    if (link) {
        await bot.sendMessage(link.chatId, message, { disable_web_page_preview: true });
    }
}
async function notifyCardStatusChanged(cardId, status) {
    if (!bot)
        return;
    const card = await Card_1.default.findOne({ cardId }).lean();
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
async function notifyKycStatus(userId, status) {
    if (!bot)
        return;
    const chatId = Number(userId);
    if (!Number.isFinite(chatId))
        return;
    if (status === "approved") {
        await bot.sendMessage(chatId, "✅ Congratulations! Your KYC has been approved. You can now create your StroWallet card.", {
            reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
        });
        return;
    }
    if (status === "declined") {
        await bot.sendMessage(chatId, "❌ Kyc verification failed upload a scan of your id or passport", {
            reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
        });
    }
}
async function pollPendingKycUpdates() {
    const pending = await User_1.default.find({ kycStatus: { $in: ["pending", "approved"] } }).lean();
    if (!pending.length)
        return { checked: 0, updated: 0 };
    let updated = 0;
    for (const user of pending) {
        const nextStatus = await refreshKycStatusFromStroWallet(user);
        if (nextStatus && nextStatus !== user.kycStatus) {
            updated += 1;
            await notifyKycStatus(String(user.userId), nextStatus);
        }
    }
    return { checked: pending.length, updated };
}
function buildWelcomeMessage() {
    return [
        "👋 Welcome to <b>StroWallet</b> — manage cards and wallet in one place.",
        "Use the menu below to create cards or check balance.",
    ].join("\n");
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
async function sendMenu(chatId) {
    if (!bot)
        return;
    await bot.sendMessage(chatId, "Main menu", {
        reply_markup: { inline_keyboard: MENU_KEYBOARD },
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
            "If your link looks like https://apps.cbe.com.et:100/BranchReceipt/FT26009L330J&73027449, send either:",
            "- The full link, or",
            "- Just: FT26009L330J&73027449",
            "We will extract the reference for you.",
            "Or tap /cancel to stop.",
        ].join("\n");
}
async function startVerificationFlow(chatId, method) {
    pendingActions.set(chatId, { type: "verify", method });
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
        const ft = decoded.match(/FT[A-Z0-9]{10,18}/i);
        if (ft)
            return ft[0].toUpperCase();
        const parts = decoded.split(/&/).filter(Boolean);
        if (parts.length >= 1)
            return parts[0].toUpperCase();
        return decoded.toUpperCase();
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
    return (value || "").trim().toLowerCase();
}
function normalizeDigits(value) {
    return (value || "").replace(/\D+/g, "");
}
function namesMatch(expectedRaw, actualRaw) {
    const expected = normalizeName(expectedRaw).replace(/\s+/g, " ");
    const actual = normalizeName(actualRaw).replace(/\s+/g, " ");
    if (!expected || !actual)
        return false;
    if (actual.includes(expected))
        return true;
    if (expected.includes(actual))
        return true;
    // Try first two tokens containment
    const expParts = expected.split(" ").filter(Boolean).slice(0, 2).join(" ");
    if (expParts && actual.includes(expParts))
        return true;
    return false;
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
    const { receiverName, receiverAccount, receiverPhone, payerPhone, amount } = extractReceiptFields(body);
    const errors = [];
    const expectedName = method === "telebirr" ? EXPECTED_TELEBIRR_NAME : EXPECTED_RECEIVER_NAME;
    const strictNameCheck = method === "telebirr" ? TELEBIRR_STRICT_RECEIVER : CBE_STRICT_RECEIVER;
    if (strictNameCheck && expectedName) {
        if (!receiverName)
            errors.push("Receiver name missing on receipt");
        else if (!namesMatch(expectedName, receiverName))
            errors.push("Receiver name does not match expected recipient");
    }
    if (method === "telebirr" && EXPECTED_TELEBIRR_PHONE) {
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
        const expectedAmt = selected.amount;
        if (typeof amount !== "number")
            errors.push("Amount missing on provider receipt");
        else if (Math.abs(amount - expectedAmt) > 0.01)
            errors.push(`Amount mismatch: expected ${expectedAmt} ETB, got ${amount} ETB`);
    }
    return errors;
}
async function handleMenuSelection(action, chatId, message) {
    if (action.startsWith("CARD_DETAIL::")) {
        const cardId = action.replace("CARD_DETAIL::", "");
        return sendCardDetail(chatId, cardId);
    }
    if (action.startsWith("CARD_TXN::")) {
        const cardId = action.replace("CARD_TXN::", "");
        return sendCardTransactions(chatId, cardId);
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
            return sendMyCards(chatId);
        case "MENU_USER_INFO":
            return sendUserInfo(chatId);
        case "MENU_DEPOSIT":
            return sendDepositInfo(chatId);
        case "MENU_WALLET":
            return sendWalletSummary(chatId);
        case "MENU_INVITE":
            return bot.sendMessage(chatId, "Invite friends and earn rewards: share your referral link from the app.", {
                reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
            });
        default:
            return bot.sendMessage(chatId, "Action not recognized. Use the menu again.", { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
    }
}
async function sendDepositInfo(chatId) {
    await bot.sendMessage(chatId, "Choose a payment method to deposit:", {
        reply_markup: { inline_keyboard: buildDepositMethodKeyboard() },
    });
}
function buildDepositMethodKeyboard() {
    return [
        [
            { text: "Telebirr", callback_data: "DEPOSIT_METHOD::telebirr" },
            { text: "CBE", callback_data: "DEPOSIT_METHOD::cbe" },
        ],
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
function getCardRequestBaseAmount() {
    const base = Number.isFinite(CARD_REQUEST_BASE_AMOUNT_ETB) ? CARD_REQUEST_BASE_AMOUNT_ETB : 3;
    return base >= 3 ? base : 3;
}
async function sendDepositAmountSelect(chatId, method) {
    const methodLabel = method === "cbe" ? "CBE" : "Telebirr";
    const buttons = DEPOSIT_AMOUNTS.map((amt) => ({ text: `${amt} ETB`, callback_data: `DEPOSIT_AMOUNT::${method}::${amt}` }));
    const rows = chunk(buttons, 3);
    rows.push([{ text: "🧮 Enter custom amount", callback_data: `DEPOSIT_CUSTOM::${method}` }]);
    rows.push([{ text: "🔁 Choose method", callback_data: "MENU_DEPOSIT" }]);
    rows.push([MENU_BUTTON]);
    await bot.sendMessage(chatId, `Select amount for ${methodLabel}:`, {
        reply_markup: { inline_keyboard: rows },
    });
}
async function sendDepositSummary(chatId, method, amount) {
    const meta = DEPOSIT_ACCOUNTS[method];
    depositSelections.set(chatId, { method, amount });
    const lines = [
        `${meta.title}:`,
        `Amount: ${amount} ETB`,
        `Account: ${meta.account}`,
        `Name: ${meta.name}`,
        "",
        "Tap Copy to copy the account number, pay, then Verify to share your receipt/reference.",
    ];
    const keyboard = [
        [{ text: "📋 Copy account", copy_text: { text: meta.account } }],
        [{ text: "✅ Verify payment", callback_data: `DEPOSIT_VERIFY::${method}` }],
        [{ text: "💵 Change amount", callback_data: `DEPOSIT_METHOD::${method}` }],
        [{ text: "🔁 Switch method", callback_data: "MENU_DEPOSIT" }],
        [MENU_BUTTON],
    ];
    await bot.sendMessage(chatId, lines.join("\n"), {
        reply_markup: { inline_keyboard: keyboard },
    });
}
async function handleCardRequest(chatId, message) {
    const user = await User_1.default.findOne({ userId: String(chatId) }).lean();
    const kycStatus = (user?.kycStatus || "not_started");
    if (kycStatus !== "approved") {
        if (kycStatus === "pending") {
            const refreshed = await refreshKycStatusFromStroWallet(user);
            if (refreshed === "approved") {
                await bot.sendMessage(chatId, "✅ KYC approved. You can now request a card.", {
                    reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
                });
            }
            else {
                await bot.sendMessage(chatId, "⏳ KYC pending approval. Please wait and try again later.", {
                    reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
                });
                return;
            }
        }
        else if (kycStatus === "declined") {
            await bot.sendMessage(chatId, "❌ KYC was declined. Please resubmit with /kyc.", {
                reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
            });
            return;
        }
        else {
            await startKycFlow(chatId, message);
            return;
        }
    }
    const userId = String(chatId);
    const existingCard = await Card_1.default.findOne({ userId, status: { $in: ["active", "ACTIVE", "frozen", "FROZEN"] } }).lean();
    if (existingCard) {
        await bot.sendMessage(chatId, "❌ You already have a card. Multiple cards are not allowed.", {
            reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
        });
        return;
    }
    const pendingRequest = await CardRequest_1.default.findOne({ userId, status: "pending" }).lean();
    if (pendingRequest) {
        await bot.sendMessage(chatId, "⏳ Your card request is already pending review.", {
            reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
        });
        return;
    }
    const approvedRequest = await CardRequest_1.default.findOne({ userId, status: "approved" }).lean();
    if (approvedRequest) {
        await bot.sendMessage(chatId, "✅ Your card request was already approved. Check My Card.", {
            reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
        });
        return;
    }
    if (!user?.customerEmail) {
        await bot.sendMessage(chatId, "❌ Missing email on your KYC. Please update and resubmit KYC.", {
            reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
        });
        return;
    }
    const baseAmount = getCardRequestBaseAmount();
    const config = await (0, pricingService_1.loadPricingConfig)();
    const feeEtb = Math.max(0, Number(config.cardRequestFeeEtb ?? 0));
    const totalEtb = baseAmount + feeEtb;
    if (feeEtb > 0) {
        cardRequestSelections.set(chatId, { amountEtb: baseAmount, feeEtb, totalEtb });
        const lines = [
            "💳 Card request fee required.",
            `Base amount: ${baseAmount} ETB`,
            `Fee: ${feeEtb} ETB`,
            `Total to pay: ${totalEtb} ETB`,
            "Choose a payment method:",
        ];
        await bot.sendMessage(chatId, lines.join("\n"), {
            reply_markup: { inline_keyboard: buildCardRequestMethodKeyboard() },
        });
        return;
    }
    await submitCardRequest(String(chatId), user, message, baseAmount);
}
async function submitCardRequest(userId, user, message, baseAmount) {
    const nameOnCard = [user.firstName, user.lastName].filter(Boolean).join(" ") || message?.from?.first_name || "StroWallet User";
    const amount = baseAmount != null ? String(baseAmount) : String(getCardRequestBaseAmount());
    try {
        const resp = await axios_1.default.post(`${BACKEND_BASE}/api/card-requests`, {
            userId,
            nameOnCard,
            cardType: "visa",
            amount,
            customerEmail: user.customerEmail,
        });
        if (resp?.data?.success) {
            await bot.sendMessage(Number(userId), "✅ Your card request has been submitted to StroWallet. You'll be notified once approved.", {
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
        const messageText = e?.response?.data?.message || "Your card request could not be approved.";
        await bot.sendMessage(Number(userId), `❌ ${messageText}`, {
            reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
        });
    }
}
async function startCreateCardFlow(chatId, message) {
    const user = await User_1.default.findOne({ userId: String(chatId) }).lean();
    const status = (user?.kycStatus || "not_started");
    if (status !== "approved") {
        if (status === "pending") {
            await bot.sendMessage(chatId, "⏳ KYC pending approval. Please wait before creating a card.", {
                reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
            });
        }
        else if (status === "declined") {
            await bot.sendMessage(chatId, "❌ Your KYC was rejected. Use /kyc_edit to resubmit.", {
                reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
            });
        }
        else {
            await bot.sendMessage(chatId, "❌ You must complete and pass KYC before creating a card. Use /kyc.", {
                reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
            });
        }
        return;
    }
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
            await bot.sendMessage(chatId, "Select card type:", {
                reply_markup: {
                    inline_keyboard: [[
                            { text: "Visa", callback_data: "CARD_TYPE::visa" },
                            { text: "Mastercard", callback_data: "CARD_TYPE::mastercard" },
                        ], [MENU_BUTTON]],
                },
            });
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
                reply_markup: { inline_keyboard: [[
                            { text: "✅ Create Card", callback_data: "CARD_CONFIRM::yes" },
                            { text: "❌ Cancel", callback_data: "CARD_CONFIRM::no" },
                        ], [MENU_BUTTON]] },
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
    const user = await User_1.default.findOne({ userId: String(chatId) }).lean();
    if (!user || user.kycStatus !== "approved") {
        createCardSessions.delete(chatId);
        await bot.sendMessage(chatId, "❌ You must complete and pass KYC before creating a card.", {
            reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
        });
        return;
    }
    const customerEmail = user.customerEmail;
    if (!customerEmail) {
        createCardSessions.delete(chatId);
        await bot.sendMessage(chatId, "❌ Missing email. Please update your KYC email and try again.", {
            reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
        });
        return;
    }
    try {
        const payload = {
            name_on_card: session.data.nameOnCard || "Virtual Card",
            card_type: session.data.cardType || "visa",
            amount: session.data.amount || "3",
            customerEmail,
        };
        const resp = await callStroWallet("create-card", "post", payload);
        const data = resp?.data ?? resp;
        if (data?.success === false || data?.ok === false) {
            const providerMsg = data?.message || data?.error || "Card creation rejected";
            throw new Error(typeof providerMsg === "string" ? providerMsg : JSON.stringify(providerMsg));
        }
        const cardId = data?.card_id || data?.data?.card_id || data?.id || data?.data?.id;
        if (cardId) {
            await TelegramLink_1.TelegramLink.findOneAndUpdate({ chatId }, { $addToSet: { cardIds: cardId }, $set: { customerEmail } }, { upsert: true, new: true });
            await Card_1.default.findOneAndUpdate({ cardId }, {
                $set: {
                    cardId,
                    userId: String(chatId),
                    customerEmail,
                    nameOnCard: payload.name_on_card,
                    cardType: payload.card_type,
                    status: data?.status || data?.state || "active",
                    currency: data?.currency || data?.ccy,
                    balance: data?.balance || data?.available_balance,
                    availableBalance: data?.available_balance,
                },
            }, { upsert: true, new: true });
        }
        createCardSessions.delete(chatId);
        await bot.sendMessage(chatId, `✅ Your StroWallet card has been created!\nCard ID: ${cardId || "(pending)"}`, { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
    }
    catch (err) {
        createCardSessions.delete(chatId);
        const msg = err?.response?.data?.message || err?.response?.data?.error || err?.message || "Card creation failed";
        await bot.sendMessage(chatId, `❌ ${msg}\nPlease try again.`, {
            reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
        });
    }
}
async function startKycFlow(chatId, message, mode = "create", user) {
    const data = {};
    if (mode === "edit" && user) {
        data.firstName = user.firstName || undefined;
        data.lastName = user.lastName || undefined;
        data.dateOfBirth = user.dateOfBirth || undefined;
        data.phoneNumber = user.phoneNumber || undefined;
        data.customerEmail = user.customerEmail || undefined;
        data.line1 = user.line1 || undefined;
        data.city = user.city || undefined;
        data.state = user.state || undefined;
        data.zipCode = user.zipCode || undefined;
        data.country = user.country || undefined;
        data.houseNumber = user.houseNumber || undefined;
        data.idType = user.idType || undefined;
        // Force re-upload on edit to avoid stale Telegram URLs
        data.idImage = undefined;
        data.idImageFront = undefined;
        data.idImageBack = undefined;
        data.idImagePdf = undefined;
        data.userPhoto = undefined;
    }
    kycSessions.set(chatId, { step: "firstName", data, mode });
    await bot.sendMessage(chatId, mode === "edit"
        ? "🪪 KYC Update\nLet's update your details. Please answer the following questions."
        : "🪪 KYC Verification\nLet's begin. Please answer the following questions.", { reply_markup: { inline_keyboard: [[{ text: "Cancel", callback_data: "CANCEL" }]] } });
    await bot.sendMessage(chatId, "Enter your first name:", { reply_markup: { force_reply: true } });
}
async function handleKycMessage(msg, session) {
    const chatId = msg.chat.id;
    const text = msg.text ? String(msg.text).trim() : "";
    if (session.step === "idImage" || session.step === "idImageFront" || session.step === "idImageBack" || session.step === "userPhoto") {
        const url = await extractKycMediaUrl(msg, text);
        if (url) {
            if (session.step === "idImage") {
                session.data.idImage = url;
                session.step = "userPhoto";
            }
            else if (session.step === "idImageFront") {
                session.data.idImageFront = url;
                if (isPdfUrl(url)) {
                    session.data.idImagePdf = url;
                    session.data.idImage = url;
                    session.step = "userPhoto";
                }
                else {
                    session.step = "idImageBack";
                }
            }
            else if (session.step === "idImageBack") {
                session.data.idImageBack = url;
                if (!session.data.idImage)
                    session.data.idImage = session.data.idImageFront || url;
                session.step = "userPhoto";
            }
            else if (session.step === "userPhoto") {
                session.data.userPhoto = url;
                session.step = "confirm";
            }
            kycSessions.set(chatId, session);
            await promptKycStep(chatId, session);
            return;
        }
        const hint = session.step === "userPhoto" ? "photo or image URL" : "photo, PDF, or URL";
        await bot.sendMessage(chatId, `Please upload a ${hint}.`, { reply_markup: { force_reply: true } });
        return;
    }
    if (!text) {
        await bot.sendMessage(chatId, "Please send a text response.", { reply_markup: { force_reply: true } });
        return;
    }
    switch (session.step) {
        case "firstName":
            session.data.firstName = text;
            session.step = "lastName";
            break;
        case "lastName":
            session.data.lastName = text;
            session.step = "dateOfBirth";
            break;
        case "dateOfBirth":
            if (!KYC_DOB_REGEX.test(text)) {
                await bot.sendMessage(chatId, "Invalid date format. Use MM/DD/YYYY.", { reply_markup: { force_reply: true } });
                return;
            }
            session.data.dateOfBirth = text;
            session.step = "phoneNumber";
            break;
        case "phoneNumber":
            if (!KYC_PHONE_REGEX.test(text)) {
                await bot.sendMessage(chatId, "Invalid phone number. Use international format without '+'.", { reply_markup: { force_reply: true } });
                return;
            }
            session.data.phoneNumber = text;
            session.step = "customerEmail";
            break;
        case "customerEmail":
            if (!/.+@.+\..+/.test(text)) {
                await bot.sendMessage(chatId, "Invalid email format. Try again.", { reply_markup: { force_reply: true } });
                return;
            }
            session.data.customerEmail = text;
            session.step = "line1";
            break;
        case "line1":
            session.data.line1 = text;
            session.step = "city";
            break;
        case "city":
            session.data.city = text;
            session.step = "state";
            break;
        case "state":
            session.data.state = text;
            session.step = "zipCode";
            break;
        case "zipCode":
            session.data.zipCode = text;
            session.step = "country";
            break;
        case "country":
            session.data.country = text;
            session.step = "houseNumber";
            break;
        case "houseNumber":
            session.data.houseNumber = text;
            session.step = "idType";
            break;
        case "idType":
            await bot.sendMessage(chatId, "Please select an ID type using the buttons.", {
                reply_markup: { inline_keyboard: buildKycIdTypeKeyboard() },
            });
            return;
        case "idNumber":
            session.data.idNumber = text;
            session.step = requiresIdBack(session.data.idType) ? "idImageFront" : "idImage";
            break;
        case "confirm":
            await bot.sendMessage(chatId, "Please use the buttons to confirm submission.", {
                reply_markup: { inline_keyboard: buildKycConfirmKeyboard() },
            });
            return;
    }
    kycSessions.set(chatId, session);
    await promptKycStep(chatId, session);
}
async function promptKycStep(chatId, session) {
    if (session.lastPromptStep === session.step)
        return;
    session.lastPromptStep = session.step;
    switch (session.step) {
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
        case "city":
            await bot.sendMessage(chatId, "Enter your city:", { reply_markup: { force_reply: true } });
            break;
        case "state":
            await bot.sendMessage(chatId, "Enter your state:", { reply_markup: { force_reply: true } });
            break;
        case "zipCode":
            await bot.sendMessage(chatId, "Enter your ZIP code:", { reply_markup: { force_reply: true } });
            break;
        case "country":
            await bot.sendMessage(chatId, "Enter your country (e.g., Ethiopia):", { reply_markup: { force_reply: true } });
            break;
        case "houseNumber":
            await bot.sendMessage(chatId, "Enter your house number:", { reply_markup: { force_reply: true } });
            break;
        case "idType":
            await bot.sendMessage(chatId, "Select your ID type:", {
                reply_markup: { inline_keyboard: buildKycIdTypeKeyboard() },
            });
            break;
        case "idImage":
            await bot.sendMessage(chatId, "Upload your ID image (photo or URL):", { reply_markup: { force_reply: true } });
            break;
        case "idImageFront":
            await bot.sendMessage(chatId, "Upload the FRONT of your ID (photo or PDF):", { reply_markup: { force_reply: true } });
            break;
        case "idImageBack":
            await bot.sendMessage(chatId, "Upload the BACK of your ID (photo or PDF):", { reply_markup: { force_reply: true } });
            break;
        case "userPhoto":
            await bot.sendMessage(chatId, "Upload your selfie (photo or URL):", { reply_markup: { force_reply: true } });
            break;
        case "confirm":
            await bot.sendMessage(chatId, buildKycSummary(session.data), {
                reply_markup: { inline_keyboard: buildKycConfirmKeyboard() },
                disable_web_page_preview: true,
            });
            break;
        default:
            await bot.sendMessage(chatId, "Enter your first name:", { reply_markup: { force_reply: true } });
    }
}
function buildKycIdTypeKeyboard() {
    return [
        KYC_ID_TYPES.map((t) => ({ text: t.label, callback_data: `KYC_IDTYPE::${t.value}` })),
        [MENU_BUTTON],
    ];
}
function buildKycConfirmKeyboard() {
    return [
        [
            { text: "✅ Submit KYC", callback_data: "KYC_CONFIRM::yes" },
            { text: "❌ Cancel", callback_data: "KYC_CONFIRM::no" },
        ],
        [MENU_BUTTON],
    ];
}
function buildKycSummary(data) {
    const maskedId = data.idNumber ? maskIdNumber(data.idNumber) : "";
    const idImageLine = data.idImagePdf
        ? "ID document: PDF uploaded"
        : data.idImageFront || data.idImageBack
            ? `ID document: front ${data.idImageFront ? "✔" : "✖"} / back ${data.idImageBack ? "✔" : "✖"}`
            : data.idImage
                ? "ID document: uploaded"
                : "";
    const lines = [
        "Please confirm your KYC details:",
        `First name: ${data.firstName || ""}`,
        `Last name: ${data.lastName || ""}`,
        `Date of birth: ${data.dateOfBirth || ""}`,
        `Phone: ${data.phoneNumber || ""}`,
        `Email: ${data.customerEmail || ""}`,
        `Address: ${data.line1 || ""}, ${data.city || ""}, ${data.state || ""}, ${data.zipCode || ""}, ${data.country || ""}`,
        `House number: ${data.houseNumber || ""}`,
        `ID type: ${data.idType || ""}`,
        `ID number: ${maskedId}`,
        idImageLine,
        `Selfie: ${data.userPhoto ? "uploaded" : ""}`,
    ].filter(Boolean);
    return lines.join("\n");
}
function maskIdNumber(idNumber) {
    if (!idNumber)
        return "";
    const last4 = idNumber.slice(-4);
    return `${"*".repeat(Math.max(0, idNumber.length - 4))}${last4}`;
}
function isHttpUrl(value) {
    try {
        const u = new URL(value);
        return u.protocol === "http:" || u.protocol === "https:";
    }
    catch {
        return false;
    }
}
function requiresIdBack(idType) {
    return idType === "NIN" || idType === "DRIVING_LICENSE";
}
function isPdfUrl(value) {
    return value.toLowerCase().includes(".pdf");
}
async function extractKycMediaUrl(msg, text) {
    const photo = msg.photo?.[msg.photo.length - 1];
    if (photo?.file_id) {
        return await getTelegramFileUrl(photo.file_id);
    }
    const document = msg.document;
    if (document?.file_id) {
        return await getTelegramFileUrl(document.file_id);
    }
    if (text && isHttpUrl(text))
        return text;
    return undefined;
}
async function getTelegramFileUrl(fileId) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token)
        throw new Error("TELEGRAM_BOT_TOKEN not set");
    const file = await bot.getFile(fileId);
    if (!file?.file_path)
        throw new Error("Telegram file path unavailable");
    return `https://api.telegram.org/file/bot${token}/${file.file_path}`;
}
function isTelegramFileUrl(url) {
    if (!url)
        return false;
    try {
        const u = new URL(url);
        return u.hostname === "api.telegram.org" && u.pathname.includes("/file/bot");
    }
    catch {
        return false;
    }
}
async function toDataUriFromUrl(url) {
    const resp = await axios_1.default.get(url, { responseType: "arraybuffer" });
    let contentType = resp.headers?.["content-type"] || "application/octet-stream";
    let buffer = Buffer.from(resp.data);
    if (contentType.startsWith("image/")) {
        try {
            buffer = await (0, sharp_1.default)(buffer)
                .rotate()
                .resize({ width: 800, height: 800, fit: "inside" })
                .jpeg({ quality: 70, mozjpeg: true })
                .toBuffer();
            contentType = "image/jpeg";
        }
        catch (e) {
            console.warn("[bot] Failed to compress image; using original", e);
            if (!contentType.startsWith("image/"))
                contentType = "image/jpeg";
        }
    }
    else {
        contentType = "image/jpeg";
    }
    const base64 = buffer.toString("base64");
    return `data:${contentType};base64,${base64}`;
}
let cloudinaryReady = null;
function ensureCloudinary() {
    if (cloudinaryReady !== null)
        return cloudinaryReady;
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    const apiKey = process.env.CLOUDINARY_API_KEY;
    const apiSecret = process.env.CLOUDINARY_API_SECRET;
    if (cloudName && apiKey && apiSecret) {
        cloudinary_1.v2.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret, secure: true });
        cloudinaryReady = true;
        return true;
    }
    cloudinaryReady = false;
    return false;
}
async function uploadToCloudinary(buffer) {
    const folder = process.env.CLOUDINARY_FOLDER || "strowallet-kyc";
    return await new Promise((resolve, reject) => {
        const stream = cloudinary_1.v2.uploader.upload_stream({ folder, resource_type: "image" }, (err, result) => {
            if (err)
                return reject(err);
            const url = result?.secure_url || result?.url;
            if (!url)
                return reject(new Error("Cloudinary upload missing URL"));
            resolve(url);
        });
        stream.end(buffer);
    });
}
async function saveTelegramMedia(url) {
    const resp = await axios_1.default.get(url, { responseType: "arraybuffer" });
    const contentType = resp.headers?.["content-type"] || "application/octet-stream";
    let buffer = Buffer.from(resp.data);
    let ext = "jpg";
    if (contentType.startsWith("image/")) {
        try {
            buffer = await (0, sharp_1.default)(buffer)
                .rotate()
                .resize({ width: 800, height: 800, fit: "inside" })
                .jpeg({ quality: 70, mozjpeg: true })
                .toBuffer();
            ext = "jpg";
        }
        catch (e) {
            console.warn("[bot] Failed to compress image; using original", e);
        }
    }
    if (ensureCloudinary()) {
        try {
            return await uploadToCloudinary(buffer);
        }
        catch (e) {
            console.warn("[bot] Cloudinary upload failed; falling back to local upload", e);
        }
    }
    const uploadsDir = path_1.default.join(process.cwd(), "public", "uploads");
    await fs_1.promises.mkdir(uploadsDir, { recursive: true });
    const name = `kyc_${Date.now()}_${crypto_1.default.randomBytes(6).toString("hex")}.${ext}`;
    const filePath = path_1.default.join(uploadsDir, name);
    await fs_1.promises.writeFile(filePath, buffer);
    const baseUrl = (process.env.BOT_BACKEND_BASE || "http://localhost:3000").replace(/\/$/, "");
    return `${baseUrl}/uploads/${name}`;
}
async function embedTelegramMedia(url) {
    if (!url || !isTelegramFileUrl(url))
        return url;
    try {
        return await saveTelegramMedia(url);
    }
    catch (e) {
        console.warn("[bot] Failed to embed Telegram media; falling back to URL", e);
        return url;
    }
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
function extractCustomerId(payload) {
    return (payload?.data?.customerId ||
        payload?.data?.customer_id ||
        payload?.data?.data?.customerId ||
        payload?.data?.data?.customer_id ||
        payload?.data?.response?.customerId ||
        payload?.data?.response?.customer_id ||
        payload?.customerId ||
        payload?.customer_id ||
        payload?.data?.id ||
        payload?.data?.data?.id ||
        payload?.id);
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
async function submitKyc(chatId, session) {
    const data = session.data;
    const missing = [
        "firstName",
        "lastName",
        "dateOfBirth",
        "phoneNumber",
        "customerEmail",
        "line1",
        "city",
        "state",
        "zipCode",
        "country",
        "houseNumber",
        "idType",
        "idNumber",
        "userPhoto",
    ].filter((k) => !data[k]);
    const needsBothSides = requiresIdBack(data.idType);
    const hasPdf = Boolean(data.idImagePdf);
    if (needsBothSides && !hasPdf) {
        if (!data.idImageFront)
            missing.push("idImageFront");
        if (!data.idImageBack)
            missing.push("idImageBack");
    }
    if (!needsBothSides && !data.idImage) {
        missing.push("idImage");
    }
    if (missing.length) {
        await bot.sendMessage(chatId, "Missing required fields. Please restart /kyc.", {
            reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
        });
        kycSessions.delete(chatId);
        return;
    }
    const idImageSource = data.idImagePdf || data.idImageFront || data.idImage || data.idImageBack;
    const idImageForApi = await embedTelegramMedia(idImageSource);
    const userPhotoForApi = await embedTelegramMedia(data.userPhoto);
    const countryForApi = KYC_STATIC_COUNTRY;
    const stateForApi = KYC_STATIC_STATE;
    const cityForApi = KYC_STATIC_CITY;
    const idTypeForApi = KYC_STATIC_IDTYPE;
    const createPayload = {
        firstName: data.firstName,
        lastName: data.lastName,
        dateOfBirth: data.dateOfBirth,
        phoneNumber: data.phoneNumber,
        customerEmail: data.customerEmail,
        line1: data.line1,
        city: cityForApi,
        state: stateForApi,
        zipCode: data.zipCode,
        country: countryForApi,
        houseNumber: data.houseNumber,
        idType: idTypeForApi,
        idNumber: data.idNumber,
        idImage: idImageForApi,
        userPhoto: userPhotoForApi,
    };
    const updatePayload = {
        customerId: undefined,
        firstName: data.firstName,
        lastName: data.lastName,
        idImage: idImageForApi,
        userPhoto: userPhotoForApi,
        phoneNumber: data.phoneNumber,
        country: countryForApi,
        city: cityForApi,
        state: stateForApi,
        zipCode: data.zipCode,
        line1: data.line1,
        houseNumber: data.houseNumber,
    };
    try {
        const user = await User_1.default.findOne({ userId: String(chatId) }).lean();
        let resp;
        if (session.mode === "edit") {
            const customerId = user?.strowalletCustomerId;
            if (!customerId) {
                throw Object.assign(new Error("Missing StroWallet customer ID. Please resubmit /kyc."), { status: 400 });
            }
            updatePayload.customerId = customerId;
            resp = await callStroWallet("updateCardCustomer", "put", updatePayload);
        }
        else {
            resp = await callStroWallet("create-user", "post", createPayload);
        }
        let customerId = extractCustomerId(resp);
        if (!customerId && session.mode === "create") {
            try {
                for (let attempt = 0; attempt < 3; attempt += 1) {
                    await sleep(1200);
                    const lookup = await callStroWallet("getcardholder", "get", { customerEmail: data.customerEmail }, { silentOnStatus: [404] });
                    customerId = extractCustomerId(lookup);
                    if (customerId)
                        break;
                }
            }
            catch (e) {
                console.warn("[bot] KYC customerId lookup failed", e);
            }
        }
        if (!customerId && session.mode === "create") {
            kycSessions.delete(chatId);
            await bot.sendMessage(chatId, "⚠️ KYC submitted but customer ID not available yet. Please try again in a few minutes or contact support.", {
                reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
            });
            return;
        }
        const idNumberEncrypted = encryptKycIdNumber(data.idNumber);
        if (!idNumberEncrypted) {
            console.warn("[bot] KYC_ENCRYPTION_KEY missing or invalid; idNumber not encrypted at rest");
        }
        const idNumberLast4 = data.idNumber.slice(-4);
        await User_1.default.findOneAndUpdate({ userId: String(chatId) }, {
            $set: {
                kycStatus: "pending",
                strowalletCustomerId: customerId || user?.strowalletCustomerId,
                firstName: data.firstName,
                lastName: data.lastName,
                dateOfBirth: data.dateOfBirth,
                phoneNumber: data.phoneNumber,
                customerEmail: data.customerEmail,
                line1: data.line1,
                city: data.city,
                state: data.state,
                zipCode: data.zipCode,
                country: data.country,
                houseNumber: data.houseNumber,
                idType: data.idType,
                idNumberEncrypted,
                idNumberLast4,
                idImageUrl: idImageForApi,
                idImageFrontUrl: data.idImageFront,
                idImageBackUrl: data.idImageBack,
                idImagePdfUrl: data.idImagePdf,
                userPhotoUrl: data.userPhoto,
                kycSubmittedAt: new Date(),
            },
        }, { upsert: true, new: true });
        kycSessions.delete(chatId);
        await bot.sendMessage(chatId, session.mode === "edit"
            ? "✅ Your updated KYC has been submitted successfully. Status: pending approval."
            : "✅ KYC submitted. Status: pending approval.", {
            reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
        });
    }
    catch (err) {
        kycSessions.delete(chatId);
        if (err?.status === 400) {
            await bot.sendMessage(chatId, "❌ Invalid/missing data. Please retry with /kyc.", {
                reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
            });
            return;
        }
        await sendFriendlyError(chatId, err?.requestId);
    }
}
async function refreshKycStatusFromStroWallet(user) {
    try {
        const customerId = user?.strowalletCustomerId;
        const customerEmail = user?.customerEmail;
        if (!customerId && !customerEmail)
            return undefined;
        const resp = await callStroWallet("getcardholder", "get", {
            customerId,
            customerEmail,
        }, { silentOnStatus: [404] });
        if (resp?.ok === false)
            return undefined;
        const data = resp?.data ?? resp;
        const providerCustomerId = extractCustomerId(resp);
        const statusRaw = data?.status ||
            data?.kycStatus ||
            data?.verificationStatus ||
            data?.state ||
            data?.data?.status ||
            data?.data?.kycStatus ||
            data?.data?.verificationStatus ||
            data?.data?.state;
        const normalized = normalizeKycStatus(statusRaw);
        if ((normalized && normalized !== user?.kycStatus) || (providerCustomerId && !user?.strowalletCustomerId)) {
            await User_1.default.findOneAndUpdate({ userId: String(user.userId) }, { $set: { kycStatus: normalized || user?.kycStatus, ...(providerCustomerId ? { strowalletCustomerId: providerCustomerId } : {}) } }, { new: true });
        }
        return normalized;
    }
    catch {
        return undefined;
    }
}
function normalizeKycStatus(value) {
    if (!value)
        return undefined;
    const v = String(value).toLowerCase();
    if (["approved", "verified", "success", "active", "high kyc"].includes(v))
        return "approved";
    if (["pending", "processing", "review", "unreview kyc"].includes(v))
        return "pending";
    if (["declined", "rejected", "failed", "low kyc"].includes(v))
        return "declined";
    return undefined;
}
async function sendUserInfo(chatId) {
    const [link, user, cards] = await Promise.all([
        TelegramLink_1.TelegramLink.findOne({ chatId }).lean(),
        User_1.default.findOne({ userId: String(chatId) }).lean(),
        Card_1.default.find({ userId: String(chatId), status: { $in: ["active", "ACTIVE", "frozen", "FROZEN"] } }).lean(),
    ]);
    const balance = user?.balance ?? 0;
    const currency = user?.currency || "USDT";
    const cardsList = cards || [];
    const email = user?.customerEmail || link?.customerEmail;
    const kycStatus = user?.kycStatus || "not_started";
    const kycLabel = kycStatus === "approved" ? "approved" : kycStatus === "pending" ? "pending" : "not started";
    const cardList = cardsList.slice(0, 3).map((c, idx) => `${idx + 1}. ${c.cardId}${c.last4 ? ` (••••${c.last4})` : ""}`);
    const lines = [
        "👤 Your Profile",
        `User ID: ${chatId}`,
        email ? `Email: ${email}` : "Email: not linked (use /linkemail your@example.com)",
        `KYC: ${kycLabel} (use /kyc to submit)`,
        `Wallet: ${balance} ${currency}`,
        `Cards: ${cardsList.length || 0}${cardsList.length ? " (see below)" : ""}`,
        cardList.length ? cardList.join("\n") : undefined,
        !cardsList.length ? "Tip: Request a card from admin to get started." : undefined,
    ].filter(Boolean);
    await bot.sendMessage(chatId, lines.join("\n"), {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "💼 Wallet", callback_data: "MENU_WALLET" },
                    { text: "💳 My Cards", callback_data: "MENU_MY_CARDS" },
                ],
                [MENU_BUTTON],
            ],
        },
    });
}
function chunk(items, size) {
    const rows = [];
    for (let i = 0; i < items.length; i += size) {
        rows.push(items.slice(i, i + size));
    }
    return rows;
}
async function sendWalletSummary(chatId) {
    const [link, user, cards] = await Promise.all([
        TelegramLink_1.TelegramLink.findOne({ chatId }).lean(),
        User_1.default.findOne({ userId: String(chatId) }).lean(),
        Card_1.default.find({ userId: String(chatId), status: { $in: ["active", "ACTIVE", "frozen", "FROZEN"] } }).lean(),
    ]);
    const cardId = cards?.[0]?.cardId || link?.cardIds?.[0];
    const walletBalance = user?.balance ?? 0;
    if (!cardId) {
        const lines = ["💼 Wallet", `Balance: ${walletBalance} USD`, "No card yet. Request a card to get started."];
        await bot.sendMessage(chatId, lines.join("\n"), { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
        return;
    }
    // Prefer local synthetic detail if available
    const local = await CardRequest_1.default.findOne({ cardId, status: "approved" }).lean();
    if (local) {
        const lines = [
            "💼 Wallet",
            `Balance: ${walletBalance} USD`,
            `Card: ${cardId}`,
            `Name: ${local.nameOnCard || "Virtual Card"}`,
            local.cardNumber ? `Number: ${local.cardNumber}` : undefined,
            local.cvc ? `CVC: ${local.cvc}` : undefined,
        ].filter(Boolean);
        await bot.sendMessage(chatId, lines.join("\n"), {
            reply_markup: { inline_keyboard: [[{ text: "🔍 My Cards", callback_data: "MENU_MY_CARDS" }], [MENU_BUTTON]] },
        });
        return;
    }
    // Fallback: try upstream detail
    try {
        const resp = await callStroWallet("fetch-card-detail", "post", { card_id: cardId });
        const detail = resp?.data ?? resp;
        const lines = [
            "💼 Wallet",
            `Balance: ${walletBalance} USD`,
            `Card: ${cardId}`,
            detail?.name_on_card ? `Name: ${detail.name_on_card}` : undefined,
            detail?.card_number ? `Number: ${detail.card_number}` : undefined,
            detail?.cvc ? `CVC: ${detail.cvc}` : undefined,
        ].filter(Boolean);
        await bot.sendMessage(chatId, lines.join("\n"), {
            reply_markup: { inline_keyboard: [[{ text: "🔍 My Cards", callback_data: "MENU_MY_CARDS" }], [MENU_BUTTON]] },
        });
    }
    catch (err) {
        await sendFriendlyError(chatId, err?.requestId);
    }
}
async function sendMyCards(chatId) {
    const cards = await Card_1.default.find({ userId: String(chatId), status: { $in: ["active", "ACTIVE", "frozen", "FROZEN"] } }).lean();
    const legacyLink = await TelegramLink_1.TelegramLink.findOne({ chatId }).lean();
    const cardIds = cards.length ? cards.map((c) => c.cardId) : legacyLink?.cardIds || [];
    if (!cardIds.length) {
        await bot.sendMessage(chatId, "No card yet. Request a card to get started.", {
            reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
        });
        return;
    }
    await bot.sendMessage(chatId, `Fetching ${cardIds.length} card(s)...`, {
        reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
    });
    for (const cardId of cardIds) {
        await sendCardDetail(chatId, cardId);
    }
}
async function getPrimaryCardForUser(userId) {
    return Card_1.default.findOne({ userId, status: { $in: ["active", "ACTIVE", "frozen", "FROZEN"] } })
        .sort({ updatedAt: -1 })
        .lean();
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
        const user = await User_1.default.findOne({ userId: String(chatId) }).lean();
        const walletBalance = user?.balance ?? 0;
        const card = await Card_1.default.findOne({ cardId }).lean();
        // If this card was generated locally, serve synthetic details and avoid upstream call
        const local = await CardRequest_1.default.findOne({ cardId, status: "approved" }).lean();
        if (local) {
            const detail = {
                card_id: cardId,
                name_on_card: local.nameOnCard || "Virtual Card",
                card_type: local.cardType || "virtual",
                status: card?.status || "active",
                balance: walletBalance,
                available_balance: local.amount || undefined,
                currency: card?.currency || "USD",
                card_number: local.cardNumber,
                cvc: local.cvc,
                last4: card?.last4,
            };
            const text = buildCardDetailMessage(detail, cardId);
            await bot.sendMessage(chatId, text, {
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: "🔍 Transactions", callback_data: `CARD_TXN::${cardId}` },
                            { text: "❄️ Freeze", callback_data: `CARD_FREEZE::${cardId}` },
                            { text: "🔥 Unfreeze", callback_data: `CARD_UNFREEZE::${cardId}` },
                        ],
                        [MENU_BUTTON],
                    ],
                },
            });
            return;
        }
        // If not local, return a minimal synthetic card to avoid upstream 403
        const detail = {
            card_id: cardId,
            name_on_card: "Virtual Card",
            card_type: "virtual",
            status: card?.status || "active",
            balance: walletBalance,
            available_balance: undefined,
            currency: card?.currency || "USD",
            last4: card?.last4,
        };
        const text = buildCardDetailMessage(detail, cardId);
        await bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
    }
    catch (err) {
        await sendFriendlyError(chatId, err?.requestId);
    }
}
async function sendCardTransactions(chatId, cardId) {
    try {
        const userId = String(chatId);
        const primaryCard = cardId ? await Card_1.default.findOne({ cardId }).lean() : await getPrimaryCardForUser(userId);
        const targetCardId = cardId || primaryCard?.cardId;
        if (!targetCardId) {
            await bot.sendMessage(chatId, "❌ No cards linked yet.", { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
            return;
        }
        if (primaryCard?.status && String(primaryCard.status).toLowerCase() === "frozen") {
            await bot.sendMessage(chatId, "❄️ Your card is frozen. Transactions are unavailable while the card is frozen.", {
                reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
            });
            return;
        }
        const query = { userId, transactionType: "card" };
        query["metadata.cardId"] = targetCardId;
        const txns = await Transaction_1.default.find(query)
            .sort({ createdAt: -1 })
            .limit(5)
            .lean();
        if (!txns.length) {
            await bot.sendMessage(chatId, "No card transactions found yet.", { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
            return;
        }
        const lines = ["📄 Recent Card Transactions", ""];
        for (const t of txns) {
            const meta = t.metadata || {};
            const direction = meta.direction === "debit" ? "-" : "+";
            const amount = `${direction}${Number(t.amount || 0).toFixed(2)}`;
            const currency = t.currency || "USD";
            const desc = meta.description || "Card transaction";
            lines.push(`${amount} ${currency}  ${desc}`);
        }
        await bot.sendMessage(chatId, lines.join("\n"), { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
    }
    catch (err) {
        await sendFriendlyError(chatId, err?.requestId);
    }
}
function extractCardTransactions(payload) {
    if (!payload)
        return [];
    if (Array.isArray(payload))
        return payload;
    const candidates = [
        payload?.data?.transactions,
        payload?.data?.data,
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
    const description = item?.description || item?.merchant || item?.merchant_name || item?.narration;
    const currency = item?.currency || item?.ccy || item?.iso_currency;
    const statusRaw = item?.status || item?.state || item?.result;
    const txnId = item?.transactionId || item?.transaction_id || item?.id || item?.ref || item?.reference;
    const directionRaw = item?.direction || item?.type || item?.transaction_type || item?.drCr;
    const direction = normalizeTxnDirection(directionRaw, amount);
    return {
        transactionNumber: txnId ? String(txnId) : undefined,
        amount,
        currency,
        description,
        status: normalizeTxnStatus(statusRaw),
        direction,
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
                },
                responseData: item,
            },
        }, { upsert: true, new: true });
    }
}
async function handleFreezeAction(chatId, cardId, action) {
    try {
        await callStroWallet("action/status", "post", { action, card_id: cardId });
        await Card_1.default.findOneAndUpdate({ cardId }, { $set: { status: action === "freeze" ? "frozen" : "active", lastSync: new Date() } }, { new: true });
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
    const cardNumber = detail?.card_number || detail?.cardNumber;
    const cvc = detail?.cvc;
    const lines = [
        `💳 ${name}${brand ? ` (${brand})` : ""}`,
        `ID: ${cardId}${last4 ? ` (••••${last4})` : ""}`,
        cardNumber ? `Number: ${cardNumber}` : undefined,
        cvc ? `CVC: ${cvc}` : undefined,
        `Status: ${status}`,
        balance ? `Balance: ${balance}${currency ? ` ${currency}` : ""}` : undefined,
    ].filter(Boolean);
    return lines.join("\n");
}
async function callStroWallet(path, method, data, options) {
    // Short-circuit problematic endpoints with synthetic responses
    if (path === "fetch-card-detail") {
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
        const message = e?.response?.data?.error || e?.message || "Request failed";
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
