"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.processStroWalletEvent = processStroWalletEvent;
const WebhookEvent_1 = require("../models/WebhookEvent");
const Card_1 = __importDefault(require("../models/Card"));
const CardRequest_1 = __importDefault(require("../models/CardRequest"));
const VirtualBankAccount_1 = __importDefault(require("../models/VirtualBankAccount"));
const UsdtAddress_1 = __importDefault(require("../models/UsdtAddress"));
const TelegramLink_1 = require("../models/TelegramLink");
const Transaction_1 = __importDefault(require("../models/Transaction"));
const User_1 = __importDefault(require("../models/User"));
const Customer_1 = __importDefault(require("../models/Customer"));
const botService_1 = require("./botService");
const prisma_1 = __importDefault(require("../utils/prisma"));
const persistence_1 = require("../utils/persistence");
const prismaAny = prisma_1.default;
function hasPrismaModel(modelName) {
    return Boolean(prismaAny?.[modelName]);
}
function extractField(obj, keys) {
    if (!obj || typeof obj !== "object")
        return undefined;
    for (const key of keys) {
        if (obj[key])
            return String(obj[key]);
    }
    for (const val of Object.values(obj)) {
        const v = typeof val === "object" ? extractField(val, keys) : undefined;
        if (v)
            return v;
    }
    return undefined;
}
async function processStroWalletEvent(payload) {
    const eventId = String(payload?.id || payload?.eventId || "");
    const type = String(payload?.type || payload?.event || "unknown");
    const created = typeof payload?.created === "number" ? payload.created : undefined;
    if (!eventId) {
        // store anyway using random to avoid collisions
        console.warn("Webhook missing event id; storing with generated id");
    }
    // de-duplicate
    try {
        await WebhookEvent_1.WebhookEvent.create({ eventId: eventId || `${Date.now()}-${Math.random()}`, type, created, payload });
    }
    catch (e) {
        if (String(e?.message || "").includes("duplicate key")) {
            return; // already processed
        }
        throw e;
    }
    // Debug: Log full payload and type
    console.log('DEBUG: Webhook payload received:', JSON.stringify(payload));
    console.log('DEBUG: Webhook event type:', type);
    const cardId = extractField(payload, ["card_id", "cardId", "id", "card"]);
    const customerEmail = extractField(payload, ["customerEmail", "customer_email", "email"]);
    const customerId = extractField(payload, ["customerId", "customer_id", "cardholderId", "card_holder_id"]);
    // Debug: Log extracted fields
    console.log('DEBUG: Extracted cardId:', cardId);
    console.log('DEBUG: Extracted customerEmail:', customerEmail);
    console.log('DEBUG: Extracted customerId:', customerId);
    const message = formatMessage(type, payload);
    const lowerType = type.toLowerCase();
    const action = String(payload?.action || "").toLowerCase();
    const currency = String(payload?.currency || "").toUpperCase();
    const chain = String(payload?.chain || "").toUpperCase();
    const address = payload?.address ? String(payload.address) : undefined;
    const accountNumber = payload?.accountNumber || payload?.account_number;
    const sessionId = payload?.sessionId || payload?.session_id;
    const settledAmountRaw = payload?.settledAmount ?? payload?.transactionAmount ?? payload?.amount;
    // Only send generic message for non-KYC events
    if (!type.toLowerCase().includes('kyc')) {
        if (cardId)
            await (0, botService_1.notifyByCardId)(cardId, message);
        if (customerEmail)
            await (0, botService_1.notifyByEmail)(customerEmail, message);
    }
    if (!customerId && !customerEmail) {
        console.log('DEBUG: No customerId or customerEmail extracted for notification routing');
    }
    if ((lowerType === "card.created" || lowerType.includes("virtualcard.created")) && cardId) {
        const data = payload?.data || payload;
        const userId = await resolveUserId(customerEmail, cardId);
        if ((0, persistence_1.isPrismaPersistenceEnabled)()) {
            await prisma_1.default.card.upsert({
                where: { cardId },
                update: {
                    customerEmail: customerEmail || data?.customerEmail,
                    userId: userId || null,
                    nameOnCard: data?.name_on_card || data?.nameOnCard || data?.name,
                    cardType: data?.card_type || data?.cardType || data?.brand,
                    status: data?.status || data?.state || "active",
                    last4: data?.last4 || data?.card_last4 || data?.cardLast4,
                    currency: data?.currency || data?.ccy,
                    balance: data?.balance || data?.available_balance,
                    availableBalance: data?.available_balance,
                    lastSync: new Date(),
                },
                create: {
                    cardId,
                    customerEmail: customerEmail || data?.customerEmail,
                    userId: userId || null,
                    nameOnCard: data?.name_on_card || data?.nameOnCard || data?.name,
                    cardType: data?.card_type || data?.cardType || data?.brand,
                    status: data?.status || data?.state || "active",
                    last4: data?.last4 || data?.card_last4 || data?.cardLast4,
                    currency: data?.currency || data?.ccy,
                    balance: data?.balance || data?.available_balance,
                    availableBalance: data?.available_balance,
                    lastSync: new Date(),
                },
            });
        }
        else {
            await Card_1.default.findOneAndUpdate({ cardId }, {
                $set: {
                    cardId,
                    customerEmail: customerEmail || data?.customerEmail,
                    userId: userId || undefined,
                    nameOnCard: data?.name_on_card || data?.nameOnCard || data?.name,
                    cardType: data?.card_type || data?.cardType || data?.brand,
                    status: data?.status || data?.state || "active",
                    last4: data?.last4 || data?.card_last4 || data?.cardLast4,
                    currency: data?.currency || data?.ccy,
                    balance: data?.balance || data?.available_balance,
                    availableBalance: data?.available_balance,
                    lastSync: new Date(),
                },
            }, { upsert: true, new: true });
        }
        if (userId) {
            const chatId = Number(userId);
            if (Number.isFinite(chatId)) {
                await TelegramLink_1.TelegramLink.findOneAndUpdate({ chatId }, { $addToSet: { cardIds: cardId }, ...(customerEmail ? { $set: { customerEmail } } : {}) }, { upsert: true, new: true });
            }
        }
        if (customerEmail) {
            await TelegramLink_1.TelegramLink.findOneAndUpdate({ customerEmail }, { $addToSet: { cardIds: cardId } }, { upsert: true, new: true });
        }
        if (userId || customerEmail) {
            if ((0, persistence_1.isPrismaPersistenceEnabled)()) {
                await prisma_1.default.cardRequest.updateMany({
                    where: {
                        OR: [
                            ...(userId ? [{ userId }] : []),
                            ...(customerEmail ? [{ customerEmail }] : []),
                        ],
                        status: { in: ["pending", "approved"] },
                    },
                    data: { cardId, status: "approved" },
                });
            }
            else {
                await CardRequest_1.default.findOneAndUpdate({
                    $or: [
                        ...(userId ? [{ userId }] : []),
                        ...(customerEmail ? [{ customerEmail }] : []),
                    ],
                }, { $set: { cardId, status: "approved" } }, { new: true });
            }
            if (userId) {
                await (0, botService_1.notifyCardRequestApproved)(userId, {
                    cardId,
                    cardType: data?.card_type || data?.cardType || data?.brand,
                    nameOnCard: data?.name_on_card || data?.nameOnCard || data?.name,
                    raw: payload,
                }).catch(() => { });
            }
        }
    }
    const isUsdtIncoming = action === "receive_usdt" ||
        (String(payload?.type || "").toLowerCase() === "credit" &&
            (currency === "USDT" ||
                chain === "TRX" ||
                chain === "TRC20" ||
                chain === "BEP20" ||
                chain === "BSC" ||
                chain === "POLYGON" ||
                chain === "MATIC"));
    const usdtStatusText = String(payload?.status || payload?.state || payload?.txStatus || "").toLowerCase();
    const isUsdtFailed = usdtStatusText.includes("fail") ||
        usdtStatusText.includes("declin") ||
        usdtStatusText.includes("reject") ||
        usdtStatusText.includes("revers") ||
        usdtStatusText.includes("cancel") ||
        usdtStatusText.includes("error");
    if (isUsdtIncoming && address && isUsdtFailed) {
        let failedUserId = null;
        if ((0, persistence_1.isPrismaPersistenceEnabled)() && hasPrismaModel("usdtAddress")) {
            const record = await prismaAny.usdtAddress.findUnique({ where: { address } });
            failedUserId = record?.userId || null;
        }
        else {
            const record = await UsdtAddress_1.default.findOne({ address }).lean();
            failedUserId = record?.userId || null;
        }
        if (failedUserId) {
            const failedAmountRaw = Number(payload?.amount ?? payload?.centAmount);
            const failedAmount = Number.isFinite(failedAmountRaw)
                ? (payload?.centAmount != null && payload?.amount == null ? failedAmountRaw / 100 : failedAmountRaw)
                : undefined;
            const reason = String(payload?.message || payload?.error || payload?.reason || payload?.status || "Deposit could not be processed");
            await (0, botService_1.notifyDepositFailed)(failedUserId, failedAmount, reason).catch(() => { });
        }
    }
    if (isUsdtIncoming && address) {
        let amount = Number(payload?.amount);
        if (!Number.isFinite(amount) || amount <= 0) {
            const centAmount = Number(payload?.centAmount);
            if (Number.isFinite(centAmount) && centAmount > 0) {
                amount = centAmount / 100;
            }
        }
        if (Number.isFinite(amount) && amount > 0) {
            const reference = String(payload?.reference || payload?.id || payload?.hash || "");
            let userId = null;
            if ((0, persistence_1.isPrismaPersistenceEnabled)() && hasPrismaModel("usdtAddress")) {
                const record = await prismaAny.usdtAddress.findUnique({ where: { address } });
                userId = record?.userId || null;
            }
            else {
                const record = await UsdtAddress_1.default.findOne({ address }).lean();
                userId = record?.userId || null;
            }
            if (userId) {
                if ((0, persistence_1.isPrismaPersistenceEnabled)()) {
                    const existing = await prisma_1.default.transaction.findFirst({
                        where: {
                            userId,
                            transactionType: "deposit",
                            OR: [
                                ...(reference ? [{ referenceNumber: reference }] : []),
                                ...(payload?.id ? [{ transactionNumber: String(payload.id) }] : []),
                            ],
                        },
                    });
                    if (!existing) {
                        const createdTx = await prisma_1.default.transaction.create({
                            data: {
                                userId,
                                transactionType: "deposit",
                                paymentMethod: "strowallet",
                                amount,
                                amountUsdt: amount,
                                currency: "USDT",
                                transactionNumber: payload?.id ? String(payload.id) : undefined,
                                referenceNumber: reference || undefined,
                                status: "completed",
                                verified: true,
                                responseData: payload,
                                metadata: {
                                    kind: "usdt_deposit",
                                    address,
                                    chain,
                                },
                            },
                        });
                        const updated = await prisma_1.default.user.update({
                            where: { userId },
                            data: { balance: { increment: amount } },
                        });
                        await (0, botService_1.notifyDepositCredited)(userId, amount, updated.balance).catch(() => { });
                    }
                }
                else {
                    const existing = await Transaction_1.default.findOne({
                        userId,
                        transactionType: "deposit",
                        $or: [
                            ...(reference ? [{ referenceNumber: reference }] : []),
                            ...(payload?.id ? [{ transactionNumber: String(payload.id) }] : []),
                        ],
                    }).lean();
                    if (!existing) {
                        await Transaction_1.default.create({
                            userId,
                            transactionType: "deposit",
                            paymentMethod: "strowallet",
                            amount,
                            amountUsdt: amount,
                            currency: "USDT",
                            transactionNumber: payload?.id ? String(payload.id) : undefined,
                            referenceNumber: reference || undefined,
                            status: "completed",
                            verified: true,
                            responseData: payload,
                            metadata: { kind: "usdt_deposit", address, chain },
                        });
                        const updated = await User_1.default.findOneAndUpdate({ userId }, { $inc: { balance: amount } }, { new: true }).lean();
                        await (0, botService_1.notifyDepositCredited)(userId, amount, updated?.balance).catch(() => { });
                    }
                }
            }
        }
    }
    const looksLikeVirtualBankWebhook = Boolean(accountNumber && (settledAmountRaw || sessionId));
    if (looksLikeVirtualBankWebhook) {
        const amountNgn = Number(settledAmountRaw);
        if (Number.isFinite(amountNgn) && amountNgn > 0) {
            let userId = null;
            if ((0, persistence_1.isPrismaPersistenceEnabled)() && hasPrismaModel("virtualBankAccount")) {
                const record = await prismaAny.virtualBankAccount.findFirst({
                    where: {
                        OR: [
                            ...(accountNumber ? [{ accountNumber: String(accountNumber) }] : []),
                            ...(sessionId ? [{ sessionId: String(sessionId) }] : []),
                        ],
                    },
                });
                userId = record?.userId || null;
            }
            else {
                const record = await VirtualBankAccount_1.default.findOne({
                    $or: [
                        ...(accountNumber ? [{ accountNumber: String(accountNumber) }] : []),
                        ...(sessionId ? [{ sessionId: String(sessionId) }] : []),
                    ],
                }).lean();
                userId = record?.userId || null;
            }
            if (userId) {
                const rate = Number(process.env.VIRTUAL_BANK_USDT_RATE || 0);
                const autoCredit = String(process.env.VIRTUAL_BANK_AUTO_CREDIT || "false").toLowerCase() === "true" && rate > 0;
                const creditedUsdt = autoCredit ? amountNgn / rate : null;
                const reference = String(payload?.settlementId || payload?.reference || sessionId || payload?.id || "");
                if ((0, persistence_1.isPrismaPersistenceEnabled)()) {
                    const existing = await prisma_1.default.transaction.findFirst({
                        where: {
                            userId,
                            transactionType: "deposit",
                            OR: [
                                ...(reference ? [{ referenceNumber: reference }] : []),
                                ...(sessionId ? [{ transactionNumber: String(sessionId) }] : []),
                            ],
                        },
                    });
                    if (!existing) {
                        const created = await prisma_1.default.transaction.create({
                            data: {
                                userId,
                                transactionType: "deposit",
                                paymentMethod: "strowallet",
                                amount: autoCredit && creditedUsdt != null ? creditedUsdt : amountNgn,
                                amountUsdt: autoCredit && creditedUsdt != null ? creditedUsdt : undefined,
                                currency: autoCredit ? "USDT" : "NGN",
                                transactionNumber: sessionId ? String(sessionId) : undefined,
                                referenceNumber: reference || undefined,
                                status: autoCredit ? "completed" : "pending",
                                verified: autoCredit,
                                responseData: payload,
                                metadata: {
                                    kind: "virtual_account",
                                    ngnAmount: amountNgn,
                                    rate,
                                    creditedUsdt,
                                    accountNumber: accountNumber ? String(accountNumber) : undefined,
                                },
                            },
                        });
                        if (autoCredit && creditedUsdt != null) {
                            const updated = await prisma_1.default.user.update({
                                where: { userId },
                                data: { balance: { increment: creditedUsdt } },
                            });
                            await (0, botService_1.notifyDepositCredited)(userId, creditedUsdt, updated.balance).catch(() => { });
                        }
                    }
                }
                else {
                    const existing = await Transaction_1.default.findOne({
                        userId,
                        transactionType: "deposit",
                        $or: [
                            ...(reference ? [{ referenceNumber: reference }] : []),
                            ...(sessionId ? [{ transactionNumber: String(sessionId) }] : []),
                        ],
                    }).lean();
                    if (!existing) {
                        await Transaction_1.default.create({
                            userId,
                            transactionType: "deposit",
                            paymentMethod: "strowallet",
                            amount: autoCredit && creditedUsdt != null ? creditedUsdt : amountNgn,
                            amountUsdt: autoCredit && creditedUsdt != null ? creditedUsdt : undefined,
                            currency: autoCredit ? "USDT" : "NGN",
                            transactionNumber: sessionId ? String(sessionId) : undefined,
                            referenceNumber: reference || undefined,
                            status: autoCredit ? "completed" : "pending",
                            verified: autoCredit,
                            responseData: payload,
                            metadata: {
                                kind: "virtual_account",
                                ngnAmount: amountNgn,
                                rate,
                                creditedUsdt,
                                accountNumber: accountNumber ? String(accountNumber) : undefined,
                            },
                        });
                        if (autoCredit && creditedUsdt != null) {
                            const updated = await User_1.default.findOneAndUpdate({ userId }, { $inc: { balance: creditedUsdt } }, { new: true }).lean();
                            await (0, botService_1.notifyDepositCredited)(userId, creditedUsdt, updated?.balance).catch(() => { });
                        }
                    }
                }
            }
        }
    }
    if ((type === "card.frozen" || type === "card.unfrozen" || type === "card.unfreeze") && cardId) {
        const nextStatus = type === "card.frozen" ? "frozen" : "active";
        await Card_1.default.findOneAndUpdate({ cardId }, { $set: { status: nextStatus, lastSync: new Date() } }, { upsert: true, new: true });
        await (0, botService_1.notifyCardStatusChanged)(cardId, nextStatus).catch(() => { });
    }
    if (type === "card.funded" && cardId) {
        const data = payload?.data || payload;
        const amountRaw = extractField(payload, ["amount", "transactionAmount", "total", "value"]);
        const amount = amountRaw ? Number(amountRaw) : undefined;
        const currency = extractField(payload, ["currency", "ccy", "iso_currency"]);
        const card = await Card_1.default.findOneAndUpdate({ cardId }, {
            $set: {
                balance: data?.balance || data?.available_balance || data?.availableBalance || undefined,
                availableBalance: data?.available_balance || data?.availableBalance || undefined,
                currency: currency || data?.currency || data?.ccy,
                lastSync: new Date(),
            },
        }, { new: true });
        if (amount != null && card?.userId) {
            const last4 = card.last4 ? `**** ${card.last4}` : undefined;
            const balanceValue = data?.balance || data?.available_balance || data?.availableBalance;
            const amountLabel = amount.toFixed(2);
            const lines = [
                "💳 Card Funded",
                `Amount: - $${amountLabel}`,
                "From Wallet",
                last4 ? `Card: ${last4}` : undefined,
                balanceValue != null ? `Card Balance: $${Number(balanceValue).toFixed(2)}` : undefined,
            ].filter(Boolean);
            await (0, botService_1.notifyByCardId)(cardId, lines.join("\n")).catch(() => { });
        }
    }
    const isTransactionEvent = lowerType === "transaction.posted" ||
        lowerType.startsWith("virtualcard.transaction.") ||
        lowerType.startsWith("card.transaction.");
    if (isTransactionEvent && cardId) {
        const data = payload?.data || payload;
        const amountRaw = extractField(payload, ["amount", "transactionAmount", "total", "value"]);
        const amountValue = amountRaw ? Number(amountRaw) : undefined;
        const description = extractField(payload, ["description", "merchant", "merchant_name", "narration", "narrative"]);
        const statusRaw = extractField(payload, ["status", "result", "state"]);
        const status = normalizeTxnStatus(statusRaw);
        const txnId = extractField(payload, ["transactionId", "transaction_id", "id", "eventId", "ref"]);
        const directionRaw = extractField(payload, ["direction", "type", "transaction_type", "drCr"]);
        const direction = normalizeDirection(directionRaw, amountValue);
        const card = await Card_1.default.findOne({ cardId }).lean();
        const userId = card?.userId || (await resolveUserId(customerEmail || card?.customerEmail, cardId));
        if (userId && amountValue != null) {
            await Transaction_1.default.findOneAndUpdate({ userId, transactionType: "card", transactionNumber: txnId || `${eventId}-${cardId}` }, {
                $set: {
                    userId,
                    transactionType: "card",
                    paymentMethod: "strowallet",
                    amount: Math.abs(amountValue),
                    currency: extractField(payload, ["currency", "ccy", "iso_currency"]) || "USD",
                    status,
                    transactionNumber: txnId || undefined,
                    metadata: {
                        cardId,
                        direction,
                        description,
                        rawStatus: statusRaw,
                    },
                    responseData: data,
                },
            }, { upsert: true, new: true });
            const last4 = card?.last4 ? `**** ${card.last4}` : undefined;
            const amountLabel = `${direction === "debit" ? "-" : "+"} $${Math.abs(amountValue).toFixed(2)}`;
            const title = status === "failed" ? "❌ Payment Failed" : "💳 Payment Completed";
            const remaining = extractField(payload, ["cardBalanceAfter", "balance", "available_balance", "availableBalance"]);
            const reason = status === "failed" ? extractField(payload, ["reason", "declineReason", "message"]) : undefined;
            const lines = [
                title,
                description ? `Merchant: ${description}` : undefined,
                `Amount: ${amountLabel}`,
                last4 ? `Card: ${last4}` : undefined,
                remaining != null ? `Remaining Card Balance: $${Number(remaining).toFixed(2)}` : undefined,
                reason ? `Reason: ${reason}` : undefined,
            ].filter(Boolean);
            await (0, botService_1.notifyByCardId)(cardId, lines.join("\n")).catch(() => { });
        }
    }
}
async function resolveUserId(customerEmail, cardId) {
    if ((0, persistence_1.isPrismaPersistenceEnabled)()) {
        if (cardId) {
            const card = await prisma_1.default.card.findUnique({ where: { cardId } });
            if (card?.userId)
                return card.userId;
        }
        if (customerEmail) {
            const userByEmail = await prisma_1.default.user.findFirst({ where: { customerEmail } });
            if (userByEmail?.userId)
                return userByEmail.userId;
        }
        return undefined;
    }
    if (cardId) {
        const card = await Card_1.default.findOne({ cardId }).lean();
        if (card?.userId)
            return card.userId;
    }
    if (customerEmail) {
        const customer = await Customer_1.default.findOne({ email: customerEmail }).lean();
        if (customer?.userId)
            return customer.userId;
    }
    if (customerEmail) {
        const link = await TelegramLink_1.TelegramLink.findOne({ customerEmail }).lean();
        if (link?.chatId != null)
            return String(link.chatId);
    }
    if (customerEmail) {
        const user = await User_1.default.findOne({ customerEmail }).lean();
        if (user?.userId)
            return user.userId;
    }
    return undefined;
}
function normalizeTxnStatus(raw) {
    const v = (raw || "").toLowerCase();
    if (v.includes("fail") || v.includes("decline") || v.includes("deny"))
        return "failed";
    if (v.includes("pending") || v.includes("review"))
        return "pending";
    return "completed";
}
function normalizeDirection(raw, amount) {
    const v = (raw || "").toLowerCase();
    if (v.includes("debit") || v.includes("out") || v.includes("dr"))
        return "debit";
    if (v.includes("credit") || v.includes("in") || v.includes("cr"))
        return "credit";
    if (amount != null)
        return amount < 0 ? "debit" : "credit";
    return "debit";
}
function formatMessage(type, payload) {
    try {
        if (type === "card.frozen") {
            const last4 = extractField(payload, ["last4", "cardLast4", "card_last4", "cardSuffix"]);
            return `❌ Your card ${last4 ? `••••${last4}` : ""} has been frozen.`.trim();
        }
        if (type === "card.unfrozen" || type === "card.unfreeze") {
            const last4 = extractField(payload, ["last4", "cardLast4", "card_last4", "cardSuffix"]);
            return `✅ Your card ${last4 ? `••••${last4}` : ""} is active again.`.trim();
        }
        const transactionId = extractField(payload, ["transactionId", "transaction_id", "id", "eventId", "ref"]);
        const scene = extractField(payload, ["scene", "category", "type"]);
        const transaction = extractField(payload, ["transaction", "description", "merchant", "merchant_name", "narration"]);
        const amountRaw = extractField(payload, ["amount", "transactionAmount", "total", "value"]);
        const preauthRaw = extractField(payload, ["preAuthorizationAmount", "preauth", "preAuthAmount", "pre_authorization_amount"]);
        const currency = extractField(payload, ["currency", "ccy", "iso_currency"]) || "USD";
        const declineReason = extractField(payload, ["declineReason", "reason", "message"]);
        const statusRaw = extractField(payload, ["status", "result", "state"]) || type;
        const createdRaw = extractField(payload, ["created", "created_at", "timestamp", "time"]);
        const cardBrand = extractField(payload, ["brand", "cardBrand", "card_type"]);
        const last4 = extractField(payload, ["last4", "cardLast4", "card_last4", "cardSuffix", "card_id", "cardId"]);
        const amount = formatAmount(amountRaw, currency);
        const preauth = formatAmount(preauthRaw, currency);
        const status = normalizeStatus(statusRaw);
        const statusIcon = status.tag === "declined" ? "❌" : status.tag === "approved" ? "✅" : "⏳";
        const cardLine = `Your ${cardBrand || "card"}${last4 ? `(${last4})` : ""} card just made a new move!`;
        const dateTime = formatDateTime(createdRaw);
        const lines = [
            "Card Transaction Alert ⏰",
            "",
            cardLine,
            "",
            transactionId ? `🆔 Transaction ID: ${transactionId}` : undefined,
            scene ? `🧾 Scene: ${scene}` : undefined,
            transaction ? `🛍️ Transaction: ${transaction}` : undefined,
            amount ? `💸 Amount: ${amount}` : undefined,
            preauth ? `💳 Pre-authorization Amount: ${preauth}` : undefined,
            status.tag === "declined" && declineReason ? `❌ Decline Reason: ${declineReason}` : declineReason ? `ℹ️ Note: ${declineReason}` : undefined,
            dateTime ? `🕒 Date & Time: ${dateTime}` : undefined,
            `${statusIcon} Status: ${status.label}`,
        ].filter(Boolean);
        return lines.join("\n");
    }
    catch {
        return `StroWallet: ${type}`;
    }
}
function formatAmount(value, currency) {
    if (!value)
        return undefined;
    const numeric = Number(value);
    if (!Number.isNaN(numeric) && Number.isFinite(numeric)) {
        return `${numeric.toFixed(2)}${currency ? currency : ""}`.replace(/\s+/, " ");
    }
    return `${value}${currency ? ` ${currency}` : ""}`.trim();
}
function formatDateTime(raw) {
    if (!raw)
        return undefined;
    const asNum = Number(raw);
    const date = Number.isFinite(asNum)
        ? new Date(asNum < 1000000000000 ? asNum * 1000 : asNum)
        : new Date(raw);
    if (isNaN(date.getTime()))
        return undefined;
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const dd = String(date.getDate()).padStart(2, "0");
    const hh = String(date.getHours()).padStart(2, "0");
    const mi = String(date.getMinutes()).padStart(2, "0");
    const ss = String(date.getSeconds()).padStart(2, "0");
    return `${yyyy}/${mm}/${dd} ${hh}:${mi}:${ss}`;
}
function normalizeStatus(raw) {
    const v = (raw || "").toString();
    const lower = v.toLowerCase();
    if (lower.includes("decline") || lower.includes("fail") || lower.includes("deny")) {
        return { tag: "declined", label: v.toUpperCase() || "DECLINED" };
    }
    if (lower.includes("success") || lower.includes("approved") || lower.includes("complete")) {
        return { tag: "approved", label: v.toUpperCase() || "APPROVED" };
    }
    if (lower.includes("pending") || lower.includes("review")) {
        return { tag: "pending", label: v.toUpperCase() || "PENDING" };
    }
    return { tag: "unknown", label: v ? v.toUpperCase() : "UNKNOWN" };
}
