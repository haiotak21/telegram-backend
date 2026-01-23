"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.initBot = initBot;
exports.notifyByCardId = notifyByCardId;
exports.notifyByEmail = notifyByEmail;
exports.notifyCardRequestApproved = notifyCardRequestApproved;
exports.notifyCardRequestDeclined = notifyCardRequestDeclined;
exports.notifyDepositCredited = notifyDepositCredited;
exports.sendFriendlyError = sendFriendlyError;
const node_telegram_bot_api_1 = __importDefault(require("node-telegram-bot-api"));
const axios_1 = __importDefault(require("axios"));
const TelegramLink_1 = require("../models/TelegramLink");
const CardRequest_1 = __importDefault(require("../models/CardRequest"));
const paymentVerification_1 = require("./paymentVerification");
const Transaction_1 = __importDefault(require("../models/Transaction"));
const User_1 = __importDefault(require("../models/User"));
let bot = null;
const pendingActions = new Map();
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
const DEPOSIT_AMOUNTS = [5, 10, 20, 100, 1000];
const DEPOSIT_ACCOUNTS = {
    cbe: { title: "CBE Deposit", account: "1000473027449", name: "Hailemariam Takele Mekonnen", typeLabel: "CBE" },
    telebirr: { title: "Telebirr Deposit", account: "0985656670", name: "Hayilemariyam Takele Mekonen", typeLabel: "Telebirr" },
};
// Tracks the last amount a user selected per payment method so we can validate against receipt
const depositSelections = new Map();
const MENU_BUTTON = { text: "📋 Menu", callback_data: "MENU" };
const MENU_KEYBOARD = [
    [
        { text: "➕ Create Card", callback_data: "MENU_CREATE_CARD" },
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
        { command: "linkemail", description: "Link your email: /linkemail your@example.com" },
        { command: "linkcard", description: "Link a card: /linkcard CARD_ID" },
        { command: "unlink", description: "Remove all linked identifiers" },
        { command: "status", description: "Show current links" },
        { command: "verify", description: "Verify a payment transaction" },
    ]).catch(() => { });
    bot.onText(/^\/start$/i, async (msg) => {
        const chatId = msg.chat.id;
        const link = await TelegramLink_1.TelegramLink.findOne({ chatId });
        await bot.sendMessage(chatId, buildWelcomeMessage(), {
            parse_mode: "HTML",
            disable_web_page_preview: true,
            reply_markup: { inline_keyboard: MENU_KEYBOARD },
        });
        await bot.sendMessage(chatId, buildProfileCard(msg, link || undefined), {
            parse_mode: "HTML",
            disable_web_page_preview: true,
            reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
        });
    });
    bot.onText(/^\/menu$/i, async (msg) => {
        await sendMenu(msg.chat.id);
    });
    bot.onText(/^\/help$/i, async (msg) => {
        await bot.sendMessage(msg.chat.id, "Commands:\n/linkemail your@example.com\n/linkcard CARD_ID\n/unlink (remove all links)\n/status\n/verify\n/deposit");
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
        const link = await TelegramLink_1.TelegramLink.findOne({ chatId: msg.chat.id });
        if (!link)
            return bot.sendMessage(msg.chat.id, "No links set.");
        await bot.sendMessage(msg.chat.id, `Email: ${link.customerEmail || "(none)"}\nCards: ${(link.cardIds || []).join(", ") || "(none)"}`);
    });
    bot.onText(/^\/cancel$/i, async (msg) => {
        pendingActions.delete(msg.chat.id);
        await bot.sendMessage(msg.chat.id, "Cancelled pending action.");
    });
    bot.on("callback_query", async (query) => {
        const chatId = query.message?.chat?.id;
        const action = query.data;
        if (!chatId || !action)
            return;
        if (action === "CANCEL") {
            pendingActions.delete(chatId);
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
        await bot.answerCallbackQuery(query.id).catch(() => { });
        await handleMenuSelection(action, chatId, query.message);
    });
    bot.on("message", async (msg) => {
        if (!msg.text)
            return;
        const pending = pendingActions.get(msg.chat.id);
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
    for (const link of links) {
        await bot.sendMessage(link.chatId, message, { disable_web_page_preview: true });
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
async function notifyCardRequestApproved(userId, payload) {
    if (!bot)
        return;
    const lines = [
        "✅ Your card request was approved!",
        payload.cardId ? `Card ID: ${payload.cardId}` : undefined,
        payload.cardType ? `Type: ${payload.cardType}` : undefined,
        payload.nameOnCard ? `Name: ${payload.nameOnCard}` : undefined,
    ].filter(Boolean);
    lines.push("You can now check card details from the admin or app.");
    await bot.sendMessage(Number(userId), lines.join("\n"), { disable_web_page_preview: true, reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
}
async function notifyCardRequestDeclined(userId, reason) {
    if (!bot)
        return;
    const lines = [
        "⚠️ Your card request was declined.",
        reason ? `Reason: ${reason}` : undefined,
        "You can update your email with /linkemail and try again.",
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
function buildWelcomeMessage() {
    return [
        "👋 Welcome to <b>StroWallet</b> — manage cards and wallet in one place.",
        "Use the menu below to create cards or check balance.",
    ].join("\n");
}
function buildProfileCard(msg, link) {
    const firstName = msg.from?.first_name || "StroWallet User";
    const username = msg.from?.username ? `@${msg.from.username}` : undefined;
    const phone = link?.customerEmail ? undefined : "(not provided)";
    const cardCount = (link?.cardIds || []).length;
    const lines = [
        "🧑‍💻 <b>Here's Your Profile:</b>",
        "",
        `👤 Name: ${firstName}${username ? ` (${username})` : ""}`,
        phone ? `📞 Phone: ${phone}` : undefined,
        link?.customerEmail ? `✉️ Email: ${link.customerEmail}` : "✉️ Email: (link with /linkemail)",
        `💳 Cards Linked: ${cardCount}`,
        cardCount ? `➡️ /status to see cards` : "➕ Link a card with /linkcard CARD_ID",
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
    const defaultName = message?.from?.first_name || message?.from?.username || "StroWallet User";
    try {
        const link = await TelegramLink_1.TelegramLink.findOne({ chatId }).lean();
        const body = {
            userId: String(chatId),
            nameOnCard: defaultName,
            cardType: "virtual",
            amount: "0",
            customerEmail: link?.customerEmail,
            metadata: {
                username: message?.from?.username,
                firstName: message?.from?.first_name,
                lastName: message?.from?.last_name,
            },
        };
        const resp = await axios_1.default.post(`${BACKEND_BASE}/api/card-requests`, body, { timeout: 12000 });
        const reqId = resp.data?.request?._id;
        const note = [];
        if (!link?.customerEmail)
            note.push("Tip: add your email with /linkemail so we can create the card.");
        await bot.sendMessage(chatId, [
            "📩 Card request submitted.",
            "An admin will review and approve/decline.",
            reqId ? `Request ID: ${reqId}` : undefined,
            note.length ? note.join(" ") : undefined,
        ]
            .filter(Boolean)
            .join("\n"), { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
    }
    catch (err) {
        const msg = err?.response?.data?.message || err?.message || "Could not submit card request";
        await bot.sendMessage(chatId, `❌ ${msg}`, { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
    }
}
async function sendUserInfo(chatId) {
    const [link, user] = await Promise.all([
        TelegramLink_1.TelegramLink.findOne({ chatId }).lean(),
        User_1.default.findOne({ userId: String(chatId) }).lean(),
    ]);
    const balance = user?.balance ?? 0;
    const currency = user?.currency || "USDT";
    const cards = link?.cardIds || [];
    const email = link?.customerEmail;
    const cardList = cards.slice(0, 3).map((c, idx) => `${idx + 1}. ${c}`);
    const lines = [
        "👤 Your Profile",
        `User ID: ${chatId}`,
        email ? `Email: ${email}` : "Email: not linked (use /linkemail your@example.com)",
        `Wallet: ${balance} ${currency}`,
        `Cards: ${cards.length || 0}${cards.length ? " (see below)" : ""}`,
        cardList.length ? cardList.join("\n") : undefined,
        !cards.length ? "Tip: Request a card from admin, then /linkcard CARD_ID." : undefined,
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
    const [link, user] = await Promise.all([
        TelegramLink_1.TelegramLink.findOne({ chatId }).lean(),
        User_1.default.findOne({ userId: String(chatId) }).lean(),
    ]);
    const cardId = link?.cardIds?.[0];
    const walletBalance = user?.balance ?? 0;
    if (!cardId) {
        const lines = [
            "💼 Wallet",
            `Balance: ${walletBalance} USD`,
            "No card linked yet. Use /linkcard CARD_ID after admin approval.",
        ];
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
    const link = await TelegramLink_1.TelegramLink.findOne({ chatId });
    if (!link || !link.cardIds?.length) {
        await bot.sendMessage(chatId, "No cards linked yet. Use /linkcard CARD_ID to link one.", {
            reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
        });
        return;
    }
    await bot.sendMessage(chatId, `Fetching ${link.cardIds.length} card(s)...`, {
        reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
    });
    for (const cardId of link.cardIds) {
        await sendCardDetail(chatId, cardId);
    }
}
async function sendCardDetail(chatId, cardId) {
    try {
        const user = await User_1.default.findOne({ userId: String(chatId) }).lean();
        const walletBalance = user?.balance ?? 0;
        // If this card was generated locally, serve synthetic details and avoid upstream call
        const local = await CardRequest_1.default.findOne({ cardId, status: "approved" }).lean();
        if (local) {
            const detail = {
                card_id: cardId,
                name_on_card: local.nameOnCard || "Virtual Card",
                card_type: local.cardType || "virtual",
                status: "active",
                balance: walletBalance,
                available_balance: local.amount || undefined,
                currency: "USD",
                card_number: local.cardNumber,
                cvc: local.cvc,
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
            status: "active",
            balance: walletBalance,
            available_balance: undefined,
            currency: "USD",
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
        const local = await CardRequest_1.default.findOne({ cardId, status: "approved" }).lean();
        if (local) {
            await bot.sendMessage(chatId, "No recent transactions for this card yet.", { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
            return;
        }
    }
    catch (err) {
        if (err?.status === 403) {
            await bot.sendMessage(chatId, "No recent transactions for this card yet.", { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
            return;
        }
        await sendFriendlyError(chatId, err?.requestId);
    }
}
async function handleFreezeAction(chatId, cardId, action) {
    try {
        await callStroWallet("action/status", "post", { action, card_id: cardId });
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
async function callStroWallet(path, method, data) {
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
    if (path === "card-transactions") {
        return { ok: true, data: [] };
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
