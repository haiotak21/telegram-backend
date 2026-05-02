import TelegramBot, { InlineKeyboardButton } from "node-telegram-bot-api";
import os from "os";
import crypto from "crypto";
import axios from "axios";
import sharp from "sharp";
import path from "path";
import mongoose from "mongoose";
import { promises as fs } from "fs";
import { v2 as cloudinary } from "cloudinary";
import { TelegramLink, ITelegramLink } from "../models/TelegramLink";
import BotLock from "../models/BotLock";
import CardRequest from "../models/CardRequest";
import Card from "../models/Card";
import { verifyPayment } from "./paymentVerification";
import Transaction from "../models/Transaction";
import User from "../models/User";
import Customer from "../models/Customer";
import type { PaymentMethod } from "./paymentVerification";
import { loadPricingConfig, quoteDeposit } from "./pricingService";
import { creditVerifiedDeposit } from "./depositService";
import prisma from "../utils/prisma";
import { isPrismaPersistenceEnabled } from "../utils/persistence";

let bot: TelegramBot | null = null;
type PendingAction =
  | { type: "email" }
  | { type: "card" }
  | { type: "verify"; method: PaymentMethod; expectedAmount?: number }
  | { type: "deposit_amount"; method: PaymentMethod }
  | { type: "deposit_convert_amount" }
  | { type: "card_request_verify"; method: PaymentMethod };
const pendingActions = new Map<string, PendingAction>();

function chatKey(value: number | string | undefined): string | null {
  return value != null ? String(value) : null;
}

function clearPendingAction(value: number | string | undefined) {
  const key = chatKey(value);
  if (key) pendingActions.delete(key);
}

type KycIdType = "NIN" | "PASSPORT" | "DRIVING_LICENSE";
type KycStep =
  | "firstName"
  | "lastName"
  | "dateOfBirth"
  | "phoneNumber"
  | "customerEmail"
  | "line1"
  | "city"
  | "state"
  | "zipCode"
  | "country"
  | "houseNumber"
  | "idType"
  | "idNumber"
  | "idImage"
  | "idImageFront"
  | "idImageBack"
  | "userPhoto"
  | "confirm";

type KycStatus = "not_started" | "pending" | "approved" | "rejected";

type CreateCardStep = "name" | "type" | "amount" | "confirm";
interface CreateCardSession {
  step: CreateCardStep;
  data: {
    nameOnCard?: string;
    cardType?: "visa" | "mastercard";
    amount?: string;
  };
}
const createCardSessions = new Map<number, CreateCardSession>();

interface KycData {
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  phoneNumber: string;
  customerEmail: string;
  line1: string;
  city: string;
  state: string;
  zipCode: string;
  country: string;
  houseNumber: string;
  idType: KycIdType;
  idNumber: string;
  idImage: string;
  idImageFront?: string;
  idImageBack?: string;
  idImagePdf?: string;
  userPhoto: string;
}

interface KycSession {
  step: KycStep;
  data: Partial<KycData>;
  mode: "create" | "edit";
  lastPromptStep?: KycStep;
}

const kycSessions = new Map<number, KycSession>();
const KYC_ID_TYPES: { label: string; value: KycIdType }[] = [
  { label: "National ID (NIN)", value: "NIN" },
  { label: "Passport", value: "PASSPORT" },
  { label: "Driving License", value: "DRIVING_LICENSE" },
];
const KYC_PHONE_REGEX = /^[1-9]\d{10,14}$/;
const KYC_DOB_REGEX = /^\d{2}\/\d{2}\/\d{4}$/;
const KYC_STATIC_COUNTRY = process.env.KYC_STATIC_COUNTRY || "Ghana";
const KYC_STATIC_STATE = process.env.KYC_STATIC_STATE || "Accra";
const KYC_STATIC_CITY = process.env.KYC_STATIC_CITY || "Accra";
const KYC_STATIC_IDTYPE = (process.env.KYC_STATIC_IDTYPE || "PASSPORT") as KycIdType;

const WALLET_URL = process.env.WALLET_URL || "https://strowallet.com/app";
const SUPPORT_URL = process.env.SUPPORT_URL || "https://t.me/Bunacardsupport";
const NEWS_URL = process.env.NEWS_URL || "https://t.me/paytelegram082";
const API_BASE = process.env.BOT_API_BASE || "http://localhost:3000/api/strowallet/";
const BACKEND_BASE = process.env.BOT_BACKEND_BASE || "http://localhost:3000";
const EXPECTED_RECEIVER_NAME = (process.env.RECEIVER_NAME || process.env.CBE_RECEIVER_NAME || "Addisu melke admasu").trim();
const EXPECTED_TELEBIRR_NAME = (process.env.TELEBIRR_RECEIVER_NAME || "Addisu melke admasu").trim();
const CBE_STRICT_RECEIVER = String(process.env.CBE_STRICT_RECEIVER || "true").toLowerCase() === "true";
const TELEBIRR_STRICT_RECEIVER = String(process.env.TELEBIRR_STRICT_RECEIVER || "true").toLowerCase() === "true";
const EXPECTED_TELEBIRR_PHONE = (process.env.TELEBIRR_PHONE_NUMBER || "0910840397").trim();
const EXPECTED_CBE_ACCOUNT = (process.env.CBE_ACCOUNT_NUMBER || "1000139256208").trim();

function getDefaultMode() {
  return process.env.STROWALLET_DEFAULT_MODE || (process.env.NODE_ENV !== "production" ? "sandbox" : undefined);
}

function normalizeMode(mode?: string) {
  if (!mode) return undefined;
  const m = String(mode).toLowerCase();
  if (m === "live") return undefined;
  return m;
}

const MIN_DEPOSIT_ETB = 1000;
const DEPOSIT_AMOUNTS = [1000, 2000, 3000, 5000, 10000];
const DEPOSIT_ACCOUNTS: Record<PaymentMethod, { title: string; account: string; name: string; typeLabel: string }> = {
  cbe: { title: "CBE Deposit", account: "1000139256208", name: "Addisu melke admasu", typeLabel: "CBE" },
  telebirr: { title: "Telebirr Deposit", account: "0910840397", name: "Addisu melke admasu", typeLabel: "Telebirr" },
};
const CARD_REQUEST_BASE_AMOUNT_ETB = Number(process.env.CARD_REQUEST_BASE_AMOUNT_ETB || 3);
const BOT_LOCK_KEY = "telegram-bot";
const BOT_LOCK_TTL_MS = Number(process.env.TELEGRAM_BOT_LOCK_TTL_MS || 90000);
const TELEGRAM_BOT_USE_DB_LOCK = String(process.env.TELEGRAM_BOT_USE_DB_LOCK ?? "true").toLowerCase() !== "false";
const STROWALLET_LOW_BALANCE_THRESHOLD_USD = Number(process.env.STROWALLET_LOW_BALANCE_THRESHOLD_USD || 50);
const STROWALLET_LOW_BALANCE_ALERT_CHAT_ID = (process.env.STROWALLET_LOW_BALANCE_ALERT_CHAT_ID || "504201714").trim();
const STROWALLET_LOW_BALANCE_ALERT_COOLDOWN_MS = Number(process.env.STROWALLET_LOW_BALANCE_ALERT_COOLDOWN_MS || 900000);
const BOT_DEPOSIT_FIXED_FEE_USD = Number(process.env.BOT_DEPOSIT_FIXED_FEE_USD || 1.9);
const BOT_DEPOSIT_PERCENT_FEE = Number(process.env.BOT_DEPOSIT_PERCENT_FEE || 1.9);
let lastLowBalanceAlertAt = 0;

function isLowBalanceErrorMessage(message?: string) {
  const m = String(message || "").toLowerCase();
  return (
    m.includes("insufficient balance") ||
    m.includes("not enough balance") ||
    m.includes("low balance") ||
    m.includes("insufficient wallet")
  );
}

async function notifyAdminLowBalanceIssue(detail?: string) {
  if (!bot) return;
  const now = Date.now();
  if (now - lastLowBalanceAlertAt < STROWALLET_LOW_BALANCE_ALERT_COOLDOWN_MS) return;
  lastLowBalanceAlertAt = now;

  const lines = [
    "⚠️ StroWallet balance issue detected",
    "Users may have delayed card provisioning due to provider balance.",
    detail ? `Detail: ${detail}` : undefined,
    `Time: ${new Date().toISOString()}`,
  ].filter(Boolean) as string[];

  try {
    const targetChat: any = /^-?\d+$/.test(STROWALLET_LOW_BALANCE_ALERT_CHAT_ID)
      ? Number(STROWALLET_LOW_BALANCE_ALERT_CHAT_ID)
      : STROWALLET_LOW_BALANCE_ALERT_CHAT_ID;
    await bot.sendMessage(targetChat, lines.join("\n"), {
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
    });
  } catch (e) {
    console.error("[bot] Failed to send admin low balance alert", e);
  }
}

// Tracks the last amount a user selected per payment method so we can validate against receipt
const depositSelections = new Map<number, {
  method: PaymentMethod;
  amountEtb: number;
  creditAmountEtb: number;
  amountUsd: number;
  feeUsd: number;
  totalUsd: number;
  totalEtb: number;
  rate: number;
}>();
const depositConversionSelections = new Map<number, {
  requestedUsd: number;
  creditAmountEtb: number;
  feeUsd: number;
  totalUsd: number;
  totalEtb: number;
  rate: number;
}>();
const cardRequestSelections = new Map<number, {
  cardAmountUsd: number;
  feeUsd: number;
  totalUsd: number;
  totalEtb: number;
  rate: number;
}>();
const recentCallbackActions = new Map<number, { action: string; at: number }>();
const recentOutgoing = new Map<number, { key: string; at: number }>();
const recentUpdates = new Map<string, number>();

function isMongoReady() {
  return mongoose.connection.readyState === 1;
}

function isPrismaOnlyMode() {
  return isPrismaPersistenceEnabled() && !isMongoReady();
}

async function upsertTelegramIdentity(msg: any) {
  const telegramId = msg?.from?.id != null ? String(msg.from.id) : undefined;
  const chatId = msg?.chat?.id != null ? String(msg.chat.id) : undefined;
  if (!telegramId || !chatId) return;
  const username = msg?.from?.username ? String(msg.from.username) : undefined;
  if (isPrismaPersistenceEnabled()) {
    await prisma.user.upsert({
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
  await User.findOneAndUpdate(
    { $or: [{ telegramId }, { userId: telegramId }] },
    {
      $set: {
        telegramId,
        chatId,
        username,
      },
      $setOnInsert: {
        userId: telegramId,
      },
    },
    { upsert: true, new: true }
  );
}

async function findUserForChat(chatId: number | string) {
  const userId = String(chatId);
  if (isPrismaPersistenceEnabled()) {
    return prisma.user.findUnique({ where: { userId } });
  }
  return User.findOne({ userId }).lean();
}

async function findActiveCardsForUser(userId: string) {
  if (isPrismaPersistenceEnabled()) {
    const user = await prisma.user.findUnique({ where: { userId } });
    const customerEmail = user?.customerEmail || undefined;
    return prisma.card.findMany({
      where: {
        OR: [{ userId }, ...(customerEmail ? [{ customerEmail }] : [])],
        status: { in: ["active", "ACTIVE", "frozen", "FROZEN"] },
      },
      orderBy: { updatedAt: "desc" },
    });
  }
  return Card.find({ userId, status: { $in: ["active", "ACTIVE", "frozen", "FROZEN"] } }).lean();
}

async function getUserAndCustomerContext(userId: string) {
  if (isPrismaPersistenceEnabled()) {
    const user = await prisma.user.findUnique({ where: { userId } });
    const customer = user
      ? {
          userId,
          email: user.customerEmail,
          kycStatus: user.kycStatus,
        }
      : null;
    return { user, customer };
  }
  const [user, customer] = await Promise.all([
    User.findOne({ userId }).lean(),
    Customer.findOne({ userId }).lean(),
  ]);
  return { user, customer };
}

const MENU_BUTTON: InlineKeyboardButton = { text: "📋 Menu", callback_data: "MENU" };
const MENU_KEYBOARD: InlineKeyboardButton[][] = [
  [
    { text: "➕ Request Card", callback_data: "MENU_CREATE_CARD" },
    { text: "💳 My Cards", callback_data: "MENU_MY_CARDS" },
  ],
  [{ text: "💰 Deposit", callback_data: "MENU_DEPOSIT" }],
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

export async function initBot() {
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
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    cpus: os.cpus().length,
    totalmem: Math.round(os.totalmem() / 1024 / 1024 / 1024) + " GB",
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
  const activeToken = token!;
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
  const useDbLock = TELEGRAM_BOT_USE_DB_LOCK && mongoose.connection.readyState === 1;
  if (!useDbLock) {
    console.warn("Telegram bot DB lock disabled or Mongo unavailable; starting without distributed lock.");
  } else {
    hasLock = await acquireBotLock(lockOwner, BOT_LOCK_TTL_MS);
    if (!hasLock) {
      console.warn("Telegram bot lock not acquired; another instance is active.");
      return;
    }
  }

  const botRef = new TelegramBot(activeToken, { polling: false });
  await (botRef as any).deleteWebHook({ drop_pending_updates: true }).catch(() => {});
  botRef.on("polling_error", (err: any) => {
    console.error("Telegram polling error:", err);
  });
  await (botRef as any).startPolling();
  bot = botRef;
  console.log("Telegram bot started");
  (botRef as any).getMe().then((me: any) => {
    console.log(`Telegram bot identity: @${me.username} (${me.id})`);
  }).catch(() => { });
  if (useDbLock) {
    startBotLockHeartbeat(lockOwner, botRef, BOT_LOCK_TTL_MS);
  }

  botRef.setMyCommands([
    { command: "start", description: "Show welcome message" },
    { command: "menu", description: "Show main menu" },
    { command: "help", description: "Show available commands" },
    { command: "kyc", description: "Submit KYC verification" },
    { command: "kyc_status", description: "Check your KYC status" },
    { command: "kyc_edit", description: "Edit and resubmit KYC" },
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

  botRef.onText(/^\/start(?:@[\w_]+)?(?:\s+.*)?$/i, async (msg: any) => {
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
        await bot!.sendMessage(chatId, buildWelcomeMessage(), {
          parse_mode: "HTML",
          disable_web_page_preview: true,
          reply_markup: { inline_keyboard: MENU_KEYBOARD },
        });
      } else {
        await bot!.sendMessage(chatId, "Main menu", {
          disable_web_page_preview: true,
          reply_markup: { inline_keyboard: MENU_KEYBOARD },
        });
      }
    } catch (err) {
      console.error("Failed to respond to /start", { chatId, err });
    }
  });

  botRef.onText(/^\/menu$/i, async (msg: any) => {
    if (shouldSkipCommand(msg, "menu", 4000)) return;
    await sendMenu(msg.chat.id);
  });

  botRef.onText(/^\/help$/i, async (msg: any) => {
    if (shouldSkipCommand(msg, "help")) return;
    await bot!.sendMessage(
      msg.chat.id,
      "Commands:\n/kyc\n/kyc_status\n/kyc_edit\n/card_request\n/requestcard\n/mycard\n/cardstatus\n/transactions\n/freeze\n/unfreeze\n/linkemail your@example.com\n/linkcard CARD_ID\n/unlink (remove all links)\n/status\n/verify\n/deposit"
    );
  });

  botRef.onText(/^\/deposit$/i, async (msg: any) => {
    if (shouldSkipCommand(msg, "deposit")) return;
    await sendDepositInfo(msg.chat.id);
  });

  botRef.onText(/^\/verify$/i, async (msg: any) => {
    if (shouldSkipCommand(msg, "verify")) return;
    const chatId = msg.chat.id;
    await bot!.sendMessage(chatId, "Choose payment method to verify:", {
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

  botRef.onText(/^\/kyc_status$/i, async (msg: any) => {
    const chatId = msg.chat.id;
    await sendKycStatus(chatId);
  });

  botRef.onText(/^\/requestcard$/i, async (msg: any) => {
    if (shouldSkipCommand(msg, "requestcard")) return;
    const chatId = msg.chat.id;
    await handleCardRequest(chatId, msg);
  });

  botRef.onText(/^\/mycard(s)?$/i, async (msg: any) => {
    if (shouldSkipCommand(msg, "mycard")) return;
    return sendMyCards(msg.chat.id, msg);
  });

  botRef.onText(/^\/cardstatus$/i, async (msg: any) => {
    if (shouldSkipCommand(msg, "cardstatus")) return;
    return sendCardStatus(msg.chat.id);
  });

  botRef.onText(/^\/transactions$/i, async (msg: any) => {
    if (shouldSkipCommand(msg, "transactions")) return;
    const chatId = msg.chat.id;
    await sendCardTransactions(chatId);
  });

  botRef.onText(/^\/(freeze|unfreeze)$/i, async (msg: any, match?: RegExpExecArray | null) => {
    if (shouldSkipCommand(msg, "freeze_toggle")) return;
    const action = match?.[1] === "unfreeze" ? "unfreeze" : "freeze";
    const card = await getPrimaryCardForUser(String(msg.chat.id));
    if (!card?.cardId) {
      await bot!.sendMessage(msg.chat.id, "❌ No cards linked yet.", { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
      return;
    }
    await handleFreezeAction(msg.chat.id, card.cardId, action);
  });

  botRef.onText(/^\/card_request$/i, async (msg: any) => {
    if (shouldSkipCommand(msg, "card_request")) return;
    const chatId = msg.chat.id;
    await handleCardRequest(chatId, msg);
  });

  botRef.onText(/^\/kyc$/i, async (msg: any) => {
    if (shouldSkipCommand(msg, "kyc")) return;
    const chatId = msg.chat.id;
    const { user, customer } = await getUserAndCustomerContext(String(chatId));
    const status = resolveKycStatus(user, customer);
    if (status === "pending") {
      await bot!.sendMessage(chatId, "✅ KYC already submitted. Status: pending verification.", {
        reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
      });
      return;
    }
    if (status === "approved") {
      await bot!.sendMessage(chatId, "✅ KYC already approved.", {
        reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
      });
      return;
    }
    if (status === "rejected") {
      await bot!.sendMessage(chatId, "❌ Your KYC was rejected. Use /kyc_edit to resubmit.", {
        reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
      });
      return;
    }
    await startKycFlow(chatId, msg, "create");
  });

  botRef.onText(/^\/kyc_edit$/i, async (msg: any) => {
    if (shouldSkipCommand(msg, "kyc_edit")) return;
    const chatId = msg.chat.id;
    const { user, customer } = await getUserAndCustomerContext(String(chatId));
    const status = resolveKycStatus(user, customer);
    if (status === "not_started") {
      await bot!.sendMessage(chatId, "No KYC record found. Use /kyc to submit.", {
        reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
      });
      return;
    }
    if (status === "approved") {
      await bot!.sendMessage(chatId, "✅ KYC already approved. No edits required.", {
        reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
      });
      return;
    }
    if (status === "pending") {
      await bot!.sendMessage(chatId, "⏳ KYC is pending verification. Please wait for approval.", {
        reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
      });
      return;
    }
    await startKycFlow(chatId, msg, "edit", user);
  });

  botRef.onText(/^\/linkemail(?:\s+([^\s]+))?$/i, async (msg: any, match?: RegExpExecArray | null) => {
    if (shouldSkipCommand(msg, "linkemail")) return;
    const email = match?.[1];
    if (!email) {
      const key = chatKey(msg.chat.id);
      if (!key) return;
      pendingActions.set(key, { type: "email" });
      return bot!.sendMessage(msg.chat.id, "Please send your email now (or /cancel):", {
        reply_markup: { force_reply: true },
      });
    }
    const up = await TelegramLink.findOneAndUpdate(
      { chatId: msg.chat.id },
      { $set: { customerEmail: email } },
      { new: true, upsert: true }
    );
    await bot!.sendMessage(msg.chat.id, `Linked email ${email}.`);
  });

  botRef.onText(/^\/linkcard(?:\s+([^\s]+))?$/i, async (msg: any, match?: RegExpExecArray | null) => {
    if (shouldSkipCommand(msg, "linkcard")) return;
    const cardId = match?.[1];
    if (!cardId) {
      const key = chatKey(msg.chat.id);
      if (!key) return;
      pendingActions.set(key, { type: "card" });
      return bot!.sendMessage(msg.chat.id, "Please send the CARD_ID now (or /cancel):", {
        reply_markup: { force_reply: true },
      });
    }
    const up = await TelegramLink.findOneAndUpdate(
      { chatId: msg.chat.id },
      { $addToSet: { cardIds: cardId } },
      { new: true, upsert: true }
    );
    await bot!.sendMessage(msg.chat.id, `Linked card ${cardId}.`);
  });

  botRef.onText(/^\/unlink$/i, async (msg: any) => {
    if (shouldSkipCommand(msg, "unlink")) return;
    await TelegramLink.findOneAndUpdate({ chatId: msg.chat.id }, { $set: { customerEmail: undefined, cardIds: [] } }, { upsert: true });
    await bot!.sendMessage(msg.chat.id, "All links removed.");
  });

  botRef.onText(/^\/status$/i, async (msg: any) => {
    if (shouldSkipCommand(msg, "status")) return;
    const [link, cards] = await Promise.all([
      isPrismaOnlyMode() ? Promise.resolve(null) : TelegramLink.findOne({ chatId: msg.chat.id }).lean(),
      findActiveCardsForUser(String(msg.chat.id)),
    ]);
    const cardLabels = cards.map((c: any) => `${c.cardId}${c.last4 ? ` (••••${c.last4})` : ""}`);
    await bot!.sendMessage(
      msg.chat.id,
      `Email: ${link?.customerEmail || "(none)"}\nCards: ${cardLabels.join(", ") || "(none)"}`
    );
  });

  botRef.onText(/^\/cancel$/i, async (msg: any) => {
    if (shouldSkipCommand(msg, "cancel")) return;
    clearPendingAction(msg.chat.id);
    cardRequestSelections.delete(msg.chat.id);
    kycSessions.delete(msg.chat.id);
    createCardSessions.delete(msg.chat.id);
    await bot!.sendMessage(msg.chat.id, "Cancelled pending action.");
  });

  botRef.on("callback_query", async (query: any) => {
    const chatId = query.message?.chat?.id;
    const action = query.data as string | undefined;
    if (!chatId || !action) return;

    const callbackKey = query.id ? `cb:${query.id}` : `cb:${chatId}:${action}`;
    if (isDuplicateUpdate(callbackKey, 20000)) {
      await bot!.answerCallbackQuery(query.id).catch(() => {});
      return;
    }

    const now = Date.now();
    const last = recentCallbackActions.get(chatId);
    if (last && last.action === action && now - last.at < 1500) {
      await bot!.answerCallbackQuery(query.id).catch(() => { });
      return;
    }
    recentCallbackActions.set(chatId, { action, at: now });

    if (action.startsWith("KYC_IDTYPE::")) {
      const idType = action.replace("KYC_IDTYPE::", "") as KycIdType;
      const session = kycSessions.get(chatId);
      if (!session || session.step !== "idType") {
        await bot!.answerCallbackQuery(query.id, { text: "KYC session not active" }).catch(() => { });
        return;
      }
      if (!KYC_ID_TYPES.find((t) => t.value === idType)) {
        await bot!.answerCallbackQuery(query.id, { text: "Invalid ID type" }).catch(() => { });
        return;
      }
      session.data.idType = idType;
      session.step = "idNumber";
      kycSessions.set(chatId, session);
      await bot!.answerCallbackQuery(query.id).catch(() => { });
      await bot!.sendMessage(chatId, "Enter your ID number:", { reply_markup: { force_reply: true } });
      return;
    }

    if (action.startsWith("KYC_CONFIRM::")) {
      const decision = action.replace("KYC_CONFIRM::", "");
      const session = kycSessions.get(chatId);
      if (!session || session.step !== "confirm") {
        await bot!.answerCallbackQuery(query.id, { text: "KYC session not active" }).catch(() => { });
        return;
      }
      await bot!.answerCallbackQuery(query.id).catch(() => { });
      if (decision === "yes") {
        await submitKyc(chatId, session);
      } else {
        kycSessions.delete(chatId);
        await bot!.sendMessage(chatId, "KYC submission cancelled.", { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
      }
      return;
    }

    if (action.startsWith("CARD_TYPE::")) {
      const cardType = action.replace("CARD_TYPE::", "") as "visa" | "mastercard";
      const session = createCardSessions.get(chatId);
      if (!session || session.step !== "type") {
        await bot!.answerCallbackQuery(query.id, { text: "Card session not active" }).catch(() => { });
        return;
      }
      if (cardType !== "visa" && cardType !== "mastercard") return;
      session.data.cardType = cardType;
      session.step = "amount";
      createCardSessions.set(chatId, session);
      await bot!.answerCallbackQuery(query.id).catch(() => { });
      await promptCreateCardStep(chatId, session);
      return;
    }

    if (action.startsWith("CARD_AMOUNT::")) {
      const amount = action.replace("CARD_AMOUNT::", "");
      const session = createCardSessions.get(chatId);
      if (!session || session.step !== "amount") {
        await bot!.answerCallbackQuery(query.id, { text: "Card session not active" }).catch(() => { });
        return;
      }
      if (amount === "skip") {
        session.data.amount = "3";
      } else {
        session.data.amount = amount;
      }
      session.step = "confirm";
      createCardSessions.set(chatId, session);
      await bot!.answerCallbackQuery(query.id).catch(() => { });
      await promptCreateCardStep(chatId, session);
      return;
    }

    if (action.startsWith("CARD_CONFIRM::")) {
      const decision = action.replace("CARD_CONFIRM::", "");
      const session = createCardSessions.get(chatId);
      if (!session || session.step !== "confirm") {
        await bot!.answerCallbackQuery(query.id, { text: "Card session not active" }).catch(() => { });
        return;
      }
      await bot!.answerCallbackQuery(query.id).catch(() => { });
      if (decision === "yes") {
        await submitCreateCard(chatId, session);
      } else {
        createCardSessions.delete(chatId);
        await bot!.sendMessage(chatId, "Card creation cancelled.", { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
      }
      return;
    }

    if (action === "CANCEL") {
      clearPendingAction(chatId);
      kycSessions.delete(chatId);
      createCardSessions.delete(chatId);
      await bot!.answerCallbackQuery(query.id, { text: "Cancelled" }).catch(() => { });
      await bot!.sendMessage(chatId, "Cancelled pending action.", { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
      return;
    }

    if (action === "MENU") {
      await bot!.answerCallbackQuery(query.id).catch(() => { });
      return sendMenu(chatId, query.message);
    }

    if (action === "KYC_STATUS") {
      await bot!.answerCallbackQuery(query.id).catch(() => { });
      await sendKycStatus(chatId);
      return;
    }

    if (action === "KYC_START") {
      await bot!.answerCallbackQuery(query.id).catch(() => { });
      await startKycFlow(chatId, query.message);
      return;
    }

    if (action === "CARD_TXN_NO_CARD") {
      await bot!.answerCallbackQuery(query.id).catch(() => { });
      await sendCardTransactions(chatId);
      return;
    }

    if (action === "CARD_FREEZE_NO_CARD") {
      await bot!.answerCallbackQuery(query.id).catch(() => { });
      await bot!.sendMessage(chatId, "No card found. Use /card_request to create your virtual card.", {
        reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
      });
      return;
    }

    if (action === "TXN_BACK_ALL") {
      await bot!.answerCallbackQuery(query.id).catch(() => { });
      await sendCardTransactions(chatId);
      return;
    }

    if (action.startsWith("CARD_REVEAL::")) {
      const cardId = action.replace("CARD_REVEAL::", "");
      await bot!.answerCallbackQuery(query.id).catch(() => { });
      await sendCardRevealPrompt(chatId, cardId);
      return;
    }

    if (action.startsWith("CARD_REVEAL_CONFIRM::")) {
      const cardId = action.replace("CARD_REVEAL_CONFIRM::", "");
      await bot!.answerCallbackQuery(query.id).catch(() => { });
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
      const method = action.replace("VERIFY_METHOD::", "") as PaymentMethod;
      if (method !== "telebirr" && method !== "cbe") return;
      await bot!.answerCallbackQuery(query.id).catch(() => { });
      await startVerificationFlow(chatId, method);
      return;
    }

    if (action.startsWith("DEPOSIT_METHOD::")) {
      const method = action.replace("DEPOSIT_METHOD::", "") as PaymentMethod;
      if (method !== "telebirr" && method !== "cbe") return;
      await bot!.answerCallbackQuery(query.id).catch(() => { });
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
      const method = action.replace("DEPOSIT_CHANGE::", "") as PaymentMethod;
      if (method !== "telebirr" && method !== "cbe") return;
      await bot!.answerCallbackQuery(query.id).catch(() => { });
      depositConversionSelections.delete(chatId);
      await sendDepositAmountSelect(chatId, method);
      return;
    }

    if (action.startsWith("DEPOSIT_AMOUNT::")) {
      const [, methodRaw, amountRaw] = action.split("::");
      const method = methodRaw as PaymentMethod;
      const amount = Number(amountRaw);
      if ((method !== "telebirr" && method !== "cbe") || !Number.isFinite(amount)) return;
      await bot!.answerCallbackQuery(query.id).catch(() => { });
      if (amount < MIN_DEPOSIT_ETB) {
        await bot!.sendMessage(chatId, `Minimum deposit is ${MIN_DEPOSIT_ETB} ETB.`, {
          reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
        });
        return;
      }
      depositConversionSelections.delete(chatId);
      await sendDepositSummary(chatId, method, amount);
      return;
    }

    if (action.startsWith("DEPOSIT_CUSTOM::")) {
      const method = action.replace("DEPOSIT_CUSTOM::", "") as PaymentMethod;
      if (method !== "telebirr" && method !== "cbe") return;
      await bot!.answerCallbackQuery(query.id).catch(() => { });
      {
        const key = chatKey(chatId);
        if (key) pendingActions.set(key, { type: "deposit_amount", method });
      }
      await bot!.sendMessage(chatId, `Enter the amount to deposit via ${method.toUpperCase()} (ETB, minimum ${MIN_DEPOSIT_ETB}).`, {
        reply_markup: { force_reply: true },
      });
      return;
    }

    if (action === "DEPOSIT_CONVERT") {
      await bot!.answerCallbackQuery(query.id).catch(() => { });
      {
        const key = chatKey(chatId);
        if (key) pendingActions.set(key, { type: "deposit_convert_amount" });
      }
      await bot!.sendMessage(chatId, "Enter USD amount to convert (example: 5).", {
        reply_markup: { force_reply: true },
      });
      return;
    }

    if (action.startsWith("DEPOSIT_VERIFY::")) {
      const method = action.replace("DEPOSIT_VERIFY::", "") as PaymentMethod;
      if (method !== "telebirr" && method !== "cbe") return;
      await bot!.answerCallbackQuery(query.id).catch(() => { });

      const selected = depositSelections.get(chatId);
      if (!selected || selected.method !== method || !Number.isFinite(selected.amountEtb) || selected.amountEtb < MIN_DEPOSIT_ETB) {
        await bot!.sendMessage(chatId, "Please select a deposit amount first, then verify payment.", {
          reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
        });
        return;
      }

      await startVerificationFlow(chatId, method);
      return;
    }

    if (action.startsWith("CARDPAY_METHOD::")) {
      const method = action.replace("CARDPAY_METHOD::", "") as PaymentMethod;
      if (method !== "telebirr" && method !== "cbe") return;
      await bot!.answerCallbackQuery(query.id).catch(() => { });
      const selection = cardRequestSelections.get(chatId);
      if (!selection) {
        await bot!.sendMessage(chatId, "Card request payment session expired. Please request a card again.", {
          reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
        });
        return;
      }
      {
        const key = chatKey(chatId);
        if (key) pendingActions.set(key, { type: "card_request_verify", method });
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
      await bot!.sendMessage(chatId, lines.join("\n"), {
        reply_markup: { force_reply: true },
      });
      return;
    }

    await bot!.answerCallbackQuery(query.id).catch(() => { });
    await handleMenuSelection(action, chatId, query.message);
  });

  botRef.on("message", async (msg: any) => {
    const chatId = msg.chat.id;
    console.log("Telegram message received", {
      chatId,
      from: msg.from?.username || msg.from?.id,
      text: msg.text,
    });
    const messageKey = msg.message_id ? `msg:${chatId}:${msg.message_id}` : `msg:${chatId}:${Date.now()}`;
    if (isDuplicateUpdate(messageKey, 20000)) return;
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

    if (!msg.text) return;
    const pendingKey = chatKey(chatId);
    if (!pendingKey) return;
    const pending = pendingActions.get(pendingKey);
    if (!pending) return;
    const text = String(msg.text).trim();
    if (pending.type === "email") {
      const email = text;
      const valid = /.+@.+\..+/.test(email);
      if (!valid) {
        return bot!.sendMessage(msg.chat.id, "Invalid email format. Try again or /cancel.");
      }
      await TelegramLink.findOneAndUpdate(
        { chatId: msg.chat.id },
        { $set: { customerEmail: email } },
        { new: true, upsert: true }
      );
      clearPendingAction(msg.chat.id);
      await bot!.sendMessage(msg.chat.id, `Linked email ${email}.`);
    } else if (pending.type === "card") {
      const cardId = text;
      if (!cardId) {
        return bot!.sendMessage(msg.chat.id, "Card ID cannot be empty. Try again or /cancel.");
      }
      await TelegramLink.findOneAndUpdate(
        { chatId: msg.chat.id },
        { $addToSet: { cardIds: cardId } },
        { new: true, upsert: true }
      );
      clearPendingAction(msg.chat.id);
      await bot!.sendMessage(msg.chat.id, `Linked card ${cardId}.`);
    } else if (pending.type === "verify") {
      const method = pending.method;
      if (!text) {
        return bot!.sendMessage(msg.chat.id, "Transaction number cannot be empty. Try again or /cancel.");
      }
      // Allow users to paste full URLs (e.g., CBE deep links). Extract ?id=... when present.
      let txn = text;
      try {
        if (/^https?:\/\//i.test(text)) {
          const u = new URL(text);
          const id = u.searchParams.get("id");
          if (id) {
            txn = id;
          } else {
            const parts = u.pathname.split("/").filter(Boolean);
            if (parts.length) txn = parts[parts.length - 1];
          }
        }
      } catch { }

      const normalizedTxn = normalizeTxnRef(txn, pending.method);
      try {
        const already = await findUsedPaymentReference(method, normalizedTxn);
        if (already) {
          await bot!.sendMessage(msg.chat.id, "❌ This payment reference has already been used.", { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
          clearPendingAction(msg.chat.id);
          return;
        }

        const result = await verifyPayment({ paymentMethod: method, transactionNumber: normalizedTxn });
        const b = result.body as any;
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
            await bot!.sendMessage(msg.chat.id, notice, { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
            clearPendingAction(msg.chat.id);
            return;
          }
          const rawData = (b.raw?.data ?? b.raw ?? {}) as any;
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
          ].filter(Boolean) as string[];

          // Record verification for idempotency/audit BEFORE sending success message
          try {
            const amountNum = typeof b.amount === "number" ? b.amount : undefined;
            const rawData = (b.raw?.data ?? b.raw ?? {}) as any;
            const verifiedKey = normalizeTxnRef(String(b.transactionNumber || normalizedTxn), method);
            const altKey = normalizeTxnRef(String(rawData?.reference || normalizedTxn), method);
            if (typeof amountNum !== "number" || amountNum <= 0) {
              await bot!.sendMessage(msg.chat.id, "❌ Verification succeeded but amount is missing from receipt.", {
                reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
              });
              clearPendingAction(msg.chat.id);
              return;
            }

            const amountEtb = Number((selected as any)?.creditAmountEtb || amountNum);
            const pricing = await loadPricingConfig();
            const quote = quoteDeposit(amountEtb, pricing);
            const primaryCard = await getPrimaryCardForUser(String(msg.chat.id));
            if (!primaryCard?.cardId) {
              await bot!.sendMessage(
                msg.chat.id,
                "❌ No active card found. Deposit was verified but cannot be applied to a card. Please create a card or contact support.",
                { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } }
              );
              clearPendingAction(msg.chat.id);
              return;
            }

            let providerResponse: any;
            try {
              providerResponse = await callStroWallet("fund-card", "post", {
                card_id: String(primaryCard.cardId),
                amount: toStroAmountString(quote.creditedUsdt),
                mode: normalizeMode(getDefaultMode()),
              });
            } catch (fundErr: any) {
              const reason = fundErr?.message || "Card funding is not available right now.";
              if (isPrismaPersistenceEnabled()) {
                await prisma.transaction.create({
                  data: {
                    userId: String(msg.chat.id),
                    transactionType: "deposit",
                    paymentMethod: method,
                    amount: quote.creditedUsdt,
                    amountEtb,
                    amountUsdt: quote.creditedUsdt,
                    feeEtb: quote.feeEtb,
                    currency: "USDT",
                    rateSnapshot: quote.rate,
                    transactionNumber: verifiedKey,
                    referenceNumber: altKey,
                    status: "failed",
                    verified: true,
                    responseData: { verification: b.raw ?? b, fundError: reason } as any,
                    metadata: { cardId: String(primaryCard.cardId), destination: "card" } as any,
                  },
                });
              } else {
                await Transaction.create({
                  userId: String(msg.chat.id),
                  transactionType: "deposit",
                  paymentMethod: method,
                  amount: quote.creditedUsdt,
                  amountEtb,
                  amountUsdt: quote.creditedUsdt,
                  feeEtb: quote.feeEtb,
                  currency: "USDT",
                  rateSnapshot: quote.rate,
                  transactionNumber: verifiedKey,
                  referenceNumber: altKey,
                  status: "failed",
                  verified: true,
                  responseData: { verification: b.raw ?? b, fundError: reason },
                  metadata: { cardId: String(primaryCard.cardId), destination: "card" },
                });
              }

              await bot!.sendMessage(
                msg.chat.id,
                `❌ Card top-up failed: ${reason}. Your wallet balance was not credited. Please contact support.`,
                { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } }
              );
              clearPendingAction(msg.chat.id);
              return;
            }

            if (isPrismaPersistenceEnabled()) {
              await prisma.transaction.create({
                data: {
                  userId: String(msg.chat.id),
                  transactionType: "deposit",
                  paymentMethod: method,
                  amount: quote.creditedUsdt,
                  amountEtb,
                  amountUsdt: quote.creditedUsdt,
                  feeEtb: quote.feeEtb,
                  currency: "USDT",
                  rateSnapshot: quote.rate,
                  transactionNumber: verifiedKey,
                  referenceNumber: altKey,
                  status: "completed",
                  verified: true,
                  responseData: { verification: b.raw ?? b, fundResponse: providerResponse } as any,
                  metadata: { cardId: String(primaryCard.cardId), destination: "card" } as any,
                },
              });
            } else {
              await Transaction.create({
                userId: String(msg.chat.id),
                transactionType: "deposit",
                paymentMethod: method,
                amount: quote.creditedUsdt,
                amountEtb,
                amountUsdt: quote.creditedUsdt,
                feeEtb: quote.feeEtb,
                currency: "USDT",
                rateSnapshot: quote.rate,
                transactionNumber: verifiedKey,
                referenceNumber: altKey,
                status: "completed",
                verified: true,
                responseData: { verification: b.raw ?? b, fundResponse: providerResponse },
                metadata: { cardId: String(primaryCard.cardId), destination: "card" },
              });
            }

            if (isPrismaPersistenceEnabled()) {
              await prisma.transaction.create({
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
            } else {
              await Transaction.create({
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
            await bot!.sendMessage(msg.chat.id, lines.join("\n"), { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
            depositSelections.delete(msg.chat.id);

            const autoTopupMessage = `Deposited to card: ${quote.creditedUsdt.toFixed(2)} USDT`;

            // Show latest card data and wallet after deposit/top-up.
            const liveCardDetail = primaryCard?.cardId ? await fetchCardDetailSafe(String(primaryCard.cardId)) : null;
            const liveCardBalance = liveCardDetail?.available_balance || liveCardDetail?.balance;
            const liveCardCurrency = (liveCardDetail?.currency || primaryCard?.currency || "USD").toUpperCase();
            await bot!.sendMessage(
              msg.chat.id,
              [
                "✅ Payment Verified",
                autoTopupMessage,
                liveCardBalance != null
                  ? `Card balance: ${Number(liveCardBalance).toFixed(2)} ${liveCardCurrency}`
                  : "Your card balance will update shortly once the credit is posted.",
                "Note: this deposit was applied directly to your card.",
              ].filter(Boolean).join("\n"),
              { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } }
            );

            await notifyLowStroWalletBalanceIfNeeded({
              userId: String(msg.chat.id),
              paymentMethod: method,
              creditedUsdt: Number(quote.creditedUsdt || 0),
            });
          } catch (createErr: any) {
            if (createErr?.code === 11000) {
              await bot!.sendMessage(msg.chat.id, "❌ This payment reference has already been used.", { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
              clearPendingAction(msg.chat.id);
              return;
            }
            await bot!.sendMessage(msg.chat.id, `❌ Verification error: ${createErr?.message || "Unexpected error"}`, { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
            clearPendingAction(msg.chat.id);
            return;
          }
        } else {
          const selected = depositSelections.get(msg.chat.id);
          let queued: { queued: boolean; transactionId: string | null } = { queued: false, transactionId: null };
          try {
            queued = await queueDepositManualReview({
              userId: String(msg.chat.id),
              paymentMethod: method,
              transactionNumber: normalizedTxn,
              expectedAmountEtb: selected?.amountEtb ?? pending.expectedAmount,
              reason: b?.message || "Automatic verifier returned failure",
              responseData: b,
            });
          } catch (queueErr: any) {
            console.error("Failed to queue manual review", {
              userId: String(msg.chat.id),
              paymentMethod: method,
              transactionNumber: normalizedTxn,
              error: queueErr?.message || String(queueErr),
            });
          }
          depositSelections.delete(msg.chat.id);
          if (queued.queued) {
            await bot!.sendMessage(
              msg.chat.id,
              [
                "⏳ Automatic verification failed.",
                "Your payment has been sent to admin for manual review.",
                "You will be notified once it is approved or declined.",
              ].join("\n"),
              { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } }
            );
          } else {
            await bot!.sendMessage(msg.chat.id, `❌ Verification failed: ${b?.message || "Unknown error"}`, { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
          }
        }
      } catch (e: any) {
        const selected = depositSelections.get(msg.chat.id);
        let queued: { queued: boolean; transactionId: string | null } = { queued: false, transactionId: null };
        try {
          queued = await queueDepositManualReview({
            userId: String(msg.chat.id),
            paymentMethod: method,
            transactionNumber: normalizedTxn,
            expectedAmountEtb: selected?.amountEtb ?? pending.expectedAmount,
            reason: e?.message || "Automatic verifier threw an error",
            responseData: { error: e?.message || String(e) },
          });
        } catch (queueErr: any) {
          console.error("Failed to queue manual review after verifier error", {
            userId: String(msg.chat.id),
            paymentMethod: method,
            transactionNumber: normalizedTxn,
            error: queueErr?.message || String(queueErr),
          });
        }
        depositSelections.delete(msg.chat.id);
        if (queued.queued) {
          await bot!.sendMessage(
            msg.chat.id,
            [
              "⏳ Automatic verification failed.",
              "Your payment has been sent to admin for manual review.",
              "You will be notified once it is approved or declined.",
            ].join("\n"),
            { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } }
          );
        } else {
          await bot!.sendMessage(msg.chat.id, `❌ Verification error: ${e?.message || "Unexpected error"}`, { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
        }
      } finally {
        clearPendingAction(msg.chat.id);
      }
    } else if (pending.type === "card_request_verify") {
      const method = pending.method;
      if (!text) {
        return bot!.sendMessage(msg.chat.id, "Transaction number cannot be empty. Try again or /cancel.");
      }
      let txn = text;
      try {
        if (/^https?:\/\//i.test(text)) {
          const u = new URL(text);
          const id = u.searchParams.get("id");
          if (id) {
            txn = id;
          } else {
            const parts = u.pathname.split("/").filter(Boolean);
            if (parts.length) txn = parts[parts.length - 1];
          }
        }
      } catch { }

      const normalizedTxn = normalizeTxnRef(txn, pending.method);
      try {
        const already = await findUsedPaymentReference(method, normalizedTxn);
        if (already) {
          await bot!.sendMessage(msg.chat.id, "❌ This payment reference has already been used.", {
            reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
          });
          clearPendingAction(msg.chat.id);
          return;
        }

        const result = await verifyPayment({ paymentMethod: method, transactionNumber: normalizedTxn });
        const b = result.body as any;
        if (b?.success) {
          const selection = cardRequestSelections.get(msg.chat.id);
          if (!selection) {
            await bot!.sendMessage(msg.chat.id, "Card request payment session expired. Please request a card again.", {
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
              await bot!.sendMessage(
                msg.chat.id,
                [
                  "⏳ Automatic verification failed.",
                  "Your card-request payment was sent to admin for manual review.",
                  "You will be notified once approved or declined.",
                ].join("\n"),
                { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } }
              );
            } else {
              const notice = [
                "❌ Verification failed due to:",
                ...validationErrors.map((v) => `- ${v}`),
                "Please check your receipt and try again.",
              ].join("\n");
              await bot!.sendMessage(msg.chat.id, notice, { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
            }
            clearPendingAction(msg.chat.id);
            return;
          }

          const rawData = (b.raw?.data ?? b.raw ?? {}) as any;
          const verifiedKey = normalizeTxnRef(String(b.transactionNumber || normalizedTxn), method);
          const altKey = normalizeTxnRef(String(rawData?.reference || normalizedTxn), method);

          try {
            if (isPrismaPersistenceEnabled()) {
              await prisma.transaction.create({
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
            } else {
              await Transaction.create({
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
          } catch (createErr: any) {
            if (createErr?.code !== 11000) {
              await bot!.sendMessage(msg.chat.id, `❌ Verification error: ${createErr?.message || "Unexpected error"}`, {
                reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
              });
              clearPendingAction(msg.chat.id);
              return;
            }
          }

          const userId = String(msg.chat.id);
          const { user, customer } = await getUserAndCustomerContext(userId);
          if (!customer || customer.kycStatus !== "approved") {
            await bot!.sendMessage(msg.chat.id, [
              "✅ Payment Verified",
              "Please complete KYC to activate your card request.",
            ].join("\n"), {
              reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
            });
            clearPendingAction(msg.chat.id);
            return;
          }

          const existingCard = isPrismaPersistenceEnabled()
            ? await prisma.card.findFirst({ where: { userId }, orderBy: { updatedAt: "desc" } })
            : await Card.findOne({ userId }).lean();
          if (existingCard) {
            await bot!.sendMessage(msg.chat.id, "❌ You already have a card. Multiple cards are not allowed.", {
              reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
            });
            clearPendingAction(msg.chat.id);
            return;
          }

          await bot!.sendMessage(msg.chat.id, "✅ Payment verified. Creating your virtual card...", {
            reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
          });
          cardRequestSelections.delete(msg.chat.id);
          await submitCardRequest(String(msg.chat.id), user, customer, undefined, selection.cardAmountUsd);
        } else {
          const selection = cardRequestSelections.get(msg.chat.id);
          if (!selection) {
            await bot!.sendMessage(msg.chat.id, `❌ Verification failed: ${b?.message || "Unknown error"}`, {
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
            await bot!.sendMessage(
              msg.chat.id,
              [
                "⏳ Automatic verification failed.",
                "Your card-request payment was sent to admin for manual review.",
                "You will be notified once approved or declined.",
              ].join("\n"),
              { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } }
            );
          } else {
            await bot!.sendMessage(msg.chat.id, `❌ Verification failed: ${b?.message || "Unknown error"}`, {
              reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
            });
          }
        }
      } catch (e: any) {
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
            await bot!.sendMessage(
              msg.chat.id,
              [
                "⏳ Automatic verification failed.",
                "Your card-request payment was sent to admin for manual review.",
                "You will be notified once approved or declined.",
              ].join("\n"),
              { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } }
            );
          } else {
            await bot!.sendMessage(msg.chat.id, `❌ Verification error: ${e?.message || "Unexpected error"}`, {
              reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
            });
          }
        } else {
          await bot!.sendMessage(msg.chat.id, `❌ Verification error: ${e?.message || "Unexpected error"}`, {
            reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
          });
        }
      } finally {
        clearPendingAction(msg.chat.id);
      }
    } else if (pending.type === "deposit_amount") {
      const method = pending.method;
      const amount = Number(text.replace(/,/g, ""));
      if (!Number.isFinite(amount) || amount < MIN_DEPOSIT_ETB) {
        return bot!.sendMessage(msg.chat.id, `Please enter a valid amount in ETB (minimum ${MIN_DEPOSIT_ETB}), or /cancel.`);
      }
      clearPendingAction(msg.chat.id);
      await sendDepositSummary(msg.chat.id, method, amount);
    } else if (pending.type === "deposit_convert_amount") {
      const usdAmount = Number(text.replace(/,/g, ""));
      clearPendingAction(msg.chat.id);
      await sendDepositConversionPreview(msg.chat.id, usdAmount);
    }
  });
}

export async function notifyByCardId(cardId: string, message: string) {
  if (!bot) return;
  if (isPrismaPersistenceEnabled()) {
    const card = await prisma.card.findUnique({ where: { cardId } });
    const chatId = Number(card?.userId);
    if (Number.isFinite(chatId)) {
      await bot.sendMessage(chatId, message, { disable_web_page_preview: true });
    }
    return;
  }
  const links = await TelegramLink.find({ cardIds: cardId });
  const sent = new Set<number>();
  for (const link of links) {
    const chatId = Number(link.chatId);
    if (!Number.isFinite(chatId)) continue;
    sent.add(chatId);
    await bot.sendMessage(chatId, message, { disable_web_page_preview: true });
  }

  const card = await Card.findOne({ cardId }).lean();
  const chatId = card?.userId ? Number(card.userId) : NaN;
  if (Number.isFinite(chatId) && !sent.has(chatId)) {
    await bot.sendMessage(chatId, message, { disable_web_page_preview: true });
  }
}

export async function notifyByEmail(email: string, message: string) {
  if (!bot) return;
  if (isPrismaPersistenceEnabled()) {
    const user = await prisma.user.findFirst({ where: { customerEmail: email } });
    const chatId = Number(user?.chatId || user?.userId);
    if (Number.isFinite(chatId)) {
      await bot.sendMessage(chatId, message, { disable_web_page_preview: true });
    }
    return;
  }
  const link = await TelegramLink.findOne({ customerEmail: email });
  if (link) {
    await bot.sendMessage(link.chatId, message, { disable_web_page_preview: true });
    return;
  }
  const customer = await Customer.findOne({ email }).lean();
  if (customer?.userId) {
    const user = await User.findOne({ userId: customer.userId }).lean();
    const chatId = user?.chatId ? Number(user.chatId) : NaN;
    if (Number.isFinite(chatId)) {
      await bot.sendMessage(chatId, message, { disable_web_page_preview: true });
    }
  }
}

export async function notifyCardStatusChanged(cardId: string, status: "frozen" | "active") {
  if (!bot) return;
  const card = isPrismaPersistenceEnabled()
    ? await prisma.card.findUnique({ where: { cardId } })
    : await Card.findOne({ cardId }).lean();
  const suffix = card?.last4 ? `••••${card.last4}` : cardId;
  const text =
    status === "frozen"
      ? `❌ Your card ${suffix} has been frozen by admin.`
      : `✅ Your card ${suffix} has been reactivated.`;
  await notifyByCardId(cardId, text);
}

export async function notifyUserBalanceReconciled(userId: string, cardId: string, balance: number, currency?: string) {
  if (!bot) return;
  const chatId = Number(userId);
  if (!Number.isFinite(chatId)) return;
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

export async function notifyCardRequestApproved(userId: string, payload: { cardId?: string; cardType?: string; nameOnCard?: string; raw?: any }) {
  if (!bot) return;
  const lines = [
    "✅ Approved",
    "🎉 Your virtual card has been approved and created successfully.",
    "You can now view and manage your card from My Card.",
    payload.cardId ? `Card ID: ${payload.cardId}` : undefined,
  ].filter(Boolean) as string[];
  await bot.sendMessage(Number(userId), lines.join("\n"), { disable_web_page_preview: true, reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
}

export async function notifyCardLinkedToUser(userId: string, payload: { cardId?: string; cardType?: string; nameOnCard?: string; last4?: string }) {
  if (!bot) return;
  const chatId = Number(userId);
  if (!Number.isFinite(chatId)) return;
  const suffix = payload.last4 ? `••••${payload.last4}` : undefined;
  const lines = [
    "✅ Virtual card assigned",
    "A virtual card has been assigned to your account by admin.",
    payload.cardId ? `Card ID: ${payload.cardId}` : undefined,
    suffix ? `Card: ${suffix}` : undefined,
    payload.cardType ? `Type: ${payload.cardType}` : undefined,
    payload.nameOnCard ? `Name: ${payload.nameOnCard}` : undefined,
    "Open My Card to view details.",
  ].filter(Boolean) as string[];
  await bot.sendMessage(chatId, lines.join("\n"), {
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
  });
}

export async function notifyCardRequestDeclined(userId: string, reason?: string) {
  if (!bot) return;
  const lines = [
    "❌ Your card request was declined. Please contact support.",
    reason ? `Reason: ${reason}` : undefined,
  ].filter(Boolean) as string[];
  await bot.sendMessage(Number(userId), lines.join("\n"), { disable_web_page_preview: true, reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
}

export async function notifyDepositCredited(userId: string, amountUsdt: number, newBalance?: number) {
  if (!bot) return;
  const lines = [
    "✅ Deposit received",
    `Amount: ${amountUsdt} USDT`,
    newBalance != null ? `Wallet balance: ${newBalance} USDT` : undefined,
  ].filter(Boolean) as string[];
  await bot.sendMessage(Number(userId), lines.join("\n"), {
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
  });
}

export async function notifyDepositReviewDeclined(userId: string, reason?: string) {
  if (!bot) return;
  const lines = [
    "❌ Deposit review declined",
    reason ? `Reason: ${reason}` : undefined,
    "Please submit a new payment and try verification again.",
  ].filter(Boolean) as string[];
  await bot.sendMessage(Number(userId), lines.join("\n"), {
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
  });
}

export async function sendBroadcastToUser(userId: string, messageText: string, imageUrl?: string): Promise<{ ok: boolean; error?: string }> {
  if (!bot) return { ok: false, error: "Bot is not initialized" };
  const chatId = Number(userId);
  if (!Number.isFinite(chatId)) return { ok: false, error: "Invalid user id" };

  try {
    if (imageUrl) {
      const caption = messageText.length > 1024 ? `${messageText.slice(0, 1021)}...` : messageText;
      await (bot as any).sendPhoto(chatId, imageUrl, {
        caption,
        disable_web_page_preview: true,
      });
    } else {
      await bot.sendMessage(chatId, messageText, {
        disable_web_page_preview: true,
      });
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || "Failed to send" };
  }
}

export async function notifyKycStatus(userId: string, status: KycStatus) {
  if (!bot) return;
  const chatId = Number(userId);
  if (!Number.isFinite(chatId)) return;
  if (status === "approved") {
    await bot.sendMessage(chatId, "✅ Congratulations! Your KYC has been approved. You can now create your StroWallet card.", {
      reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
    });
    return;
  }
  if (status === "rejected") {
    await bot.sendMessage(chatId, "❌ KYC verification failed. Please try again or edit with /kyc_edit.", {
      reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
    });
  }
}

export async function pollPendingKycUpdates() {
  if (isPrismaOnlyMode()) {
    const pendingUsers = await prisma.user.findMany({
      where: {
        kycStatus: { in: ["pending", "review", "processing", "unreview_kyc", "unreview-kyc", "unreview kyc"] },
      },
    });
    let checked = 0;
    let updated = 0;

    for (const user of pendingUsers) {
      checked += 1;
      const before = normalizeKycStatus(user.kycStatus);
      const after = await refreshKycStatusFromStroWallet(user);
      if (after && after !== before) {
        updated += 1;
      }
    }

    return { checked, updated };
  }
  const pendingCustomers = await Customer.find({ kycStatus: "pending" }).lean();
  let checked = 0;
  let updated = 0;

  for (const customer of pendingCustomers) {
    const user = await User.findOne({ userId: String(customer.userId) }).lean();
    if (!user) continue;
    checked += 1;
    const before = normalizeKycStatus(customer.kycStatus || user.kycStatus);
    const after = await refreshKycStatusFromStroWallet(user);
    if (after && after !== before) {
      updated += 1;
    }
  }

  return { checked, updated };
}

function buildInstanceId() {
  const replica = process.env.RAILWAY_REPLICA_ID || process.env.REPLICA_ID || "none";
  return `${os.hostname()}-${process.pid}-${replica}`;
}

async function acquireBotLock(ownerId: string, ttlMs: number) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);
  try {
    const lock = (await BotLock.findOneAndUpdate(
      { key: BOT_LOCK_KEY, $or: [{ expiresAt: { $lte: now } }, { ownerId }] },
      { $set: { ownerId, expiresAt }, $setOnInsert: { key: BOT_LOCK_KEY, createdAt: now } },
      { upsert: true, new: true }
    ).lean()) as { ownerId?: string } | null;
    if (lock?.ownerId === ownerId) return true;

    // Recover from clock-skewed locks that stay in the future and block polling.
    const existing = (await BotLock.findOne({ key: BOT_LOCK_KEY }).lean()) as { ownerId?: string; expiresAt?: Date } | null;
    const maxSkewMs = ttlMs * 2;
    if (existing?.expiresAt && existing.expiresAt.getTime() - now.getTime() > maxSkewMs) {
      console.warn("Bot lock expires far in the future; forcing takeover.");
      const forced = (await BotLock.findOneAndUpdate(
        { key: BOT_LOCK_KEY },
        { $set: { ownerId, expiresAt } },
        { new: true }
      ).lean()) as { ownerId?: string } | null;
      return forced?.ownerId === ownerId;
    }

    return false;
  } catch (err: any) {
    if (err?.code === 11000) return false;
    throw err;
  }
}

async function renewBotLock(ownerId: string, ttlMs: number) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);
  const res = await BotLock.updateOne(
    { key: BOT_LOCK_KEY, ownerId },
    { $set: { expiresAt } }
  );
  return res.modifiedCount > 0;
}

function startBotLockHeartbeat(ownerId: string, botRef: TelegramBot, ttlMs: number) {
  const intervalMs = Math.max(15000, Math.floor(ttlMs / 2));
  const timer = setInterval(async () => {
    try {
      const ok = await renewBotLock(ownerId, ttlMs);
      if (!ok) {
        console.warn("Telegram bot lock lost; stopping polling.");
        await (botRef as any).stopPolling().catch(() => { });
        clearInterval(timer);
      }
    } catch (err) {
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

function shouldSuppressOutgoing(chatId: number, key: string, ttlMs = 1500) {
  const now = Date.now();
  const last = recentOutgoing.get(chatId);
  if (last && last.key === key && now - last.at < ttlMs) return true;
  recentOutgoing.set(chatId, { key, at: now });
  return false;
}

function isDuplicateUpdate(key: string, ttlMs = 60000) {
  const now = Date.now();
  const last = recentUpdates.get(key);
  if (last && now - last < ttlMs) return true;
  recentUpdates.set(key, now);
  if (recentUpdates.size > 2000) {
    for (const [k, t] of recentUpdates.entries()) {
      if (now - t > ttlMs) recentUpdates.delete(k);
    }
  }
  return false;
}

function shouldSkipCommand(msg: any, key: string, ttlMs = 1500) {
  const chatId = msg?.chat?.id;
  const messageId = msg?.message_id;
  if (chatId != null && messageId != null) {
    if (isDuplicateUpdate(`cmdmsg:${chatId}:${messageId}`)) return true;
  }
  if (chatId != null && shouldSuppressOutgoing(chatId, `cmd:${key}`, ttlMs)) return true;
  return false;
}

function buildProfileCard(msg: any, link?: ITelegramLink | null, cardCount = 0) {
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
  ].filter(Boolean) as string[];

  return lines.join("\n");
}

async function sendMenu(chatId: number, message?: any) {
  if (!bot) return;
  if (shouldSuppressOutgoing(chatId, "menu")) return;
  await editOrSend(chatId, message, "Main menu", { inline_keyboard: MENU_KEYBOARD });
}

async function editOrSend(chatId: number, message: any, text: string, replyMarkup?: any, parseMode?: string) {
  if (!bot) return;
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
    } catch { }
  }
  await bot.sendMessage(chatId, text, {
    reply_markup: replyMarkup,
    parse_mode: parseMode,
    disable_web_page_preview: true,
  });
}

function buildVerificationHint(method: PaymentMethod) {
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

async function startVerificationFlow(chatId: number, method: PaymentMethod) {
  const key = chatKey(chatId);
  if (key) {
    const selected = depositSelections.get(chatId);
    const expectedAmount = selected && selected.method === method ? selected.amountEtb : undefined;
    pendingActions.set(key, { type: "verify", method, expectedAmount });
  }
  await bot!.sendMessage(chatId, buildVerificationHint(method), {
    reply_markup: { force_reply: true },
  });
}

function normalizeTxnRef(raw: string, method: PaymentMethod) {
  if (!raw) return "";
  const trimmed = raw.trim();
  if (method === "cbe") {
    let decoded = trimmed;
    try {
      decoded = decodeURIComponent(trimmed);
    } catch {
      decoded = trimmed; // fall back to raw if malformed URI
    }

    let candidate = decoded;
    try {
      const url = new URL(decoded);
      const id = (url.searchParams.get("id") || "").trim();
      if (id) {
        candidate = id;
      } else {
        const parts = url.pathname.split("/").filter(Boolean);
        if (parts.length) candidate = parts[parts.length - 1];
      }
    } catch {
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
    if (refOnly) return refOnly[0].toUpperCase();

    return text.toUpperCase();
  }
  // Telebirr: attempt to extract reference from SMS text or embedded link
  try {
    const urlMatch = trimmed.match(/https?:\/\/[^\s]*transactioninfo\.ethiotelecom\.et\/receipt\/([A-Za-z0-9]+)/i);
    if (urlMatch && urlMatch[1]) return urlMatch[1].toUpperCase();
    const phraseMatch = trimmed.match(/transaction\s+number\s+is\s+([A-Za-z0-9]+)/i);
    if (phraseMatch && phraseMatch[1]) return phraseMatch[1].toUpperCase();
    // Fallback: choose the last likely uppercase alphanumeric token of length 8-14
    const tokens = trimmed.match(/[A-Z0-9]{8,14}/g);
    if (tokens && tokens.length) return tokens[tokens.length - 1].toUpperCase();
  } catch { }
  return trimmed;
}

function normalizeName(value?: string) {
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

function normalizeDigits(value?: string) {
  return (value || "").replace(/\D+/g, "");
}

function namesMatch(expectedRaw: string, actualRaw: string) {
  const expected = normalizeName(expectedRaw);
  const actual = normalizeName(actualRaw);
  if (!expected || !actual) return false;
  if (expected === actual) return true;

  const expectedTokens = expected.split(" ").filter((t) => t.length > 1);
  const actualTokens = actual.split(" ").filter((t) => t.length > 1);
  if (!expectedTokens.length || !actualTokens.length) return false;

  const actualSet = new Set(actualTokens);
  let overlap = 0;
  for (const token of expectedTokens) {
    if (actualSet.has(token)) overlap += 1;
  }

  if (overlap >= expectedTokens.length) return true;
  return overlap >= 2 && overlap >= Math.min(expectedTokens.length, actualTokens.length) - 1;
}

async function findUsedPaymentReference(paymentMethod: PaymentMethod, normalizedTxn: string) {
  const enableTestVerification = String(process.env.ENABLE_TEST_VERIFICATION || "false").toLowerCase() === "true";
  const testTransactionId = (process.env.TEST_TRANSACTION_ID || "").trim();
  if (
    enableTestVerification &&
    paymentMethod === "telebirr" &&
    testTransactionId &&
    normalizedTxn.toUpperCase() === testTransactionId.toUpperCase()
  ) {
    return null;
  }
  if (isPrismaPersistenceEnabled()) {
    return prisma.transaction.findFirst({
      where: {
        paymentMethod,
        transactionType: { in: ["deposit", "verification", "card"] },
        OR: [{ transactionNumber: normalizedTxn }, { referenceNumber: normalizedTxn }],
      },
      orderBy: { createdAt: "desc" },
    });
  }
  return await Transaction.findOne({
    paymentMethod,
    transactionType: { $in: ["deposit", "verification", "card"] },
    $or: [{ transactionNumber: normalizedTxn }, { referenceNumber: normalizedTxn }],
  }).lean();
}

function digitsMatch(expectedRaw: string, actualRaw: string) {
  const expected = normalizeDigits(expectedRaw);
  const actual = normalizeDigits(actualRaw);
  if (!expected || !actual) return false;
  if (expected === actual) return true;
  // Allow last 4 or 6 digits match for masked numbers
  const last4 = expected.slice(-4);
  if (last4 && actual.endsWith(last4)) return true;
  const last6 = expected.slice(-6);
  if (last6 && actual.endsWith(last6)) return true;
  return false;
}

function parseMoney(value?: any): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/[^\d.,-]/g, "").replace(/,/g, "");
  const num = parseFloat(cleaned);
  return Number.isFinite(num) ? num : undefined;
}

function formatMoney(value: number, currency?: string) {
  const label = currency && currency !== "ETB" ? currency : "Birr";
  return `${value.toFixed(2)} ${label}`;
}

function extractReceiptFields(body: any) {
  const raw = body?.raw ?? body ?? {};
  const candidate = raw?.transactionDetails || raw?.data?.transactionDetails || raw?.data || raw;
  const receiverName =
    candidate?.creditedPartyName || candidate?.receiverName || candidate?.receiver || candidate?.recipientName || candidate?.to || candidate?.payeeName || candidate?.creditedName || raw?.creditedPartyName;
  const payerName = candidate?.payerName || candidate?.payer || candidate?.from || candidate?.senderName || raw?.payerName;
  const receiverAccount =
    candidate?.accountNumber || candidate?.receiverAccountNumber || candidate?.creditedAccount || candidate?.creditedAccountNumber || candidate?.account || candidate?.accountNo || candidate?.receiverAccount || candidate?.creditedPartyAccountNo || raw?.accountNumber;
  const receiverPhone =
    candidate?.receiverPhone || candidate?.receiverMSISDN || candidate?.receiverMobile || candidate?.destination || candidate?.toPhone || candidate?.payeePhone || candidate?.creditedPartyAccountNo;
  const payerPhone = candidate?.payerPhone || candidate?.payerMSISDN || candidate?.payerMobile || candidate?.fromPhone || candidate?.senderPhone;
  const amountFromBody = typeof body?.amount === "number" ? body.amount : undefined;
  const amountCandidate =
    parseMoney(candidate?.settledAmount) ?? parseMoney(candidate?.totalPaidAmount) ?? parseMoney(candidate?.amount) ?? amountFromBody;
  const serviceFee = parseMoney(candidate?.serviceFee ?? candidate?.fee);
  const serviceFeeVAT = parseMoney(candidate?.serviceFeeVAT ?? candidate?.vat ?? candidate?.vatAmount);
  const totalPaid = parseMoney(candidate?.totalPaidAmount ?? candidate?.totalPaid ?? candidate?.total_amount);
  return { receiverName, payerName, payerPhone, receiverAccount, receiverPhone, amount: amountCandidate, serviceFee, serviceFeeVAT, totalPaid };
}

function validateVerificationResult(params: {
  method: PaymentMethod;
  body: any;
  selected?: { method: PaymentMethod; amountEtb?: number; totalEtb?: number; amount?: number };
}) {
  const { method, body, selected } = params;
  const enableTestVerification = String(process.env.ENABLE_TEST_VERIFICATION || "false").toLowerCase() === "true";
  const testTransactionId = (process.env.TEST_TRANSACTION_ID || "").trim();
  const normalizedTxn = String(body?.transactionNumber || body?.reference || body?.raw?.data?.receiptNo || body?.raw?.receiptNo || "").trim();
  const isTestTelebirr =
    enableTestVerification &&
    method === "telebirr" &&
    testTransactionId &&
    normalizedTxn.toUpperCase() === testTransactionId.toUpperCase();
  const { receiverName, receiverAccount, receiverPhone, payerPhone, amount, totalPaid } = extractReceiptFields(body);
  const errors: string[] = [];

  const expectedName = method === "telebirr" ? EXPECTED_TELEBIRR_NAME : EXPECTED_RECEIVER_NAME;
  const strictNameCheck = method === "telebirr" ? TELEBIRR_STRICT_RECEIVER : CBE_STRICT_RECEIVER;
  if (!isTestTelebirr && strictNameCheck && expectedName) {
    if (!receiverName) errors.push("Receiver name missing on receipt");
    else if (!namesMatch(expectedName, receiverName)) errors.push("Receiver name does not match the expected payment account.");
  }

  if (!isTestTelebirr && method === "telebirr" && EXPECTED_TELEBIRR_PHONE) {
    const expectedPhone = EXPECTED_TELEBIRR_PHONE;
    const masked = receiverPhone && receiverPhone.includes("*");
    const phoneToCheck = receiverPhone || payerPhone;
    if (!phoneToCheck) {
      errors.push("Receiver phone missing on Telebirr receipt");
    } else if (masked) {
      // For masked numbers, allow lenient suffix match
      if (!digitsMatch(expectedPhone, phoneToCheck)) {
        // Do not hard-fail masked mismatch; only warn if payer phone also mismatches
        if (payerPhone && !digitsMatch(expectedPhone, payerPhone)) {
          errors.push("Receiver phone number does not match");
        }
      }
    } else if (!digitsMatch(expectedPhone, phoneToCheck)) {
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
    } else if (typeof paid !== "number") {
      errors.push("Payment total is missing in provider response.");
    } else if (Math.abs(paid - expectedTotal) > 2) {
      errors.push("Payment total does not match the expected amount (including service fee).");
    }
  }

  return errors;
}

async function queueDepositManualReview(params: {
  userId: string;
  paymentMethod: PaymentMethod;
  transactionNumber: string;
  expectedAmountEtb?: number;
  reason: string;
  responseData?: any;
}) {
  const { userId, paymentMethod, transactionNumber, expectedAmountEtb, reason, responseData } = params;
  const txn = normalizeTxnRef(transactionNumber, paymentMethod);
  if (!txn) return { queued: false as const, transactionId: null as string | null };

  if (isPrismaPersistenceEnabled()) {
    const existing = await prisma.transaction.findFirst({
      where: {
        userId,
        transactionType: "deposit",
        OR: [{ transactionNumber: txn }, { referenceNumber: txn }],
      },
      orderBy: { createdAt: "desc" },
    });

    if (existing?.status === "completed") {
      return { queued: false as const, transactionId: String(existing.id) };
    }

    const amountEtb = Number.isFinite(expectedAmountEtb) ? Number(expectedAmountEtb) : undefined;
    const data: any = {
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
      const updated = await prisma.transaction.update({ where: { id: existing.id }, data });
      return { queued: true as const, transactionId: String(updated.id) };
    }

    const created = await prisma.transaction.create({
      data: {
        userId,
        transactionType: "deposit",
        transactionNumber: txn,
        ...data,
      },
    });
    return { queued: true as const, transactionId: String(created.id) };
  }

  const existing = await Transaction.findOne({
    userId,
    transactionType: "deposit",
    transactionNumber: txn,
  }).lean();

  if (existing?.status === "completed") {
    return { queued: false as const, transactionId: String(existing._id) };
  }

  const amountEtb = Number.isFinite(expectedAmountEtb) ? Number(expectedAmountEtb) : undefined;
  try {
    const doc = await Transaction.findOneAndUpdate(
      {
        userId,
        transactionType: "deposit",
        $or: [{ transactionNumber: txn }, { referenceNumber: txn }],
      },
      {
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
      },
      { upsert: true, new: true }
    );

    return { queued: true as const, transactionId: String(doc._id) };
  } catch (err: any) {
    if (err?.code === 11000) {
      const duplicate = await Transaction.findOne({
        userId,
        transactionType: "deposit",
        $or: [{ transactionNumber: txn }, { referenceNumber: txn }],
      }).lean();
      if (duplicate) {
        return { queued: true as const, transactionId: String(duplicate._id) };
      }
    }
    throw err;
  }
}

async function queueCardRequestManualReview(params: {
  userId: string;
  paymentMethod: PaymentMethod;
  transactionNumber: string;
  expectedAmountEtb: number;
  cardAmountUsd: number;
  feeUsd: number;
  totalUsd: number;
  rate: number;
  reason: string;
  responseData?: any;
}) {
  const {
    userId,
    paymentMethod,
    transactionNumber,
    expectedAmountEtb,
    cardAmountUsd,
    feeUsd,
    totalUsd,
    rate,
    reason,
    responseData,
  } = params;
  const txn = normalizeTxnRef(transactionNumber, paymentMethod);
  if (!txn) return { queued: false as const, transactionId: null as string | null };

  if (isPrismaPersistenceEnabled()) {
    const existing = await prisma.transaction.findFirst({
      where: {
        userId,
        transactionType: "deposit",
        OR: [{ transactionNumber: txn }, { referenceNumber: txn }],
      },
      orderBy: { createdAt: "desc" },
    });

    if (existing?.status === "completed" && (existing.metadata as any)?.kind === "card_request_manual") {
      return { queued: false as const, transactionId: String(existing.id) };
    }

    const data: any = {
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
      const updated = await prisma.transaction.update({ where: { id: existing.id }, data });
      return { queued: true as const, transactionId: String(updated.id) };
    }

    const created = await prisma.transaction.create({
      data: {
        userId,
        transactionType: "deposit",
        transactionNumber: txn,
        ...data,
      },
    });
    return { queued: true as const, transactionId: String(created.id) };
  }

  const existing = await Transaction.findOne({
    userId,
    transactionType: "deposit",
    $or: [{ transactionNumber: txn }, { referenceNumber: txn }],
    "metadata.kind": "card_request_manual",
  }).lean();

  if (existing?.status === "completed") {
    return { queued: false as const, transactionId: String(existing._id) };
  }

  try {
    const doc = await Transaction.findOneAndUpdate(
      {
        userId,
        transactionType: "deposit",
        $or: [{ transactionNumber: txn }, { referenceNumber: txn }],
      },
      {
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
      },
      { upsert: true, new: true }
    );

    return { queued: true as const, transactionId: String(doc._id) };
  } catch (err: any) {
    if (err?.code === 11000) {
      const duplicate = await Transaction.findOne({
        userId,
        transactionType: "deposit",
        $or: [{ transactionNumber: txn }, { referenceNumber: txn }],
      }).lean();
      if (duplicate) {
        return { queued: true as const, transactionId: String(duplicate._id) };
      }
    }
    throw err;
  }
}

async function handleMenuSelection(action: string, chatId: number, message?: any) {
  if (shouldSuppressOutgoing(chatId, `menu_action:${action}`, 1200)) return;
  if (action.startsWith("TXN_PAGE_ALL::")) {
    const [, pageRaw, daysRaw] = action.split("::");
    const page = Number(pageRaw);
    const days = Number(daysRaw);
    return sendCardTransactions(
      chatId,
      undefined,
      Number.isFinite(page) ? page : 1,
      Number.isFinite(days) ? days : 0
    );
  }
  if (action.startsWith("TXN_PAGE_CARD::")) {
    const [, cardId, pageRaw, daysRaw] = action.split("::");
    const page = Number(pageRaw);
    const days = Number(daysRaw);
    if (!cardId) {
      return sendCardTransactions(
        chatId,
        undefined,
        Number.isFinite(page) ? page : 1,
        Number.isFinite(days) ? days : 0
      );
    }
    return sendCardTransactions(
      chatId,
      cardId,
      Number.isFinite(page) ? page : 1,
      Number.isFinite(days) ? days : 0
    );
  }
  if (action.startsWith("TXN_FILTER_ALL::")) {
    const days = Number(action.replace("TXN_FILTER_ALL::", ""));
    return sendCardTransactions(chatId, undefined, 1, Number.isFinite(days) ? days : 0);
  }
  if (action.startsWith("TXN_FILTER_CARD::")) {
    const [, cardId, daysRaw] = action.split("::");
    const days = Number(daysRaw);
    if (!cardId) return sendCardTransactions(chatId, undefined, 1, Number.isFinite(days) ? days : 0);
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
      return sendDepositInfo(chatId, message);
    case "MENU_WALLET":
      return sendWalletSummary(chatId, message);
    case "MENU_INVITE":
      return bot!.sendMessage(chatId, "Invite friends and earn rewards: share your referral link from the app.", {
        reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
      });
    default:
      return bot!.sendMessage(chatId, "Action not recognized. Use the menu again.", { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
  }
}

async function sendDepositInfo(chatId: number, message?: any) {
  if (shouldSuppressOutgoing(chatId, "deposit_menu")) return;
  await editOrSend(chatId, message, "Choose a payment method to deposit:", {
    inline_keyboard: buildDepositMethodKeyboard(),
  });
}

function buildDepositMethodKeyboard(): InlineKeyboardButton[][] {
  return [
    [
      { text: "Telebirr", callback_data: "DEPOSIT_METHOD::telebirr" },
      { text: "CBE", callback_data: "DEPOSIT_METHOD::cbe" },
    ],
    [{ text: "🧮 Conversion", callback_data: "DEPOSIT_CONVERT" }],
    [MENU_BUTTON],
  ];
}

function buildCardRequestMethodKeyboard(): InlineKeyboardButton[][] {
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

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

function computeDepositQuoteByEtb(amountEtb: number, rate: number) {
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

function normalizePayableEtb(value: number) {
  if (!Number.isFinite(value) || value <= 0) return value;
  const hasFraction = Math.abs(value - Math.trunc(value)) > 0.00001;
  if (!hasFraction) return value;
  return Math.ceil(value / 50) * 50;
}

async function sendDepositConversionPreview(chatId: number, usdAmount: number) {
  if (!Number.isFinite(usdAmount) || usdAmount <= 0) {
    await bot!.sendMessage(chatId, "Please enter a valid USD amount greater than 0.", {
      reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
    });
    return;
  }
  const config = await loadPricingConfig();
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
  await bot!.sendMessage(chatId, lines.join("\n"), {
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

async function sendDepositAmountSelect(chatId: number, method: PaymentMethod) {
  const methodLabel = method === "cbe" ? "CBE" : "Telebirr";
  const buttons: InlineKeyboardButton[] = DEPOSIT_AMOUNTS.map((amt) => ({ text: `${amt} ETB`, callback_data: `DEPOSIT_AMOUNT::${method}::${amt}` }));
  const rows: InlineKeyboardButton[][] = chunk<InlineKeyboardButton>(buttons, 3);
  rows.push([{ text: "🧮 Enter custom amount", callback_data: `DEPOSIT_CUSTOM::${method}` }]);
  rows.push([{ text: "🔁 Choose method", callback_data: "MENU_DEPOSIT" }]);
  rows.push([MENU_BUTTON]);

  await bot!.sendMessage(chatId, `Select amount for ${methodLabel} (minimum ${MIN_DEPOSIT_ETB} ETB):`, {
    reply_markup: { inline_keyboard: rows },
  });
}

async function sendDepositSummary(
  chatId: number,
  method: PaymentMethod,
  amount: number,
  options?: { payableAmountEtb?: number; displayAmountEtb?: number; creditedUsd?: number; fromConversion?: boolean }
) {
  if (!Number.isFinite(amount) || amount < MIN_DEPOSIT_ETB) {
    await bot!.sendMessage(chatId, `Minimum deposit is ${MIN_DEPOSIT_ETB} ETB.`, {
      reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
    });
    return;
  }

  const meta = DEPOSIT_ACCOUNTS[method];
  const config = await loadPricingConfig();
  const rate = Number(config.usdtRate) > 0 ? Number(config.usdtRate) : 220;
  const quote = computeDepositQuoteByEtb(amount, rate);
  const payableEtb = Number.isFinite(options?.payableAmountEtb as number)
    ? Number(options!.payableAmountEtb)
    : normalizePayableEtb(quote.totalEtb);
  const displayAmountEtb = Number.isFinite(options?.displayAmountEtb as number)
    ? Number(options!.displayAmountEtb)
    : amount;
  const creditedUsd = Number.isFinite(options?.creditedUsd as number)
    ? Number(options!.creditedUsd)
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

  const keyboard: InlineKeyboardButton[][] = [
    [{ text: "📋 Copy account", copy_text: { text: meta.account } }],
    [{ text: "✅ Verify payment", callback_data: `DEPOSIT_VERIFY::${method}` }],
    [{ text: "💵 Change amount", callback_data: options?.fromConversion ? `DEPOSIT_CHANGE::${method}` : `DEPOSIT_METHOD::${method}` }],
    [{ text: "🔁 Switch method", callback_data: "MENU_DEPOSIT" }],
    [MENU_BUTTON],
  ];

  await bot!.sendMessage(chatId, lines.join("\n"), {
    reply_markup: { inline_keyboard: keyboard },
  });
}

async function handleCardRequest(chatId: number, message?: any) {
  if (shouldSuppressOutgoing(chatId, "card_request")) return;
  const userId = String(chatId);
  const { user, customer: customerRecord } = await getUserAndCustomerContext(userId);
  const kycStatus = resolveKycStatus(user, customerRecord);

  const existingCard = isPrismaPersistenceEnabled()
    ? await prisma.card.findFirst({ where: { userId }, orderBy: { updatedAt: "desc" } })
    : await Card.findOne({ userId }).lean();
  const approvedRequest = isPrismaPersistenceEnabled()
    ? await prisma.cardRequest.findFirst({ where: { userId, status: "approved" }, orderBy: { updatedAt: "desc" } })
    : await CardRequest.findOne({ userId, status: "approved" }).lean();
  if (existingCard || approvedRequest) {
    await bot!.sendMessage(chatId, "❌ You already have a card. Multiple cards are not allowed.", {
      reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
    });
    return;
  }

  if (kycStatus !== "approved") {
    if (kycStatus === "pending") {
      await bot!.sendMessage(chatId, "⏳ KYC pending verification. Please wait and try again later.", {
        reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
      });
      return;
    }
    if (kycStatus === "rejected") {
      await bot!.sendMessage(chatId, "❌ KYC was rejected. Please resubmit with /kyc_edit.", {
        reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
      });
      return;
    }
    await bot!.sendMessage(chatId, "❌ Please first verify /kyc", {
      reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
    });
    return;
  }

  const pendingRequest = isPrismaPersistenceEnabled()
    ? await prisma.cardRequest.findFirst({ where: { userId, status: "pending" }, orderBy: { updatedAt: "desc" } })
    : await CardRequest.findOne({ userId, status: "pending" }).lean();
  if (pendingRequest) {
    await bot!.sendMessage(chatId, "⏳ Your card request is already being processed.", {
      reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
    });
    return;
  }

  if (!customerRecord?.email) {
    await bot!.sendMessage(chatId, "❌ Missing email on your KYC. Please update and resubmit KYC.", {
      reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
    });
    return;
  }

  const config = await loadPricingConfig();
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
  await bot!.sendMessage(chatId, lines.join("\n"), {
    reply_markup: { inline_keyboard: buildCardRequestMethodKeyboard() },
  });
}

function extractCardIdFromPayload(payload: any): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const priorityKeys = ["card_id", "cardId", "virtual_card_id", "virtualCardId", "id"];
  const seen = new Set<any>();
  const candidates: string[] = [];

  const visit = (node: any) => {
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);

    for (const key of priorityKeys) {
      if ((node as any)[key] != null) {
        candidates.push(String((node as any)[key]));
      }
    }

    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
      } else if (value && typeof value === "object") {
        visit(value);
      }
    }
  };

  visit(payload);
  return candidates.find((c) => isLikelyCardId(c));
}

async function resolveCreatedCardId(params: {
  userId: string;
  customerEmail?: string;
  providerPayload?: any;
  attempts?: number;
}): Promise<string | undefined> {
  const maxAttempts = Math.max(1, Number(params.attempts || 3));
  const immediate = extractCardIdFromPayload(params.providerPayload);
  if (immediate) return immediate;

  for (let i = 0; i < maxAttempts; i += 1) {
    if (i > 0) await sleep(1200);

    if (isPrismaPersistenceEnabled()) {
      const card = await prisma.card.findFirst({
        where: {
          OR: [
            { userId: params.userId },
            ...(params.customerEmail ? [{ customerEmail: params.customerEmail }] : []),
          ],
        },
        orderBy: { updatedAt: "desc" },
      });
      if (card?.cardId && isLikelyCardId(card.cardId)) return card.cardId;
    } else {
      const card = await Card.findOne({
        $or: [
          { userId: params.userId },
          ...(params.customerEmail ? [{ customerEmail: params.customerEmail }] : []),
        ],
      })
        .sort({ updatedAt: -1 })
        .lean();
      if (card?.cardId && isLikelyCardId(String(card.cardId))) return String(card.cardId);
    }

    if (params.customerEmail) {
      try {
        const lookup = await callStroWallet(
          "getcardholder",
          "get",
          { customerEmail: params.customerEmail },
          { silentOnStatus: [400, 403, 404] }
        );
        const fromLookup = extractCardIdFromPayload(lookup);
        if (fromLookup) return fromLookup;
      } catch {
        // Ignore transient lookup errors.
      }
    }
  }

  return undefined;
}

async function submitCardRequest(userId: string, user: any, customer: any, message?: any, cardAmountUsd?: number) {
  const nameOnCard = [user.firstName, user.lastName].filter(Boolean).join(" ") || message?.from?.first_name || "StroWallet User";
  const parsedCardAmount = Number(cardAmountUsd);
  const safeCardAmount = Number.isFinite(parsedCardAmount) && parsedCardAmount >= 3
    ? parsedCardAmount
    : getCardRequestBaseAmount();
  const amount = String(safeCardAmount);
  const customerEmail = customer?.email || user?.customerEmail;
  if (!customerEmail) {
    await bot!.sendMessage(Number(userId), "❌ Missing email. Please update your KYC email and try again.", {
      reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
    });
    return;
  }

  if (isPrismaPersistenceEnabled()) {
    try {
      const payload = {
        name_on_card: nameOnCard,
        card_type: "visa",
        amount,
        customerEmail,
      };
      const resp = await callStroWallet("create-card", "post", payload);
      const data: any = resp?.data ?? resp;
      if (data?.success === false || data?.ok === false) {
        const providerMsg = data?.message || data?.error || "Card creation rejected";
        throw new Error(typeof providerMsg === "string" ? providerMsg : JSON.stringify(providerMsg));
      }

      const cardId = await resolveCreatedCardId({ userId, customerEmail, providerPayload: data, attempts: 3 });
      if (!cardId) {
        await prisma.cardRequest.create({
          data: {
            userId,
            nameOnCard,
            cardType: "visa",
            amount,
            customerEmail,
            mode: normalizeMode(getDefaultMode()) || null,
            status: "pending",
            responseData: data,
          },
        });

        await bot!.sendMessage(Number(userId), [
          "✅ Payment Verified",
          "Card request was accepted and is provisioning.",
          "Please check My Cards again in a moment.",
        ].join("\n"), {
          reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
        });
        return;
      }

      await prisma.cardRequest.create({
        data: {
          userId,
          nameOnCard,
          cardType: "visa",
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

      await prisma.card.upsert({
        where: { cardId },
        create: {
          cardId,
          userId,
          customerEmail,
          nameOnCard,
          cardType: "visa",
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
          cardType: "visa",
          status: data?.status || data?.state || "active",
          last4: data?.last4 || data?.card_last4 || (data?.card_number ? String(data.card_number).slice(-4) : null),
          currency: data?.currency || data?.ccy || null,
          balance: data?.balance != null ? String(data.balance) : (data?.available_balance != null ? String(data.available_balance) : null),
          availableBalance: data?.available_balance != null ? String(data.available_balance) : null,
        },
      });

      await bot!.sendMessage(Number(userId), [
        "✅ Payment Verified",
        "Your virtual card has been created successfully.",
        `Card ID: ${cardId}`,
      ].join("\n"), {
        reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
      });
      return;
    } catch (e: any) {
      const messageText = e?.response?.data?.error || e?.message || "Your card request could not be approved.";
      if (isLowBalanceErrorMessage(messageText)) {
        await notifyAdminLowBalanceIssue(messageText).catch(() => {});
        await bot!.sendMessage(Number(userId), [
          "✅ Payment received.",
          "Your card request is being processed.",
          "Provisioning may take a little longer than usual.",
        ].join("\n"), {
          reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
        });
        return;
      }
      await bot!.sendMessage(Number(userId), `❌ ${messageText}`, {
        reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
      });
      return;
    }
  }

  try {
    const resp = await axios.post(`${BACKEND_BASE}/api/card-requests`, {
      userId,
      nameOnCard,
      cardType: "visa",
      amount,
      customerEmail,
    });
    if (resp?.data?.ok) {
      await bot!.sendMessage(Number(userId), [
        "✅ Payment Verified",
        "Your virtual card has been created successfully.",
        resp?.data?.data?.cardId ? `Card ID: ${resp.data.data.cardId}` : undefined,
      ].filter(Boolean).join("\n"), {
        reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
      });
    } else {
      await bot!.sendMessage(Number(userId), "❌ Your card request could not be approved.", {
        reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
      });
    }
  } catch (e: any) {
    const messageText = e?.response?.data?.error || "Your card request could not be approved.";
    if (isLowBalanceErrorMessage(messageText)) {
      await notifyAdminLowBalanceIssue(messageText).catch(() => {});
      await bot!.sendMessage(Number(userId), [
        "✅ Payment received.",
        "Your card request is being processed.",
        "Provisioning may take a little longer than usual.",
      ].join("\n"), {
        reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
      });
      return;
    }
    await bot!.sendMessage(Number(userId), `❌ ${messageText}`, {
      reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
    });
  }
}

async function startCreateCardFlow(chatId: number, message?: any) {
  const { user, customer } = await getUserAndCustomerContext(String(chatId));
  const status = resolveKycStatus(user, customer);
  if (status !== "approved") {
    if (status === "pending") {
      await bot!.sendMessage(chatId, "⏳ KYC pending verification. Please wait before creating a card.", {
        reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
      });
    } else if (status === "rejected") {
      await bot!.sendMessage(chatId, "❌ Your KYC was rejected. Use /kyc_edit to resubmit.", {
        reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
      });
    } else {
      await bot!.sendMessage(chatId, "❌ You must complete and pass KYC before creating a card. Use /kyc.", {
        reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
      });
    }
    return;
  }

  const defaultName = [user?.firstName, user?.lastName].filter(Boolean).join(" ") || message?.from?.first_name || "StroWallet User";
  createCardSessions.set(chatId, { step: "name", data: { nameOnCard: defaultName } });
  await bot!.sendMessage(chatId, "Enter name on card (or send an empty message to keep default):", {
    reply_markup: { force_reply: true },
  });
}

async function handleCreateCardMessage(msg: any, session: CreateCardSession) {
  const chatId = msg.chat.id;
  if (!msg.text) {
    await bot!.sendMessage(chatId, "Please send a text response.", { reply_markup: { force_reply: true } });
    return;
  }
  const text = String(msg.text).trim();

  switch (session.step) {
    case "name":
      if (text) session.data.nameOnCard = text;
      session.step = "type";
      createCardSessions.set(chatId, session);
      await promptCreateCardStep(chatId, session);
      return;
    case "amount":
      if (!/^\d+(\.\d+)?$/.test(text) || Number(text) < 3) {
        await bot!.sendMessage(chatId, "Enter a valid amount (minimum 3) or tap Skip.", { reply_markup: { force_reply: true } });
        return;
      }
      session.data.amount = text;
      session.step = "confirm";
      createCardSessions.set(chatId, session);
      await promptCreateCardStep(chatId, session);
      return;
    default:
      await bot!.sendMessage(chatId, "Please use the buttons to continue.");
  }
}

async function promptCreateCardStep(chatId: number, session: CreateCardSession) {
  switch (session.step) {
    case "type":
      session.data.cardType = "visa";
      session.step = "amount";
      createCardSessions.set(chatId, session);
      await promptCreateCardStep(chatId, session);
      break;
    case "amount":
      await bot!.sendMessage(chatId, "Enter initial amount (minimum 3). You can skip to use 3:", {
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
      await bot!.sendMessage(chatId, buildCreateCardSummary(session.data), {
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

function buildCreateCardSummary(data: CreateCardSession["data"]) {
  const lines = [
    "Please confirm card details:",
    `Name on card: ${data.nameOnCard || "-"}`,
    `Card type: ${data.cardType || "-"}`,
    `Amount: ${data.amount || "0"}`,
  ];
  return lines.join("\n");
}

async function submitCreateCard(chatId: number, session: CreateCardSession) {
  const userId = String(chatId);
  const { user, customer } = await getUserAndCustomerContext(userId);
  if (!customer || customer.kycStatus !== "approved") {
    createCardSessions.delete(chatId);
    await bot!.sendMessage(chatId, "❌ You must complete and pass KYC before creating a card.", {
      reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
    });
    return;
  }
  const customerEmail = customer.email || user?.customerEmail;
  if (!customerEmail) {
    createCardSessions.delete(chatId);
    await bot!.sendMessage(chatId, "❌ Missing email. Please update your KYC email and try again.", {
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
    const cardId = await resolveCreatedCardId({ userId, customerEmail, providerPayload: data, attempts: 3 });
    if (cardId) {
      if (!isPrismaOnlyMode()) {
        await TelegramLink.findOneAndUpdate(
          { chatId },
          { $addToSet: { cardIds: cardId }, $set: { customerEmail } },
          { upsert: true, new: true }
        );
      }
      if (isPrismaPersistenceEnabled()) {
        await prisma.card.upsert({
          where: { cardId },
          create: {
            cardId,
            userId,
            customerEmail,
            nameOnCard: payload.name_on_card,
            cardType: payload.card_type,
            status: data?.status || data?.state || "active",
            currency: data?.currency || data?.ccy || null,
            balance: (data?.balance || data?.available_balance || null) != null ? String(data?.balance || data?.available_balance) : null,
            availableBalance: data?.available_balance != null ? String(data?.available_balance) : null,
            last4: data?.last4 || data?.card_last4 || null,
          },
          update: {
            userId,
            customerEmail,
            nameOnCard: payload.name_on_card,
            cardType: payload.card_type,
            status: data?.status || data?.state || "active",
            currency: data?.currency || data?.ccy || null,
            balance: (data?.balance || data?.available_balance || null) != null ? String(data?.balance || data?.available_balance) : null,
            availableBalance: data?.available_balance != null ? String(data?.available_balance) : null,
            last4: data?.last4 || data?.card_last4 || null,
          },
        });
      } else {
        await Card.findOneAndUpdate(
          { cardId },
          {
            $set: {
              cardId,
              userId,
              customerEmail,
              nameOnCard: payload.name_on_card,
              cardType: payload.card_type,
              status: data?.status || data?.state || "active",
              currency: data?.currency || data?.ccy,
              balance: data?.balance || data?.available_balance,
              availableBalance: data?.available_balance,
            },
          },
          { upsert: true, new: true }
        );
      }
    }
    createCardSessions.delete(chatId);
    await bot!.sendMessage(
      chatId,
      cardId
        ? `✅ Your StroWallet card has been created!\nCard ID: ${cardId}`
        : "✅ Card request accepted by provider. Card is provisioning and will appear shortly in My Cards.",
      { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } }
    );
  } catch (err: any) {
    createCardSessions.delete(chatId);
    const msg = err?.response?.data?.message || err?.response?.data?.error || err?.message || "Card creation failed";
    await bot!.sendMessage(chatId, `❌ ${msg}\nPlease try again.`, {
      reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
    });
  }
}

async function startKycFlow(chatId: number, message?: any, mode: "create" | "edit" = "create", user?: any) {
  const data: Partial<KycData> = {};
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
  await bot!.sendMessage(
    chatId,
    mode === "edit"
      ? "🪪 KYC Update\nLet's update your details. Please answer the following questions."
      : "🪪 KYC Verification\nLet's begin. Please answer the following questions.",
    { reply_markup: { inline_keyboard: [[{ text: "Cancel", callback_data: "CANCEL" }]] } }
  );
  await bot!.sendMessage(chatId, "Enter your first name:", { reply_markup: { force_reply: true } });
}

async function handleKycMessage(msg: any, session: KycSession) {
  const chatId = msg.chat.id;
  const text = msg.text ? String(msg.text).trim() : "";

  if (session.step === "idImage" || session.step === "idImageFront" || session.step === "idImageBack" || session.step === "userPhoto") {
    const url = await extractKycMediaUrl(msg, text);
    if (url) {
      if (session.step === "idImage") {
        session.data.idImage = url;
        session.step = "userPhoto";
      } else if (session.step === "idImageFront") {
        session.data.idImageFront = url;
        if (isPdfUrl(url)) {
          session.data.idImagePdf = url;
          session.data.idImage = url;
          session.step = "userPhoto";
        } else {
          session.step = "idImageBack";
        }
      } else if (session.step === "idImageBack") {
        session.data.idImageBack = url;
        if (!session.data.idImage) session.data.idImage = session.data.idImageFront || url;
        session.step = "userPhoto";
      } else if (session.step === "userPhoto") {
        session.data.userPhoto = url;
        session.step = "confirm";
      }

      kycSessions.set(chatId, session);
      await promptKycStep(chatId, session);
      return;
    }

    const hint = session.step === "userPhoto" ? "photo or image URL" : "photo, PDF, or URL";
    await bot!.sendMessage(chatId, `Please upload a ${hint}.`, { reply_markup: { force_reply: true } });
    return;
  }

  if (!text) {
    await bot!.sendMessage(chatId, "Please send a text response.", { reply_markup: { force_reply: true } });
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
        await bot!.sendMessage(chatId, "Invalid date format. Use MM/DD/YYYY.", { reply_markup: { force_reply: true } });
        return;
      }
      session.data.dateOfBirth = text;
      session.step = "phoneNumber";
      break;
    case "phoneNumber":
      if (!KYC_PHONE_REGEX.test(text)) {
        await bot!.sendMessage(chatId, "Invalid phone number. Use international format without '+'.", { reply_markup: { force_reply: true } });
        return;
      }
      session.data.phoneNumber = text;
      session.step = "customerEmail";
      break;
    case "customerEmail":
      if (!/.+@.+\..+/.test(text)) {
        await bot!.sendMessage(chatId, "Invalid email format. Try again.", { reply_markup: { force_reply: true } });
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
      await bot!.sendMessage(chatId, "Please select an ID type using the buttons.", {
        reply_markup: { inline_keyboard: buildKycIdTypeKeyboard() },
      });
      return;
    case "idNumber":
      session.data.idNumber = text;
      session.step = requiresIdBack(session.data.idType) ? "idImageFront" : "idImage";
      break;
    case "confirm":
      await bot!.sendMessage(chatId, "Please use the buttons to confirm submission.", {
        reply_markup: { inline_keyboard: buildKycConfirmKeyboard() },
      });
      return;
  }

  kycSessions.set(chatId, session);
  await promptKycStep(chatId, session);
}

async function promptKycStep(chatId: number, session: KycSession) {
  if (session.lastPromptStep === session.step) return;
  session.lastPromptStep = session.step;
  switch (session.step) {
    case "lastName":
      await bot!.sendMessage(chatId, "Enter your last name:", { reply_markup: { force_reply: true } });
      break;
    case "dateOfBirth":
      await bot!.sendMessage(chatId, "Enter your date of birth (MM/DD/YYYY):", { reply_markup: { force_reply: true } });
      break;
    case "phoneNumber":
      await bot!.sendMessage(chatId, "Enter your phone number (international, no '+'):", { reply_markup: { force_reply: true } });
      break;
    case "customerEmail":
      await bot!.sendMessage(chatId, "Enter your email address:", { reply_markup: { force_reply: true } });
      break;
    case "line1":
      await bot!.sendMessage(chatId, "Enter your street address (line1):", { reply_markup: { force_reply: true } });
      break;
    case "city":
      await bot!.sendMessage(chatId, "Enter your city:", { reply_markup: { force_reply: true } });
      break;
    case "state":
      await bot!.sendMessage(chatId, "Enter your state:", { reply_markup: { force_reply: true } });
      break;
    case "zipCode":
      await bot!.sendMessage(chatId, "Enter your ZIP code:", { reply_markup: { force_reply: true } });
      break;
    case "country":
      await bot!.sendMessage(chatId, "Enter your country (e.g., Ethiopia):", { reply_markup: { force_reply: true } });
      break;
    case "houseNumber":
      await bot!.sendMessage(chatId, "Enter your house number:", { reply_markup: { force_reply: true } });
      break;
    case "idType":
      await bot!.sendMessage(chatId, "Select your ID type:", {
        reply_markup: { inline_keyboard: buildKycIdTypeKeyboard() },
      });
      break;
    case "idImage":
      await bot!.sendMessage(chatId, "Upload your ID image (photo or URL):", { reply_markup: { force_reply: true } });
      break;
    case "idImageFront":
      await bot!.sendMessage(chatId, "Upload the FRONT of your ID (photo or PDF):", { reply_markup: { force_reply: true } });
      break;
    case "idImageBack":
      await bot!.sendMessage(chatId, "Upload the BACK of your ID (photo or PDF):", { reply_markup: { force_reply: true } });
      break;
    case "userPhoto":
      await bot!.sendMessage(chatId, "Upload your selfie (photo or URL):", { reply_markup: { force_reply: true } });
      break;
    case "confirm":
      await bot!.sendMessage(chatId, buildKycSummary(session.data), {
        reply_markup: { inline_keyboard: buildKycConfirmKeyboard() },
        disable_web_page_preview: true,
      });
      break;
    default:
      await bot!.sendMessage(chatId, "Enter your first name:", { reply_markup: { force_reply: true } });
  }
}

function buildKycIdTypeKeyboard(): InlineKeyboardButton[][] {
  return [
    KYC_ID_TYPES.map((t) => ({ text: t.label, callback_data: `KYC_IDTYPE::${t.value}` })),
    [MENU_BUTTON],
  ];
}

function buildKycConfirmKeyboard(): InlineKeyboardButton[][] {
  return [
    [
      { text: "✅ Submit KYC", callback_data: "KYC_CONFIRM::yes" },
      { text: "❌ Cancel", callback_data: "KYC_CONFIRM::no" },
    ],
    [MENU_BUTTON],
  ];
}

function buildKycSummary(data: Partial<KycData>) {
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

function maskIdNumber(idNumber: string) {
  if (!idNumber) return "";
  const last4 = idNumber.slice(-4);
  return `${"*".repeat(Math.max(0, idNumber.length - 4))}${last4}`;
}

function isHttpUrl(value: string) {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function requiresIdBack(idType?: KycIdType) {
  return idType === "NIN" || idType === "DRIVING_LICENSE";
}

function isPdfUrl(value: string) {
  return value.toLowerCase().includes(".pdf");
}

async function extractKycMediaUrl(msg: any, text?: string) {
  const photo = msg.photo?.[msg.photo.length - 1];
  if (photo?.file_id) {
    return await getTelegramFileUrl(photo.file_id);
  }
  const document = msg.document;
  if (document?.file_id) {
    return await getTelegramFileUrl(document.file_id);
  }
  if (text && isHttpUrl(text)) return text;
  return undefined;
}

async function getTelegramFileUrl(fileId: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN not set");
  const file = await bot!.getFile(fileId);
  if (!file?.file_path) throw new Error("Telegram file path unavailable");
  return `https://api.telegram.org/file/bot${token}/${file.file_path}`;
}

function isTelegramFileUrl(url?: string) {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.hostname === "api.telegram.org" && u.pathname.includes("/file/bot");
  } catch {
    return false;
  }
}

async function toDataUriFromUrl(url: string) {
  const resp = await axios.get(url, { responseType: "arraybuffer" });
  let contentType = (resp.headers?.["content-type"] as string | undefined) || "application/octet-stream";
  let buffer = Buffer.from(resp.data);
  if (contentType.startsWith("image/")) {
    try {
      buffer = await sharp(buffer)
        .rotate()
        .resize({ width: 800, height: 800, fit: "inside" })
        .jpeg({ quality: 70, mozjpeg: true })
        .toBuffer();
      contentType = "image/jpeg";
    } catch (e) {
      console.warn("[bot] Failed to compress image; using original", e);
      if (!contentType.startsWith("image/")) contentType = "image/jpeg";
    }
  } else {
    contentType = "image/jpeg";
  }
  const base64 = buffer.toString("base64");
  return `data:${contentType};base64,${base64}`;
}

let cloudinaryReady: boolean | null = null;

function ensureCloudinary() {
  if (cloudinaryReady !== null) return cloudinaryReady;
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  if (cloudName && apiKey && apiSecret) {
    cloudinary.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret, secure: true });
    cloudinaryReady = true;
    return true;
  }
  cloudinaryReady = false;
  return false;
}

async function uploadToCloudinary(buffer: Buffer) {
  const folder = process.env.CLOUDINARY_FOLDER || "strowallet-kyc";
  return await new Promise<string>((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, resource_type: "image" },
      (err, result) => {
        if (err) return reject(err);
        const url = result?.secure_url || result?.url;
        if (!url) return reject(new Error("Cloudinary upload missing URL"));
        resolve(url);
      }
    );
    stream.end(buffer);
  });
}

async function saveTelegramMedia(url: string) {
  const resp = await axios.get(url, { responseType: "arraybuffer" });
  const contentType = (resp.headers?.["content-type"] as string | undefined) || "application/octet-stream";
  let buffer = Buffer.from(resp.data);
  let ext = "jpg";
  if (contentType.startsWith("image/")) {
    try {
      buffer = await sharp(buffer)
        .rotate()
        .resize({ width: 800, height: 800, fit: "inside" })
        .jpeg({ quality: 70, mozjpeg: true })
        .toBuffer();
      ext = "jpg";
    } catch (e) {
      console.warn("[bot] Failed to compress image; using original", e);
    }
  }

  if (ensureCloudinary()) {
    try {
      return await uploadToCloudinary(buffer);
    } catch (e) {
      console.warn("[bot] Cloudinary upload failed; falling back to local upload", e);
    }
  }

  const uploadsDir = path.join(process.cwd(), "public", "uploads");
  await fs.mkdir(uploadsDir, { recursive: true });
  const name = `kyc_${Date.now()}_${crypto.randomBytes(6).toString("hex")}.${ext}`;
  const filePath = path.join(uploadsDir, name);
  await fs.writeFile(filePath, buffer);

  const baseUrl = (process.env.BOT_BACKEND_BASE || "http://localhost:3000").replace(/\/$/, "");
  return `${baseUrl}/uploads/${name}`;
}

async function embedTelegramMedia(url?: string) {
  if (!url || !isTelegramFileUrl(url)) return url;
  try {
    return await saveTelegramMedia(url);
  } catch (e) {
    console.warn("[bot] Failed to embed Telegram media; falling back to URL", e);
    return url;
  }
}

function getKycEncryptionKey() {
  const raw = process.env.KYC_ENCRYPTION_KEY;
  if (!raw) return null;
  try {
    const buf = raw.length === 64 ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
    if (buf.length !== 32) return null;
    return buf;
  } catch {
    return null;
  }
}

function encryptKycIdNumber(idNumber: string) {
  const key = getKycEncryptionKey();
  if (!key) return undefined;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(idNumber, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
}

function extractCustomerId(payload: any) {
  return (
    payload?.data?.customerId ||
    payload?.data?.customer_id ||
    payload?.data?.data?.customerId ||
    payload?.data?.data?.customer_id ||
    payload?.data?.response?.customerId ||
    payload?.data?.response?.customer_id ||
    payload?.customerId ||
    payload?.customer_id ||
    payload?.data?.id ||
    payload?.data?.data?.id ||
    payload?.id
  );
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureProviderAcceptedKyc(resp: any) {
  const data = resp?.data ?? resp ?? {};
  const successFlag = data?.success;
  const okFlag = data?.ok;
  const statusFlag = data?.status;
  const statusText = typeof statusFlag === "string" ? statusFlag.toLowerCase() : "";
  const explicitFailureStatus = ["failed", "error", "rejected", "invalid"].includes(statusText);

  // Some provider deployments return 200 with noisy/legacy `error(s)` fields even on success.
  // Treat only explicit false/failure status as rejection.
  if (successFlag === false || okFlag === false || statusFlag === false || explicitFailureStatus) {
    const providerMessage =
      data?.message ||
      data?.error ||
      data?.errors?.[0]?.message ||
      "KYC request was rejected by provider";
    const err: any = new Error(String(providerMessage));
    err.status = 400;
    throw err;
  }
}

async function submitKyc(chatId: number, session: KycSession) {
  const data = session.data as KycData;
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
  ].filter((k) => !(data as any)[k]);

  const needsBothSides = requiresIdBack(data.idType);
  const hasPdf = Boolean(data.idImagePdf);
  if (needsBothSides && !hasPdf) {
    if (!data.idImageFront) missing.push("idImageFront");
    if (!data.idImageBack) missing.push("idImageBack");
  }
  if (!needsBothSides && !data.idImage) {
    missing.push("idImage");
  }

  if (missing.length) {
    await bot!.sendMessage(chatId, "Missing required fields. Please restart /kyc.", {
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
    customerId: undefined as string | undefined,
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
    const userId = String(chatId);
    const { user } = await getUserAndCustomerContext(userId);
    let resp: any;
    if (session.mode === "edit") {
      const customerId = user?.strowalletCustomerId;
      if (!customerId) {
        throw Object.assign(new Error("Missing StroWallet customer ID. Please resubmit /kyc."), { status: 400 });
      }
      updatePayload.customerId = customerId;
      resp = await callStroWallet("updateCardCustomer", "put", updatePayload);
    } else {
      resp = await callStroWallet("create-user", "post", createPayload);
    }

    console.log("[bot] KYC provider response", {
      chatId,
      mode: session.mode,
      hasCustomerId: Boolean(extractCustomerId(resp)),
      success: (resp as any)?.success,
      status: (resp as any)?.status,
      message: (resp as any)?.message,
      error: (resp as any)?.error,
    });

    ensureProviderAcceptedKyc(resp);

    let customerId = extractCustomerId(resp);
    if (!customerId && session.mode === "create") {
      try {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          await sleep(1200);
          const lookup = await callStroWallet(
            "getcardholder",
            "get",
            { customerEmail: data.customerEmail },
            { silentOnStatus: [404] }
          );
          customerId = extractCustomerId(lookup);
          if (customerId) break;
        }
      } catch (e) {
        console.warn("[bot] KYC customerId lookup failed", e);
      }
    }
    if (!customerId && session.mode === "create") {
      // Some providers return 200 for create-user but delay customerId availability.
      // Keep KYC pending and let later status sync resolve customerId by email.
      console.warn("[bot] KYC create-user succeeded without immediate customerId", {
        chatId,
        email: data.customerEmail,
      });
    }
    const idNumberEncrypted = encryptKycIdNumber(data.idNumber);
    if (!idNumberEncrypted) {
      console.warn("[bot] KYC_ENCRYPTION_KEY missing or invalid; idNumber not encrypted at rest");
    }
    const idNumberLast4 = data.idNumber.slice(-4);
    if (isPrismaPersistenceEnabled()) {
      await prisma.user.upsert({
        where: { userId },
        create: {
          userId,
          telegramId: user?.telegramId || userId,
          chatId: user?.chatId || userId,
          username: user?.username,
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
        update: {
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
      });
    } else {
      await User.findOneAndUpdate(
        { userId },
        {
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
        },
        { upsert: true, new: true }
      );

      await Customer.findOneAndUpdate(
        { userId },
        {
          $set: {
            customerId: customerId || undefined,
            email: data.customerEmail,
            telegramId: user?.telegramId || userId,
            chatId: user?.chatId || userId,
            username: user?.username,
            firstName: data.firstName,
            lastName: data.lastName,
            dateOfBirth: data.dateOfBirth,
            phoneNumber: data.phoneNumber,
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
            kycStatus: "pending",
            submittedAt: new Date(),
            approvedAt: undefined,
            rawPayload: {
              request: session.mode === "edit" ? updatePayload : createPayload,
              response: resp,
            },
          },
        },
        { upsert: true, new: true }
      );
    }

    kycSessions.delete(chatId);
    await bot!.sendMessage(chatId, session.mode === "edit"
      ? "✅ Your updated KYC has been submitted successfully. Status: pending approval."
      : "✅ KYC submitted. Status: pending approval.", {
      reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
    });
  } catch (err: any) {
    kycSessions.delete(chatId);
    if (err?.status === 400) {
      const providerDetail = typeof err?.message === "string" && err.message.trim().length
        ? `\nReason: ${err.message.trim()}`
        : "";
      await bot!.sendMessage(chatId, `❌ Invalid/missing data. Please retry with /kyc.${providerDetail}`, {
        reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
      });
      return;
    }
    await sendFriendlyError(chatId, err?.requestId);
  }
}

async function refreshKycStatusFromStroWallet(user: any): Promise<KycStatus | undefined> {
  try {
    const existingCustomer = isPrismaPersistenceEnabled()
      ? null
      : await Customer.findOne({ userId: String(user?.userId) }).lean();
    const customerId = user?.strowalletCustomerId || existingCustomer?.customerId;
    const customerEmail = user?.customerEmail || existingCustomer?.email;
    if (!customerId && !customerEmail) return undefined;
    const resp = await callStroWallet(
      "getcardholder",
      "get",
      {
        customerId,
        customerEmail,
      },
      { silentOnStatus: [404] }
    );
    if ((resp as any)?.ok === false) return undefined;
    const data = resp?.data ?? resp;
    const providerCustomerId = extractCustomerId(resp);
    const statusRaw =
      data?.status ||
      data?.kycStatus ||
      data?.verificationStatus ||
      data?.state ||
      data?.data?.status ||
      data?.data?.kycStatus ||
      data?.data?.verificationStatus ||
      data?.data?.state;

    const normalized = normalizeKycStatus(statusRaw);
    const previous = normalizeKycStatus(existingCustomer?.kycStatus || user?.kycStatus);
    const userId = String(user.userId);

    if ((normalized && normalized !== user?.kycStatus) || (providerCustomerId && !user?.strowalletCustomerId)) {
      if (isPrismaPersistenceEnabled()) {
        await prisma.user.update({
          where: { userId },
          data: {
            ...(normalized ? { kycStatus: normalized } : {}),
            ...(providerCustomerId ? { strowalletCustomerId: providerCustomerId } : {}),
          },
        });
      } else {
        await User.findOneAndUpdate(
          { userId },
          { $set: { kycStatus: normalized || user?.kycStatus, ...(providerCustomerId ? { strowalletCustomerId: providerCustomerId } : {}) } },
          { new: true }
        );
      }
    }

    if (!isPrismaPersistenceEnabled() && (normalized || providerCustomerId)) {
      await Customer.findOneAndUpdate(
        { userId },
        {
          $set: {
            ...(providerCustomerId ? { customerId: providerCustomerId } : {}),
            ...(normalized ? { kycStatus: normalized } : {}),
            ...(normalized === "approved" ? { approvedAt: new Date() } : {}),
          },
        },
        { new: true, upsert: true }
      );
    }

    if (normalized && normalized !== previous && (normalized === "approved" || normalized === "rejected")) {
      const lastNotified = existingCustomer?.lastKycNotificationStatus as "approved" | "rejected" | undefined;
      if (lastNotified !== normalized) {
        await notifyKycStatus(userId, normalized).catch(() => {});
        if (!isPrismaPersistenceEnabled()) {
          await Customer.findOneAndUpdate(
            { userId },
            { $set: { lastKycNotificationStatus: normalized, lastKycNotifiedAt: new Date() } },
            { new: true, upsert: true }
          );
        }
      }
    }

    return normalized;
  } catch {
    return undefined;
  }
}

function normalizeKycStatus(value: any): KycStatus | undefined {
  if (!value) return undefined;
  const v = String(value).toLowerCase();
  const compact = v.replace(/[\s_-]+/g, "");
  if (["approved", "verified", "success", "active", "highkyc"].includes(compact)) return "approved";
  if (["pending", "processing", "review", "unreviewkyc"].includes(compact)) return "pending";
  if (["declined", "rejected", "failed", "lowkyc"].includes(compact)) return "rejected";
  return undefined;
}

function resolveKycStatus(user?: any, customer?: any): KycStatus | "not_started" {
  if (customer?.kycStatus) return customer.kycStatus as KycStatus;
  const raw = user?.kycStatus;
  if (!raw) return "not_started";
  const normalized = normalizeKycStatus(raw);
  return normalized || (raw === "not_started" ? "not_started" : "pending");
}

async function sendKycStatus(chatId: number) {
  const { user, customer } = await getUserAndCustomerContext(String(chatId));
  let status = resolveKycStatus(user, customer);
  if (user && status !== "approved" && status !== "rejected") {
    const refreshed = await refreshKycStatusFromStroWallet(user);
    if (refreshed) status = refreshed;
  }
  if (status === "not_started") {
    await bot!.sendMessage(chatId, "No KYC record found. Use /kyc to submit.", {
      reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
    });
    return;
  }
  const label = status === "approved" ? "Approved" : status === "pending" ? "Waiting for approval" : "Verification failed — use /kyc_edit";
  await bot!.sendMessage(chatId, `Your KYC status: ${label}.`, {
    reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
  });
}

function formatMaskedCard(last4?: string) {
  return `**** **** **** ${last4 || "----"}`;
}

function formatCardMoney(value: any, currency?: string) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return undefined;
  const normalized = (currency || "USD").toUpperCase();
  if (normalized === "USD" || normalized === "USDT") return `$${amount.toFixed(2)}`;
  return `${amount.toFixed(2)} ${normalized}`;
}

function extractExpiry(detail: any) {
  if (!detail) return undefined;
  const month = detail?.exp_month || detail?.expiry_month || detail?.expMonth || detail?.expiryMonth;
  const year = detail?.exp_year || detail?.expiry_year || detail?.expYear || detail?.expiryYear;
  if (month && year) return `${String(month).padStart(2, "0")}/${String(year).slice(-2)}`;
  const raw = detail?.expiry || detail?.expiry_date || detail?.exp || detail?.expDate;
  return raw ? String(raw) : undefined;
}

function isFrozenStatus(raw?: string) {
  return String(raw || "").toLowerCase().includes("frozen");
}

function pickNestedField(obj: any, keys: string[]): string | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  for (const key of keys) {
    if (obj[key] != null) return String(obj[key]);
  }
  for (const val of Object.values(obj)) {
    if (val && typeof val === "object") {
      const nested = pickNestedField(val, keys);
      if (nested != null) return nested;
    }
  }
  return undefined;
}

function normalizeCardDetail(raw: any) {
  if (!raw || typeof raw !== "object") return null;
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
  const line1 = pickNestedField(raw, ["line1", "address", "addressLine1", "address_line1"]);
  const city = pickNestedField(raw, ["city", "town"]);
  const state = pickNestedField(raw, ["state", "province", "region"]);
  const zip = pickNestedField(raw, ["zip", "zipCode", "postal", "postalCode"]);
  const country = pickNestedField(raw, ["country"]);
  const billingParts = [billingStreet || line1, billingCity || city].filter(Boolean).join(", ");
  const addressParts = [billingState || state, billingZip || zip, billingCountry || country].filter(Boolean).join(", ");
  const billing = billingRaw || (billingParts ? billingParts : undefined);
  const address = addressParts ? addressParts : undefined;
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

async function sendUserInfo(chatId: number, message?: any) {
  if (shouldSuppressOutgoing(chatId, "user_info")) return;
  const [link, profile, primaryCard] = await Promise.all([
    isPrismaOnlyMode() ? Promise.resolve(null) : TelegramLink.findOne({ chatId }).lean(),
    getUserAndCustomerContext(String(chatId)),
    getPrimaryCardForUser(String(chatId)),
  ]);
  const { user, customer } = profile;
  const baseBalance = user?.balance ?? 0;
  const currency = user?.currency || "USDT";
  const email = user?.customerEmail || link?.customerEmail;
  const kycStatus = resolveKycStatus(user, customer);
  const kycLabel = kycStatus === "approved" ? "Approved ✅ (use /kyc to resubmit)" : "/kyc";
  const cardId = primaryCard?.cardId;
  const remoteDetail = cardId ? await fetchCardDetailSafe(cardId) : null;
  const walletBalance = Number(baseBalance);
  const cardBalance = Number(remoteDetail?.balance ?? remoteDetail?.available_balance ?? NaN);
  const last4 = remoteDetail?.last4 || primaryCard?.last4 || (primaryCard as any)?.cardNumber?.slice(-4);
  const cardStatusRaw = remoteDetail?.status || primaryCard?.status;
  const cardStatus = cardStatusRaw ? String(cardStatusRaw) : undefined;
  const cardStatusLabel = cardStatus ? cardStatus.charAt(0).toUpperCase() + cardStatus.slice(1) : undefined;
  const username = user?.username ? `@${String(user.username)}` : undefined;
  const nameSource = user?.firstName || user?.lastName
    ? `${user?.firstName || ""} ${user?.lastName || ""}`.trim()
    : (user?.username ? String(user.username) : "User");
  const hasReadyProfile = Boolean(email) && kycStatus === "approved" && Boolean(primaryCard);

  const lines = [
    "🧑‍💻 Here's Your Profile:",
    `👤 Name: ${nameSource}${username ? ` (${username})` : ""}`,
    `👤 User ID: ${chatId}`,
    `✉️ Email: ${email || "/linkemail"}`,
    `KYC: ${kycLabel}`,
    `Wallet: ${hasReadyProfile ? `${Number.isFinite(walletBalance) ? walletBalance.toFixed(2) : "0.00"} ${currency}` : "/card_request"}`,
    hasReadyProfile && Number.isFinite(cardBalance)
      ? `Card Balance: ${cardBalance.toFixed(2)} ${(remoteDetail?.currency || primaryCard?.currency || "USD").toUpperCase()}`
      : undefined,
    `Cards: ${hasReadyProfile ? "1" : "/card_request"}`,
    "💳 Virtual Card",
    `• Status: ${hasReadyProfile ? (cardStatusLabel || "Active") : "No Card"}`,
    `• Last 4 digits: ${hasReadyProfile ? (last4 || "****") : "****"}`,
  ].filter(Boolean) as string[];

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

function chunk<T>(items: T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    rows.push(items.slice(i, i + size));
  }
  return rows;
}

async function sendWalletSummary(chatId: number, message?: any) {
  if (shouldSuppressOutgoing(chatId, "wallet_summary")) return;
  const [link, user, primaryCard] = await Promise.all([
    isPrismaOnlyMode() ? Promise.resolve(null) : TelegramLink.findOne({ chatId }).lean(),
    isPrismaPersistenceEnabled() ? prisma.user.findUnique({ where: { userId: String(chatId) } }) : User.findOne({ userId: String(chatId) }).lean(),
    getPrimaryCardForUser(String(chatId)),
  ]);
  const baseWalletBalance = user?.balance ?? 0;
  const currency = user?.currency || "USDT";
  const cardId = primaryCard?.cardId || link?.cardIds?.[0];
  const remoteDetail = cardId ? await fetchCardDetailSafe(cardId) : null;
  const walletBalance = Number(baseWalletBalance);
  const cardBalance = Number(remoteDetail?.balance ?? remoteDetail?.available_balance ?? NaN);
  const cardCurrency = (remoteDetail?.currency || primaryCard?.currency || "USD").toUpperCase();
  const last4 = remoteDetail?.last4 || primaryCard?.last4 || (primaryCard as any)?.cardNumber?.slice(-4);

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
    inline_keyboard: [[{ text: "🔍 My Cards", callback_data: "MENU_MY_CARDS" }], [MENU_BUTTON]],
  });
}


async function sendMyCards(chatId: number, message?: any) {
  if (!shouldSuppressOutgoing(chatId, "my_cards_loading", 1500)) {
    await editOrSend(chatId, message, "Loading your card...", {
      inline_keyboard: [[MENU_BUTTON]],
    });
  }
  const userId = String(chatId);
  if (isPrismaOnlyMode()) {
    const user = await prisma.user.findUnique({ where: { userId } });
    let card: any = await getPrimaryCardForUser(userId);
    if (!card) {
      const recoveredCardId = await resolveCreatedCardId({
        userId,
        customerEmail: user?.customerEmail || undefined,
        attempts: 1,
      });
      if (recoveredCardId) {
        card = await prisma.card.upsert({
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
        "Card Number: /card_request",
      ].join("\n"), {
        inline_keyboard: [[MENU_BUTTON]],
      });
      return;
    }

    const remoteDetail = await fetchCardDetailSafe(String(card.cardId));

    if (remoteDetail) {
      card = await prisma.card.update({
        where: { cardId: String(card.cardId) },
        data: {
          status: remoteDetail.status || card.status || undefined,
          last4: remoteDetail.last4 || card.last4 || null,
          currency: remoteDetail.currency || card.currency || null,
          balance:
            remoteDetail.balance != null
              ? String(remoteDetail.balance)
              : remoteDetail.available_balance != null
                ? String(remoteDetail.available_balance)
                : card.balance,
          availableBalance:
            remoteDetail.available_balance != null
              ? String(remoteDetail.available_balance)
              : card.availableBalance,
        },
      });
    }

    const statusText = isFrozenStatus(card.status || undefined) ? "❄️ Frozen" : "✅ Active";
    const cardName = String(remoteDetail?.name_on_card || card.nameOnCard || "").trim();
    const fullCardNumberRaw = String(remoteDetail?.card_number || "").replace(/\s+/g, "").trim();
    const fullCardNumber = fullCardNumberRaw.length >= 12
      ? fullCardNumberRaw.replace(/(.{4})/g, "$1 ").trim()
      : undefined;
    const cvc = String(remoteDetail?.cvc || "").trim();
    const validThru = extractExpiry(remoteDetail || card);
    const balanceLabel = formatCardMoney(
      (remoteDetail?.balance ?? remoteDetail?.available_balance ?? card.balance ?? user?.balance),
      remoteDetail?.currency || card.currency || user?.currency || "USD"
    );
    const lines = [
      "💳 Your Virtual Card",
      `Card Type: ${String(card.cardType || "virtual").toLowerCase()}`,
      `Status: ${statusText}`,
      cardName ? `Card Name: ${cardName}` : undefined,
      `Card Number: ${fullCardNumber || formatMaskedCard((remoteDetail?.last4 || card.last4) || undefined)}`,
      cvc ? `CVV: ${cvc}` : undefined,
      validThru ? `Valid Thru: ${validThru}` : undefined,
      `Billing: ${remoteDetail?.billing || "None"}`,
      `Address: ${remoteDetail?.address || "None"}`,
      balanceLabel ? `Balance: ${balanceLabel}` : undefined,
    ].filter(Boolean) as string[];
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
    User.findOne({ userId }).lean(),
    Customer.findOne({ userId }).lean(),
    TelegramLink.findOne({ chatId }).lean(),
    getUserCardIds(chatId),
  ]);
  const customerEmail = customer?.email || user?.customerEmail || link?.customerEmail;
  const [latestRequest, primaryCard] = await Promise.all([
    CardRequest.findOne({ $or: [{ userId }, { customerEmail }] }).sort({ updatedAt: -1 }).lean(),
    Card.findOne({ $or: [{ userId }, { customerEmail }] }).sort({ updatedAt: -1 }).lean(),
  ]);
  const linkedCardId = cardIds[0];
  const linkedCard = linkedCardId ? await Card.findOne({ cardId: linkedCardId }).lean() : null;
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
  const noCardKeyboard: InlineKeyboardButton[][] = [
    [
      { text: "🔍 Transactions", callback_data: "CARD_TXN_NO_CARD" },
      { text: "❄️ Freeze Card", callback_data: "CARD_FREEZE_NO_CARD" },
    ],
    [MENU_BUTTON],
  ];

  const card = resolvedCard || (latestRequest?.cardId ? await Card.findOne({ cardId: latestRequest.cardId }).lean() : null);
  const cardId = card?.cardId || latestRequest?.cardId || linkedCardId;

  if (!card && !cardId) {
    await editOrSend(chatId, message, noCardLines.join("\n"), {
      inline_keyboard: noCardKeyboard,
    });
    return;
  }

  const activeCard = card || {
    cardId: cardId as string,
    status: latestRequest?.status === "approved" ? "active" : latestRequest?.status,
    cardType: latestRequest?.cardType,
    last4: latestRequest?.cardNumber?.slice(-4),
    currency: user?.currency || "USD",
    balance: user?.balance,
  };

  const remoteDetail = !card?.last4 || !card?.balance || !card?.currency ? await fetchCardDetailSafe(activeCard.cardId) : null;
  const mergedDetail = remoteDetail || null;

  const last4 = mergedDetail?.last4 || activeCard.last4 || latestRequest?.cardNumber?.slice(-4);
  const cardType = String(mergedDetail?.card_type || activeCard.cardType || latestRequest?.cardType || "virtual").toLowerCase();
  const cvc = (mergedDetail?.cvc || (latestRequest as any)?.cvc || "").toString();
  const cardName = String(mergedDetail?.name_on_card || (activeCard as any)?.nameOnCard || latestRequest?.nameOnCard || "").trim();
  const fullCardNumberRaw = String(mergedDetail?.card_number || (latestRequest as any)?.cardNumber || "").replace(/\s+/g, "").trim();
  const fullCardNumber = fullCardNumberRaw.length >= 12
    ? fullCardNumberRaw.replace(/(.{4})/g, "$1 ").trim()
    : undefined;
  const statusText = isFrozenStatus(activeCard.status) ? "❄️ Frozen" : "✅ Active";
  const balanceLabel = formatCardMoney(
    mergedDetail?.balance ?? mergedDetail?.available_balance ?? activeCard.balance ?? user?.balance,
    mergedDetail?.currency || activeCard.currency || user?.currency || "USD"
  );
  const expiry = extractExpiry(mergedDetail) || extractExpiry(latestRequest?.responseData || latestRequest?.metadata || {});
  const billing = mergedDetail?.billing || latestRequest?.metadata?.billing;
  const address = mergedDetail?.address || latestRequest?.metadata?.address;
  const lines = [
    "💳 Your Virtual Card",
    `Card Type: ${cardType}`,
    `Status: ${statusText}`,
    cardName ? `Card Name: ${cardName}` : undefined,
    `Card Number: ${fullCardNumber || formatMaskedCard(last4)}`,
    `CVV: ${cvc || "None"}`,
    expiry ? `Valid Thru: ${expiry}` : undefined,
    balanceLabel ? `Balance: ${balanceLabel}` : undefined,
    `Billing: ${billing || "None"}`,
    `Address: ${address || "None"}`,
  ].filter(Boolean) as string[];

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

function isLikelyCardId(value?: string) {
  if (!value) return false;
  if (value.startsWith("/")) return false;
  if (value.length < 6) return false;
  return /^[A-Za-z0-9_-]+$/.test(value) || /^[A-Za-z0-9-]{6,}$/.test(value);
}

async function getUserCardIds(chatId: number) {
  const userId = String(chatId);
  let cards;
  if (isPrismaPersistenceEnabled()) {
    const user = await prisma.user.findUnique({ where: { userId } });
    const customerEmail = user?.customerEmail || undefined;
    cards = await prisma.card.findMany({
      where: {
        OR: [{ userId }, ...(customerEmail ? [{ customerEmail }] : [])],
      },
      orderBy: { updatedAt: "desc" },
    });
  } else {
    cards = await Card.find({ userId }).lean();
  }
  const cardIdsFromCards = cards.map((c: any) => c.cardId).filter(isLikelyCardId);
  if (cardIdsFromCards.length) return Array.from(new Set(cardIdsFromCards));

  const requests = isPrismaOnlyMode()
    ? []
    : await CardRequest.find({ userId, status: "approved", cardId: { $exists: true, $ne: "" } }).lean();
  const requestIds = requests.map((r) => String(r.cardId)).filter(isLikelyCardId);
  if (requestIds.length) return Array.from(new Set(requestIds));

  const legacyLink = isPrismaOnlyMode() ? null : await TelegramLink.findOne({ chatId }).lean();
  const legacyIds = (legacyLink?.cardIds || []).filter(isLikelyCardId);
  if (!isPrismaOnlyMode() && legacyLink && legacyIds.length !== (legacyLink.cardIds || []).length) {
    await TelegramLink.updateOne({ chatId }, { $set: { cardIds: legacyIds } });
  }
  return Array.from(new Set(legacyIds));
}

async function getPrimaryCardForUser(userId: string) {
  if (isPrismaPersistenceEnabled()) {
    const user = await prisma.user.findUnique({ where: { userId } });
    const customerEmail = user?.customerEmail || undefined;
    const card = await prisma.card.findFirst({
      where: {
        OR: [{ userId }, ...(customerEmail ? [{ customerEmail }] : [])],
      },
      orderBy: { updatedAt: "desc" },
    });
    if (card) return card;

    const request = await prisma.cardRequest.findFirst({
      where: {
        status: "approved",
        cardId: { not: null },
        OR: [{ userId }, ...(customerEmail ? [{ customerEmail }] : [])],
      },
      orderBy: { updatedAt: "desc" },
    });
    if (!request?.cardId) return null;
    return {
      cardId: String(request.cardId),
      cardType: request.cardType,
      status: "active",
      last4: request.cardNumber ? request.cardNumber.slice(-4) : undefined,
      balance: undefined,
      currency: undefined,
    } as any;
  }

  const card = await Card.findOne({ userId })
    .sort({ updatedAt: -1 })
    .lean();
  if (card) return card;
  const request = await CardRequest.findOne({ userId, status: "approved", cardId: { $exists: true, $ne: "" } })
    .sort({ updatedAt: -1 })
    .lean();
  if (!request) return null;
  return {
    cardId: String(request.cardId),
    cardType: request.cardType,
    status: (request as any)?.responseData?.response?.card_status || "pending",
    last4: request.cardNumber ? request.cardNumber.slice(-4) : undefined,
    balance: undefined,
    currency: undefined,
  } as any;
}

async function sendMyCardSummary(chatId: number) {
  const card = await getPrimaryCardForUser(String(chatId));
  if (!card) {
    await bot!.sendMessage(chatId, "❌ No cards linked yet. Use /linkcard CARD_ID to link one.", { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
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

  await bot!.sendMessage(chatId, lines.join("\n"), { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
}

async function sendCardStatus(chatId: number) {
  const card = await getPrimaryCardForUser(String(chatId));
  if (!card) {
    await bot!.sendMessage(chatId, "❌ No cards linked yet.", { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
    return;
  }
  const status = card.status ? String(card.status) : "unknown";
  await bot!.sendMessage(chatId, `Status: ${status}`, { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
}

async function sendCardDetail(chatId: number, cardId: string) {
  try {
    const user = isPrismaPersistenceEnabled()
      ? await prisma.user.findUnique({ where: { userId: String(chatId) } })
      : await User.findOne({ userId: String(chatId) }).lean();
    const walletBalance = user?.balance ?? 0;
    const card = isPrismaPersistenceEnabled()
      ? await prisma.card.findUnique({ where: { cardId } })
      : await Card.findOne({ cardId }).lean();

    // If this card was generated locally, serve synthetic details and avoid upstream call
    const local = isPrismaOnlyMode() ? null : await CardRequest.findOne({ cardId, status: "approved" }).lean();
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
      await bot!.sendMessage(chatId, text, {
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
    await bot!.sendMessage(chatId, text, {
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
  } catch (err: any) {
    await sendFriendlyError(chatId, err?.requestId);
  }
}

async function sendCardRevealPrompt(chatId: number, cardId: string) {
  const lines = [
    "🔐 Confirm to view full card details.",
    "This helps prevent accidental exposure.",
  ];
  await bot!.sendMessage(chatId, lines.join("\n"), {
    reply_markup: {
      inline_keyboard: [
        [{ text: "Show Details", callback_data: `CARD_REVEAL_CONFIRM::${cardId}` }],
        [{ text: "Cancel", callback_data: "MENU_MY_CARDS" }],
        [MENU_BUTTON],
      ],
    },
  });
}

async function sendCardSensitiveDetails(chatId: number, cardId: string) {
  if (!shouldSuppressOutgoing(chatId, `card_reveal:${cardId}`, 1500)) {
    await bot!.sendMessage(chatId, "Loading card details...", {
      reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
    });
  }
  const local = await CardRequest.findOne({ cardId, status: "approved" }).lean();
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
    await bot!.sendMessage(chatId, "Full card details are not available. Please try again later or contact support.", {
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
  ].filter(Boolean) as string[];

  await bot!.sendMessage(chatId, lines.join("\n"), {
    reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
  });
}

async function sendCardTransactions(chatId: number, cardId?: string, pageRaw: number = 1, daysFilterRaw: number = 0) {
  try {
    const userId = String(chatId);
    const pageSize = 10;
    const requestedPage = Number.isFinite(pageRaw) ? Math.max(1, Math.floor(pageRaw)) : 1;
    const allowedFilters = new Set([0, 7, 30, 90]);
    const parsedDays = Number(daysFilterRaw);
    const daysFilter = Number.isFinite(parsedDays) && allowedFilters.has(parsedDays) ? parsedDays : 0;
    if (!shouldSuppressOutgoing(chatId, `user_txn_loading:${cardId || "all"}`, 1500)) {
      await bot!.sendMessage(chatId, "Loading transactions...", {
        reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
      });
    }

    let txns: any[] = [];
    let totalCount = 0;
    let page = 1;

    if (isPrismaPersistenceEnabled()) {
      const since = daysFilter > 0 ? new Date(Date.now() - daysFilter * 24 * 60 * 60 * 1000) : null;
      const rows = await prisma.transaction.findMany({
        where: {
          userId,
          transactionType: "card",
          ...(since ? { createdAt: { gte: since } } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: 500,
      });

      const filtered = cardId
        ? (() => {
            const out: any[] = [];
            for (const row of rows as any[]) {
              const metaCardId = String((row as any)?.metadata?.cardId || "");
              const respCardId = String((row as any)?.responseData?.card_id || (row as any)?.responseData?.cardId || "");
              if (metaCardId === cardId || respCardId === cardId) out.push(row);
            }
            return out;
          })()
        : rows;

      totalCount = filtered.length;
      const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
      page = Math.min(requestedPage, totalPages);
      txns = filtered.slice((page - 1) * pageSize, page * pageSize);
    } else {
      const query: any = { userId };
      if (cardId) query["metadata.cardId"] = cardId;
      if (daysFilter > 0) {
        const since = new Date(Date.now() - daysFilter * 24 * 60 * 60 * 1000);
        query.createdAt = { $gte: since };
      }
      totalCount = await Transaction.countDocuments(query);
      const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
      page = Math.min(requestedPage, totalPages);
      txns = await Transaction.find(query)
        .sort({ createdAt: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .lean();
    }

    const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

    if (!txns.length) {
      await bot!.sendMessage(chatId, "No transactions found yet.", { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
      return;
    }

    const lines = [
      "📊 Transaction History",
      `Showing ${txns.length} of ${totalCount} (Page ${page}/${totalPages})`,
      `Range: ${daysFilter > 0 ? `Last ${daysFilter} days` : "All time"}`,
      "",
    ];
    const keyboard: InlineKeyboardButton[][] = [];

    for (const t of txns) {
      const meta = (t as any).metadata || {};
      const type = String((t as any).transactionType || "transaction");
      const direction = meta.direction === "debit" || type === "withdrawal" ? "-" : "+";
      const amountValue = Number(((t as any).amountUsdt ?? (t as any).amount) || 0);
      const currency = (t as any).currency || "USDT";
      const statusIcon = formatTxnStatusIcon((t as any).status || meta.rawStatus);
      const rawLabel = meta.description || type.replace(/_/g, " ");
      const label = formatTxnLabel(meta.direction, rawLabel);
      const dateLabel = formatTxnDate(meta.date) || formatTxnDate((t as any).createdAt);
      const amountLabel = `${direction} ${amountValue.toFixed(2)} ${currency}`;
      lines.push(`${statusIcon} ${label} (${type})`);
      lines.push(amountLabel);
      if (dateLabel) lines.push(`${dateLabel}`);
      lines.push("");

      keyboard.push([
        {
          text: `${label} ${amountLabel}`,
          callback_data: `TXN_DETAIL::${String((t as any).id || (t as any)._id)}`,
        },
      ]);
    }

    const buildFilterCallback = (days: number) => {
      if (cardId) return `TXN_FILTER_CARD::${cardId}::${days}`;
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
      const navRow: InlineKeyboardButton[] = [];
      if (page > 1) {
        navRow.push(
          cardId
            ? { text: "⬅️ Prev", callback_data: `TXN_PAGE_CARD::${cardId}::${page - 1}::${daysFilter}` }
            : { text: "⬅️ Prev", callback_data: `TXN_PAGE_ALL::${page - 1}::${daysFilter}` }
        );
      }
      if (page < totalPages) {
        navRow.push(
          cardId
            ? { text: "Next ➡️", callback_data: `TXN_PAGE_CARD::${cardId}::${page + 1}::${daysFilter}` }
            : { text: "Next ➡️", callback_data: `TXN_PAGE_ALL::${page + 1}::${daysFilter}` }
        );
      }
      if (navRow.length) keyboard.push(navRow);
    }

    keyboard.push([MENU_BUTTON]);
    await bot!.sendMessage(chatId, lines.join("\n"), { reply_markup: { inline_keyboard: keyboard } });
  } catch (err: any) {
    await sendFriendlyError(chatId, err?.requestId);
  }
}

async function sendCardTransactionDetail(chatId: number, txnId: string) {
  if (!shouldSuppressOutgoing(chatId, `txn_detail_loading:${txnId}`, 1500)) {
    await bot!.sendMessage(chatId, "Loading transaction details...", {
      reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
    });
  }
  const txn = isPrismaPersistenceEnabled()
    ? await prisma.transaction.findUnique({ where: { id: txnId } })
    : await Transaction.findById(txnId).lean();
  if (!txn) {
    await bot!.sendMessage(chatId, "Transaction not found.", { reply_markup: { inline_keyboard: [[MENU_BUTTON]] } });
    return;
  }

  const meta = (txn as any).metadata || {};
  const responseData = (txn as any).responseData || {};
  const direction = meta.direction === "debit" ? "-" : "+";
  const amountValue = Number((txn as any).amount || 0);
  const currency = (txn as any).currency || "USD";
  const status = (txn as any).status || meta.rawStatus || "completed";
  const statusIcon = formatTxnStatusIcon(status);
  const rawDescription = meta.description || responseData.description || responseData.merchant || responseData.merchant_name || responseData.narrative;
  const label = formatTxnLabel(meta.direction, rawDescription);
  const dateLabel = formatTxnDate(meta.date) || formatTxnDate((txn as any).createdAt);

  let reason = undefined as string | undefined;
  if (status === "failed") {
    reason = meta.reason || meta.declineReason || meta.rawStatus;
  }

  let cardSuffix = "";
  if (meta.cardId) {
    const card = isPrismaPersistenceEnabled()
      ? await prisma.card.findUnique({ where: { cardId: String(meta.cardId) } })
      : await Card.findOne({ cardId: meta.cardId }).lean();
    if (card?.last4) cardSuffix = `**** ${card.last4}`;
  }

  const lines = [
    `${statusIcon} ${label}`,
    `Amount: ${direction} $${amountValue.toFixed(2)}`,
    rawDescription ? `Description: ${rawDescription}` : undefined,
    `Status: ${statusIcon} ${status.charAt(0).toUpperCase() + status.slice(1)}`,
    dateLabel ? `Date: ${dateLabel}` : undefined,
    cardSuffix ? `Card: ${cardSuffix}` : undefined,
    reason ? `Reason: ${reason}` : undefined,
  ].filter(Boolean) as string[];

  await bot!.sendMessage(chatId, lines.join("\n"), {
    reply_markup: { inline_keyboard: [[{ text: "⬅️ Back to Transactions", callback_data: "TXN_BACK_ALL" }], [MENU_BUTTON]] },
  });
}

function extractCardTransactions(payload: any): any[] {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
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
    if (Array.isArray(c)) return c;
  }
  return [];
}

function normalizeTxnStatus(raw?: string) {
  const v = (raw || "").toLowerCase();
  if (v.includes("fail") || v.includes("decline") || v.includes("deny")) return "failed";
  if (v.includes("pending") || v.includes("review")) return "pending";
  return "completed";
}

function normalizeTxnDirection(raw?: string, amount?: number) {
  const v = (raw || "").toLowerCase();
  if (v.includes("debit") || v.includes("out") || v.includes("dr")) return "debit";
  if (v.includes("credit") || v.includes("in") || v.includes("cr")) return "credit";
  if (amount != null) return amount < 0 ? "debit" : "credit";
  return "debit";
}

function normalizeTxnItem(item: any) {
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

async function cacheCardTransactions(userId: string, cardId: string, items: any[]) {
  if (!items.length) return;
  const now = Date.now();
  let idx = 0;
  for (const item of items) {
    const normalized = normalizeTxnItem(item);
    if (normalized.amount == null) continue;
    const reference = normalized.transactionNumber || `${cardId}-${now}-${idx++}`;
    if (isPrismaPersistenceEnabled()) {
      await prisma.transaction.upsert({
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
    } else {
      await Transaction.findOneAndUpdate(
        { userId, transactionType: "card", transactionNumber: reference },
        {
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
        },
        { upsert: true, new: true }
      );
    }
  }
}

function formatTxnDate(value?: string | Date) {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  const datePart = date.toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric" });
  const timePart = date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${datePart} · ${timePart}`;
}

function formatTxnStatusIcon(status?: string) {
  const v = (status || "").toLowerCase();
  if (v.includes("fail") || v.includes("decline") || v.includes("deny")) return "🔴";
  if (v.includes("pending") || v.includes("review")) return "🟡";
  return "🟢";
}

function formatTxnLabel(direction?: string, description?: string) {
  const desc = (description || "").toLowerCase();
  if (desc.includes("fee")) return "Fee";
  if (desc.includes("top up") || desc.includes("top-up") || desc.includes("topup") || desc.includes("fund")) {
    return "Card Top-Up";
  }
  return direction === "credit" ? "Card Credit" : "Card Payment";
}

async function handleFreezeAction(chatId: number, cardId: string, action: "freeze" | "unfreeze") {
  try {
    await callStroWallet("action/status", "post", { action, card_id: cardId });
    if (isPrismaPersistenceEnabled()) {
      await prisma.card.updateMany({
        where: { cardId },
        data: { status: action === "freeze" ? "frozen" : "active", lastSync: new Date() },
      });
    } else {
      await Card.findOneAndUpdate(
        { cardId },
        { $set: { status: action === "freeze" ? "frozen" : "active", lastSync: new Date() } },
        { new: true }
      );
    }
    await bot!.sendMessage(chatId, `${action === "freeze" ? "Card frozen" : "Card unfrozen"} for ${cardId}.`, {
      reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
    });
  } catch (err: any) {
    await sendFriendlyError(chatId, err?.requestId);
  }
}

function buildCardDetailMessage(detail: any, cardId: string) {
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
  ].filter(Boolean) as string[];

  return lines.join("\n");
}

async function fetchCardDetailSafe(cardId: string) {
  try {
    const resp = await callStroWallet("fetch-card-detail", "post", { card_id: cardId }, { silentOnStatus: [400, 403, 404] });
    if (!resp) return null;
    const payload = resp?.data || resp?.response || resp;
    const raw = payload?.data || payload?.response || payload?.card || payload;
    return normalizeCardDetail(raw) || null;
  } catch {
    return null;
  }
}

function extractNumericBalance(payload: any): number | null {
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
    if (Number.isFinite(n)) return n;
    if (typeof candidate === "string") {
      const cleaned = candidate.replace(/[^\d.-]/g, "");
      const parsed = Number(cleaned);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

async function fetchStroWalletUsdBalanceSafe(): Promise<number | null> {
  try {
    const resp = await callStroWallet("wallet-balance/USD", "get", {}, { silentOnStatus: [400, 403, 404] });
    if (!resp || (resp as any)?.ok === false) return null;
    return extractNumericBalance(resp?.data || resp?.response || resp);
  } catch {
    return null;
  }
}

function toStroAmountString(amount: number): string {
  if (!Number.isFinite(amount) || amount <= 0) return "0";
  const rounded = Math.round(amount * 100) / 100;
  return Number.isInteger(rounded) ? String(Math.trunc(rounded)) : rounded.toFixed(2).replace(/\.0+$/, "").replace(/(\.\d*[1-9])0+$/, "$1");
}

async function autoTopupCardFromWalletCredit(params: { userId: string; cardId: string; amountUsdt: number }) {
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

  if (isPrismaPersistenceEnabled()) {
    let pendingTxId: string | null = null;
    let walletAfterReserve = 0;
    try {
      const reserve = await prisma.$transaction(async (tx: any) => {
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
            metadata: { cardId, source: "auto_deposit_topup" } as any,
          },
        });

        return {
          walletAfterReserve: Number(updatedUser?.balance || 0),
          pendingTxId: String(pendingTx.id),
        };
      });

      walletAfterReserve = reserve.walletAfterReserve;
      pendingTxId = reserve.pendingTxId;
    } catch (e: any) {
      return { success: false, message: e?.message || "Automatic card top-up failed" };
    }

    try {
      const providerResponse = await callStroWallet("fund-card", "post", providerPayload);
      await prisma.transaction.update({
        where: { id: pendingTxId! },
        data: { status: "completed", responseData: providerResponse as any },
      });
      return { success: true, newWalletBalance: walletAfterReserve, providerResponse };
    } catch (e: any) {
      const message = e?.message || "Automatic card top-up failed at provider";
      await prisma.$transaction(async (tx: any) => {
        await tx.user.update({ where: { userId }, data: { balance: { increment: amountUsdt } } });
        await tx.transaction.update({
          where: { id: pendingTxId! },
          data: {
            status: "failed",
            responseData: { error: message } as any,
            metadata: { cardId, source: "auto_deposit_topup", refunded: true, failureReason: message } as any,
          },
        });
      });
      return { success: false, message };
    }
  }

  const session = await mongoose.startSession();
  session.startTransaction();
  let pendingTxId: any;
  let walletAfterReserve = 0;
  try {
    const updatedUser = await User.findOneAndUpdate(
      { userId, balance: { $gte: amountUsdt } },
      { $inc: { balance: -amountUsdt } },
      { new: true, session }
    );
    if (!updatedUser) {
      throw new Error("Insufficient wallet balance for automatic card top-up");
    }

    const created = await Transaction.create(
      [
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
      ],
      { session }
    );
    pendingTxId = created?.[0]?._id;
    walletAfterReserve = Number(updatedUser.balance || 0);

    await session.commitTransaction();
    session.endSession();
  } catch (e: any) {
    try {
      await session.abortTransaction();
    } catch {}
    session.endSession();
    return { success: false, message: e?.message || "Automatic card top-up failed" };
  }

  try {
    const providerResponse = await callStroWallet("fund-card", "post", providerPayload);
    await Transaction.updateOne({ _id: pendingTxId }, { $set: { status: "completed", responseData: providerResponse } });
    return { success: true, newWalletBalance: walletAfterReserve, providerResponse };
  } catch (e: any) {
    const message = e?.message || "Automatic card top-up failed at provider";
    const refundSession = await mongoose.startSession();
    refundSession.startTransaction();
    try {
      await User.updateOne({ userId }, { $inc: { balance: amountUsdt } }, { session: refundSession });
      await Transaction.updateOne(
        { _id: pendingTxId },
        {
          $set: {
            status: "failed",
            responseData: { error: message },
            metadata: { cardId, source: "auto_deposit_topup", refunded: true, failureReason: message },
          },
        },
        { session: refundSession }
      );
      await refundSession.commitTransaction();
    } catch (rollbackErr) {
      try {
        await refundSession.abortTransaction();
      } catch {}
      console.error("[bot] failed to rollback wallet after top-up provider error", rollbackErr);
    } finally {
      refundSession.endSession();
    }

    return { success: false, message };
  }
}

async function notifyLowStroWalletBalanceIfNeeded(params: {
  userId: string;
  paymentMethod: PaymentMethod;
  creditedUsdt: number;
}) {
  if (!bot) return;
  const threshold = Number.isFinite(STROWALLET_LOW_BALANCE_THRESHOLD_USD)
    ? STROWALLET_LOW_BALANCE_THRESHOLD_USD
    : 50;
  if (threshold <= 0) return;

  const balance = await fetchStroWalletUsdBalanceSafe();
  if (balance == null || balance >= threshold) return;

  const now = Date.now();
  if (now - lastLowBalanceAlertAt < STROWALLET_LOW_BALANCE_ALERT_COOLDOWN_MS) return;
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
    const targetChat: any = /^-?\d+$/.test(STROWALLET_LOW_BALANCE_ALERT_CHAT_ID)
      ? Number(STROWALLET_LOW_BALANCE_ALERT_CHAT_ID)
      : STROWALLET_LOW_BALANCE_ALERT_CHAT_ID;
    await bot.sendMessage(targetChat, alertLines.join("\n"), {
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [[MENU_BUTTON]] },
    });
  } catch (e) {
    console.error("[bot] Failed to send low balance alert", e);
  }
}

async function callStroWallet(
  path: string,
  method: "get" | "post" | "put",
  data?: any,
  options?: { silentOnStatus?: number[] }
) {
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
    const resp = await axios({ url, method, data, params: method === "get" ? data : undefined, timeout: 15000 });
    return resp.data;
  } catch (e: any) {
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
    const err: any = new Error(message);
    err.requestId = requestId;
    err.status = status;
    throw err;
  }
}

export async function sendFriendlyError(chatId: number, requestId?: string) {
  if (!bot) return;
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
