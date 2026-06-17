import express from "express";
import axios, { AxiosError } from "axios";
import crypto from "crypto";
import http from "http";
import https from "https";
import mongoose from "mongoose";
import { z } from "zod";
import { ok, fail } from "../utils/apiResponse";
import User from "../models/User";
import { notifyDepositCredited } from "../services/botService";
import prisma from "../utils/prisma";
import { isPrismaPersistenceEnabled } from "../utils/persistence";

const router = express.Router();
const prismaAny = prisma as any;
const SUPPORTED_USDT_NETWORKS = ["TRC20", "BEP20", "POLYGON"] as const;
type UsdtNetwork = typeof SUPPORTED_USDT_NETWORKS[number];
const VIRTUAL_ACCOUNT_CREATE_TTL_MS = Number(process.env.VIRTUAL_ACCOUNT_CREATE_TTL_MS || 60000);
const USDT_ADDRESS_CREATE_TTL_MS = Number(process.env.USDT_ADDRESS_CREATE_TTL_MS || 60000);
const virtualAccountCreateLocks = new Map<string, { startedAt: number; account?: any }>();
const usdtAddressCreateLocks = new Map<string, { startedAt: number; address?: any }>();

function getVirtualBankAccountModel() {
  return require("../models/VirtualBankAccount").default as any;
}

function getUsdtAddressModel() {
  return require("../models/UsdtAddress").default as any;
}

function hasPrismaModel(modelName: string) {
  return Boolean(prismaAny?.[modelName]);
}

async function queryLatestUsdtAddressRow(userId: string) {
  if (!isPrismaPersistenceEnabled()) return null;
  const rows = await prismaAny.$queryRawUnsafe(
    'SELECT * FROM "UsdtAddress" WHERE "userId" = $1 ORDER BY "createdAt" DESC LIMIT 1',
    userId
  );
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

async function queryUsdtAddressRows(userId: string) {
  if (!isPrismaPersistenceEnabled()) return [];
  const rows = await prismaAny.$queryRawUnsafe(
    'SELECT * FROM "UsdtAddress" WHERE "userId" = $1 ORDER BY "createdAt" DESC',
    userId
  );
  return Array.isArray(rows) ? rows : [];
}

async function upsertUsdtAddressRow(params: {
  userId: string;
  address: string;
  label?: string;
  network?: string;
  responseData: any;
}) {
  if (!isPrismaPersistenceEnabled()) return null;
  const responseDataJson = JSON.stringify(params.responseData ?? {});
  const rows = await prismaAny.$queryRawUnsafe(
    `INSERT INTO "UsdtAddress" ("id", "userId", "address", "label", "network", "status", "responseData", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, 'active', $6::jsonb, NOW(), NOW())
     ON CONFLICT ("address") DO UPDATE SET
       "userId" = EXCLUDED."userId",
       "label" = EXCLUDED."label",
       "network" = EXCLUDED."network",
       "status" = EXCLUDED."status",
       "responseData" = EXCLUDED."responseData",
       "updatedAt" = NOW()
     RETURNING *`,
    crypto.randomUUID(),
    params.userId,
    params.address,
    params.label || null,
    params.network || "TRC20",
    responseDataJson
  );
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

async function listUserUsdtDeposits(userId: string, limit = 10) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 10, 50));
  if (isPrismaPersistenceEnabled()) {
    return prismaAny.transaction.findMany({
      where: {
        userId,
        transactionType: { in: ["deposit", "manual_deposit"] },
        paymentMethod: "strowallet",
        currency: "USDT",
      },
      orderBy: { createdAt: "desc" },
      take: safeLimit,
    });
  }
  if (!isMongoReady()) return [];
  const Transaction = require("../models/Transaction").default as any;
  return Transaction.find({
    userId,
    transactionType: { $in: ["deposit", "manual_deposit"] },
    paymentMethod: "strowallet",
    currency: "USDT",
  })
    .sort({ createdAt: -1 })
    .limit(safeLimit)
    .lean();
}

function extractUsdtHistoryItems(payload: any): any[] {
  const candidates = [
    payload?.data?.history,
    payload?.data?.transactions,
    payload?.data?.records,
    payload?.data?.items,
    payload?.history,
    payload?.transactions,
    payload?.records,
    payload?.items,
    payload?.data?.data,
    payload?.data,
    payload,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }

  const queue = [payload];
  const seen = new Set<any>();
  while (queue.length) {
    const current = queue.shift();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) {
      if (current.some((item) => item && typeof item === "object")) return current;
      continue;
    }
    for (const value of Object.values(current)) {
      if (Array.isArray(value) && value.some((item) => item && typeof item === "object")) return value;
      if (value && typeof value === "object") queue.push(value);
    }
  }
  return [];
}

function parseNumericAmount(value: any) {
  if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
  const raw = String(value ?? "").trim();
  if (!raw) return NaN;
  const normalized = raw.replace(/[^0-9.-]/g, "");
  if (!normalized) return NaN;
  return Number(normalized);
}

function collectAddressCandidates(item: any): string[] {
  if (!item || typeof item !== "object") return [];
  const values = [
    item?.to,
    item?.toAddress,
    item?.address,
    item?.walletAddress,
    item?.receiverAddress,
    item?.depositAddress,
    item?.destination,
    item?.recipient,
    item?.data?.to,
    item?.data?.toAddress,
    item?.data?.address,
    item?.data?.walletAddress,
    item?.data?.receiverAddress,
    item?.data?.depositAddress,
    item?.data?.destination,
    item?.data?.recipient,
  ];
  return values.map((value) => String(value || "").trim()).filter(Boolean);
}

function parseIncomingUsdtHistoryItem(item: any, address: string) {
  const amountRaw =
    item?.amount ??
    item?.creditAmount ??
    item?.credit_amount ??
    item?.value ??
    item?.usdtAmount ??
    item?.settledAmount ??
    item?.quantityReceived ??
    item?.receivedAmount ??
    item?.quantity ??
    item?.data?.amount;
  let amount = parseNumericAmount(amountRaw);
  if (!Number.isFinite(amount) || amount <= 0) {
    const centAmount = parseNumericAmount(item?.centAmount ?? item?.data?.centAmount);
    if (Number.isFinite(centAmount) && centAmount > 0) amount = centAmount / 100;
  }

  const typeText = String(item?.action || item?.type || item?.event || item?.direction || "").toLowerCase();
  const statusRaw = item?.status ?? item?.state ?? item?.txStatus ?? item?.confirmed ?? item?.success;
  const statusText = String(statusRaw ?? "").toLowerCase();
  const addressCandidates = collectAddressCandidates(item);
  const looksIncoming =
    !(typeText.includes("send") || typeText.includes("withdraw") || typeText.includes("debit") || typeText.includes("outgoing")) &&
    (
    typeText.includes("receive") ||
    typeText.includes("deposit") ||
    typeText.includes("credit") ||
    typeText.includes("incoming") ||
    !typeText
    );
  const matchesAddress =
    !addressCandidates.length ||
    addressCandidates.some((candidate) => candidate.toLowerCase() === address.toLowerCase());
  const isSuccessful =
    !statusText ||
    statusText === "1" ||
    statusText === "true" ||
    statusText.includes("success") ||
    statusText.includes("complete") ||
    statusText.includes("confirm") ||
    statusText.includes("paid");

  const reference = String(
    item?.reference || item?.referenceNumber || item?.hash || item?.txHash || item?.id || item?.transactionId || ""
  ).trim();
  const transactionNumber = String(item?.id || item?.transactionId || item?.txid || item?.txHash || "").trim();
  const syntheticKey = crypto.createHash("sha1").update(JSON.stringify(item || {})).digest("hex");

  return {
    amount,
    looksIncoming,
    matchesAddress,
    isSuccessful,
    reference,
    transactionNumber,
    syntheticKey,
    createdAt: item?.createdAt || item?.timestamp || item?.time || item?.date,
    raw: item,
    statusText,
  };
}

async function syncUserUsdtDepositsFromProvider(userId: string, address: string, limit = 20) {
  if (!address) return 0;
  const public_key = requirePublicKey();
  const resp = await api.get("get-usdt-history", {
    params: { public_key, address },
  });

  const payload = resp?.data ?? {};
  const items = extractUsdtHistoryItems(payload).slice(0, Math.max(1, Math.min(limit, 100)));
  if (shouldDebugStroWallet()) {
    console.log("[strowallet] usdt history sync scan", {
      userId,
      address,
      itemsFound: items.length,
      sampleKeys: items[0] && typeof items[0] === "object" ? Object.keys(items[0]).slice(0, 12) : [],
    });
  }
  let creditedCount = 0;

  for (const rawItem of items) {
    const parsed = parseIncomingUsdtHistoryItem(rawItem, address);
    if (!Number.isFinite(parsed.amount) || parsed.amount <= 0) continue;
    if (!parsed.looksIncoming || !parsed.matchesAddress || !parsed.isSuccessful) continue;
    const fallbackKey = parsed.reference || parsed.transactionNumber || parsed.syntheticKey;

    if (isPrismaPersistenceEnabled()) {
      const existing = await prisma.transaction.findFirst({
        where: {
          userId,
          transactionType: "deposit",
          OR: [
            ...(parsed.reference ? [{ referenceNumber: parsed.reference }] : []),
            ...(parsed.transactionNumber ? [{ transactionNumber: parsed.transactionNumber }] : []),
            ...(parsed.syntheticKey ? [{ referenceNumber: parsed.syntheticKey }] : []),
          ],
        },
      });
      if (existing) continue;

      try {
        let nextBalance: number | undefined;
        await prisma.$transaction(async (tx) => {
          await tx.transaction.create({
            data: {
              userId,
              transactionType: "deposit",
              paymentMethod: "strowallet",
              amount: parsed.amount,
              amountUsdt: parsed.amount,
              currency: "USDT",
              transactionNumber: parsed.transactionNumber || fallbackKey || undefined,
              referenceNumber: parsed.reference || fallbackKey || undefined,
              status: "completed",
              verified: true,
              responseData: parsed.raw,
              metadata: {
                kind: "usdt_history_sync",
                address,
                sourceStatus: parsed.statusText || undefined,
                sourceCreatedAt: parsed.createdAt || undefined,
              } as any,
            },
          });
          const updated = await tx.user.update({
            where: { userId },
            data: { balance: { increment: parsed.amount } },
          });
          nextBalance = Number(updated?.balance ?? 0);
        });
        await notifyDepositCredited(userId, parsed.amount, nextBalance).catch(() => {});
        creditedCount += 1;
      } catch (e: any) {
        const msg = String(e?.message || "").toLowerCase();
        if (!msg.includes("unique") && !msg.includes("duplicate")) {
          throw e;
        }
      }
      continue;
    }

    if (!isMongoReady()) continue;
    const Transaction = require("../models/Transaction").default as any;
    const existing = await Transaction.findOne({
      userId,
      transactionType: "deposit",
      $or: [
        ...(parsed.reference ? [{ referenceNumber: parsed.reference }] : []),
        ...(parsed.transactionNumber ? [{ transactionNumber: parsed.transactionNumber }] : []),
        ...(parsed.syntheticKey ? [{ referenceNumber: parsed.syntheticKey }] : []),
      ],
    }).lean();
    if (existing) continue;

    await Transaction.create({
      userId,
      transactionType: "deposit",
      paymentMethod: "strowallet",
      amount: parsed.amount,
      amountUsdt: parsed.amount,
      currency: "USDT",
      transactionNumber: parsed.transactionNumber || fallbackKey || undefined,
      referenceNumber: parsed.reference || fallbackKey || undefined,
      status: "completed",
      verified: true,
      responseData: parsed.raw,
      metadata: {
        kind: "usdt_history_sync",
        address,
        sourceStatus: parsed.statusText || undefined,
        sourceCreatedAt: parsed.createdAt || undefined,
      },
    });
    const updated = await User.findOneAndUpdate({ userId }, { $inc: { balance: parsed.amount } }, { new: true }).lean();
    await notifyDepositCredited(userId, parsed.amount, Number(updated?.balance ?? 0)).catch(() => {});
    creditedCount += 1;
  }

  if (shouldDebugStroWallet() && creditedCount > 0) {
    console.log("[strowallet] usdt history sync credited", { userId, address, creditedCount });
  }
  return creditedCount;
}

function isMongoReady() {
  return mongoose.connection.readyState === 1;
}

function shouldSkipCreate(lock: Map<string, { startedAt: number }>, userId: string, ttlMs: number) {
  const existing = lock.get(userId);
  if (!existing) return false;
  if (Date.now() - existing.startedAt <= ttlMs) return true;
  lock.delete(userId);
  return false;
}

const BITVCARD_BASE = "https://strowallet.com/api/bitvcard/";
const API_BASE = "https://strowallet.com/api/"; // for apicard-transactions
const STROWALLET_PREFER_IPV4 = String(process.env.STROWALLET_PREFER_IPV4 || "true").toLowerCase() !== "false";
const STROWALLET_HTTP_TIMEOUT_MS = Number(process.env.STROWALLET_HTTP_TIMEOUT_MS || 30000);
const httpAgent = STROWALLET_PREFER_IPV4 ? new http.Agent({ keepAlive: true, family: 4 } as any) : undefined;
const httpsAgent = STROWALLET_PREFER_IPV4 ? new https.Agent({ keepAlive: true, family: 4 } as any) : undefined;

const bitvcard = axios.create({
  baseURL: BITVCARD_BASE,
  timeout: STROWALLET_HTTP_TIMEOUT_MS,
  httpAgent,
  httpsAgent,
  headers: {
    // Some StroWallet endpoints require an auth header; allow overriding via env
    Authorization: process.env.STROWALLET_API_KEY ? `Bearer ${process.env.STROWALLET_API_KEY}` : undefined,
  },
});

function getDefaultMode() {
  return process.env.STROWALLET_DEFAULT_MODE || (process.env.NODE_ENV !== "production" ? "sandbox" : undefined);
}

function normalizeMode(mode?: string) {
  if (!mode) return undefined;
  const m = String(mode).toLowerCase();
  if (m === "live") return undefined;
  return m;
}

function applyDefaultMode<T extends { mode?: string }>(body: T): T {
  const defaultMode = normalizeMode(getDefaultMode());
  if (!body?.mode && defaultMode) return { ...body, mode: defaultMode } as T;
  return body;
}

function pickCardId(req: express.Request) {
  const v =
    (req.body as any)?.card_id ??
    (req.body as any)?.cardId ??
    req.query.card_id ??
    req.query.cardId ??
    (req.headers["x-card-id"] as any);
  if (v === undefined || v === null || v === "") {
    const err = new Error("card_id is required");
    (err as any).status = 400;
    throw err;
  }
  return String(v);
}

const api = axios.create({
  baseURL: API_BASE,
  timeout: STROWALLET_HTTP_TIMEOUT_MS,
  httpAgent,
  httpsAgent,
  headers: {
    Authorization: process.env.STROWALLET_API_KEY ? `Bearer ${process.env.STROWALLET_API_KEY}` : undefined,
  },
});

const VirtualBankRequestSchema = z.object({
  userId: z.union([z.string(), z.number()]).transform((v) => String(v)),
  bank: z.string().optional(),
  email: z.string().email().optional(),
  accountName: z.string().min(1).optional(),
  phone: z.string().min(7).optional(),
  webhookUrl: z.string().url().optional(),
  mode: z.string().optional(),
  developerCode: z.string().optional(),
  forceCreate: z.boolean().optional(),
});

const UsdtAddressSchema = z.object({
  userId: z.union([z.string(), z.number()]).transform((v) => String(v)),
  label: z.string().optional(),
  email: z.string().email().optional(),
  network: z.enum(SUPPORTED_USDT_NETWORKS).optional(),
  webhookUrl: z.string().url().optional(),
  mode: z.string().optional(),
  forceCreate: z.boolean().optional(),
});

const UsdtHistoryQuerySchema = z.object({
  address: z.string().min(5),
});

const UsdtSendSchema = z.object({
  address: z.string().min(5),
  amount: z.union([z.string(), z.number()]).transform((v) => String(v)),
  vipKey: z.string().optional(),
  mode: z.string().optional(),
});

const BankTransferSchema = z.object({
  amount: z.string().min(1),
  bank_code: z.string().min(1),
  account_number: z.string().min(1),
  narration: z.string().min(1),
  name_enquiry_reference: z.string().min(1),
  SenderName: z.string().optional(),
  mode: z.string().optional(),
});

const AirtimeSchema = z.object({
  amount: z.string().min(1),
  phone: z.string().min(7),
  service_name: z.string().min(1),
});

const DataPlanQuerySchema = z.object({
  service_name: z.string().min(1),
});

const BuyDataSchema = z.object({
  amount: z.string().min(1),
  phone: z.string().min(7),
  service_name: z.string().min(1),
  service_id: z.string().min(1),
  variation_code: z.string().min(1),
});

const ElectricitySchema = z.object({
  amount: z.string().min(1),
  phone: z.string().min(7),
  service_name: z.string().min(1),
  meter_number: z.string().min(1),
  meter_type: z.enum(["prepaid", "postpaid"]),
});

function requirePublicKey() {
  const key = process.env.STROWALLET_PUBLIC_KEY;
  if (!key) {
    const err = new Error("Missing STROWALLET_PUBLIC_KEY env");
    (err as any).status = 500;
    throw err;
  }
  return key;
}

function getWebhookUrl(defaultPath: string) {
  const direct = (process.env.STROWALLET_WEBHOOK_URL || "").trim();
  if (direct) return direct;
  const base = (process.env.BOT_BACKEND_BASE || "").trim();
  if (base) return base.replace(/\/$/, "") + defaultPath;
  const port = process.env.PORT || 3000;
  return `http://127.0.0.1:${port}${defaultPath}`;
}

function normalizeVirtualBankProvider(raw?: string) {
  const value = String(raw || "").trim().toLowerCase();
  if (!value || value === "default" || value === "nombank") return "new-customer";
  if (value === "palmpay") return "palmpay";
  if (value === "paga") return "paga";
  if (value === "safehaven") return "safehaven";
  if (value === "amucha") return "amucha";
  if (value === "fidelitybank" || value === "fidelity") return "fidelitybank";
  return "new-customer";
}

async function findUserById(userId: string) {
  if (isPrismaPersistenceEnabled()) {
    return prisma.user.findUnique({ where: { userId } });
  }
  return User.findOne({ userId }).lean();
}

async function findExistingVirtualAccount(userId: string) {
  if (isPrismaPersistenceEnabled() && hasPrismaModel("virtualBankAccount")) {
    return prismaAny.virtualBankAccount.findFirst({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });
  }
  if (!isMongoReady()) return null;
  const VirtualBankAccount = getVirtualBankAccountModel();
  return VirtualBankAccount.findOne({ userId }).sort({ createdAt: -1 }).lean();
}

async function findExistingUsdtAddress(userId: string) {
  const prismaRow = await queryLatestUsdtAddressRow(userId);
  if (prismaRow) return prismaRow;
  if (!isMongoReady()) return null;
  const UsdtAddress = getUsdtAddressModel();
  return UsdtAddress.findOne({ userId }).sort({ createdAt: -1 }).lean();
}

async function findExistingUsdtAddresses(userId: string) {
  const rows = await queryUsdtAddressRows(userId);
  if (rows.length) return rows;
  if (!isMongoReady()) return [];
  const UsdtAddress = getUsdtAddressModel();
  return UsdtAddress.find({ userId }).sort({ createdAt: -1 }).lean();
}

function normalizeUsdtNetwork(value?: string): UsdtNetwork {
  const raw = String(value || "TRC20").trim().toUpperCase();
  if (raw === "BEP20") return "BEP20";
  if (raw === "POLYGON") return "POLYGON";
  return "TRC20";
}

function extractUsdtAddress(payload: any) {
  if (!payload || typeof payload !== "object") return undefined;
  if (payload.address) return String(payload.address);
  if (payload.data?.address) return String(payload.data.address);
  if (payload.data?.wallet?.address) return String(payload.data.wallet.address);
  if (payload.wallet?.address) return String(payload.wallet.address);
  if (payload.walletAddress) return String(payload.walletAddress);
  if (payload.data?.walletAddress) return String(payload.data.walletAddress);
  if (payload.data?.wallet_address) return String(payload.data.wallet_address);
  if (payload.result?.address) return String(payload.result.address);
  if (payload.result?.walletAddress) return String(payload.result.walletAddress);
  if (payload.data?.result?.address) return String(payload.data.result.address);
  return undefined;
}

function extractUsdtAddressByNetwork(payload: any, network?: string) {
  const targetNetwork = normalizeUsdtNetwork(network);
  if (!payload) return undefined;

  const arraysToCheck = [
    payload?.addresses,
    payload?.data?.addresses,
    payload?.result?.addresses,
    payload?.data?.result?.addresses,
    payload?.wallets,
    payload?.data?.wallets,
  ];

  for (const entries of arraysToCheck) {
    if (!Array.isArray(entries)) continue;
    for (const item of entries) {
      if (!item || typeof item !== "object") continue;
      const itemNetwork = normalizeUsdtNetwork(item?.network);
      const addr = extractUsdtAddress(item);
      if (addr && itemNetwork === targetNetwork) return addr;
    }
  }

  return extractUsdtAddress(payload);
}

function isLikelyUsdtWalletAddress(value?: string) {
  const raw = String(value || "").trim();
  if (!raw) return false;
  if (/^T[1-9A-HJ-NP-Za-km-z]{25,45}$/.test(raw)) return true; // Tron/TRC20
  if (/^0x[a-fA-F0-9]{40}$/.test(raw)) return true; // EVM (BEP20/POLYGON)
  return false;
}

function inferUsdtNetwork(input: any): UsdtNetwork | undefined {
  const value = String(input || "").trim().toLowerCase();
  if (!value) return undefined;
  if (value.includes("trc20") || value.includes("tron")) return "TRC20";
  if (value.includes("bep20") || value.includes("bsc") || value.includes("binance")) return "BEP20";
  if (value.includes("polygon") || value.includes("matic")) return "POLYGON";
  return undefined;
}

function collectUsdtAddressRecords(payload: any): Array<{ address: string; network?: UsdtNetwork }> {
  const out: Array<{ address: string; network?: UsdtNetwork }> = [];
  const seenNodes = new Set<any>();
  const seenAddress = new Set<string>();
  const queue = [payload];

  while (queue.length) {
    const node = queue.shift();
    if (!node || typeof node !== "object" || seenNodes.has(node)) continue;
    seenNodes.add(node);

    const asAny = node as any;
    const candidates = [
      asAny.address,
      asAny.walletAddress,
      asAny.wallet_address,
      asAny.depositAddress,
      asAny.usdtAddress,
      asAny.usdt_address,
    ];

    for (const item of candidates) {
      const address = String(item || "").trim();
      if (!isLikelyUsdtWalletAddress(address) || seenAddress.has(address)) continue;
      const network = inferUsdtNetwork(asAny.network || asAny.chain || asAny.blockchain || asAny.protocol)
        || (address.startsWith("T") ? "TRC20" : undefined);
      out.push({ address, network });
      seenAddress.add(address);
    }

    for (const val of Object.values(asAny)) {
      if (Array.isArray(val)) {
        for (const child of val) queue.push(child);
      } else if (val && typeof val === "object") {
        queue.push(val);
      }
    }
  }

  return out;
}

async function syncUsdtAddressesFromProvider(userId: string, email?: string) {
  const customerEmail = String(email || "").trim();
  if (!customerEmail) return [] as any[];
  const public_key = requirePublicKey();

  let payload: any = null;
  try {
    const lookup = await bitvcard.get("getcardholder/", {
      params: { public_key, customerEmail },
    });
    payload = lookup?.data || null;
  } catch {
    return [];
  }

  const found = collectUsdtAddressRecords(payload);
  if (!found.length) return [];

  const savedRows: any[] = [];
  for (const entry of found) {
    if (isPrismaPersistenceEnabled()) {
      const saved = await upsertUsdtAddressRow({
        userId,
        address: entry.address,
        label: `user:${userId}`,
        network: entry.network || "TRC20",
        responseData: payload,
      });
      savedRows.push(saved ?? { userId, address: entry.address, network: entry.network || "TRC20", status: "active" });
    } else if (!isMongoReady()) {
      savedRows.push({ userId, address: entry.address, network: entry.network || "TRC20", status: "active", responseData: payload });
    } else {
      const UsdtAddress = getUsdtAddressModel();
      const saved = await UsdtAddress.findOneAndUpdate(
        { address: entry.address },
        {
          $set: {
            userId,
            label: `user:${userId}`,
            network: entry.network || "TRC20",
            responseData: payload,
            status: "active",
          },
        },
        { upsert: true, new: true }
      );
      savedRows.push(saved);
    }
  }

  return savedRows;
}

function normalizeError(e: any) {
  // Axios error normalization
  if (typeof (axios as any).isAxiosError === "function" && (axios as any).isAxiosError(e)) {
    const ae = e as AxiosError<any>;
    const status = ae.response?.status ?? 400;
    const payload = ae.response?.data;
    const rawMsg = payload?.message || payload?.error || ae.message || "Request failed";
    const msg = typeof rawMsg === "string" ? rawMsg : JSON.stringify(rawMsg);
    return { status, message: String(msg) };
  }
  const status = e?.status ?? 400;
  const rawMsg = e?.message ?? "Request error";
  const msg = typeof rawMsg === "string" ? rawMsg : JSON.stringify(rawMsg);
  return { status, message: String(msg) };
}

function shouldDebugStroWallet() {
  return String(process.env.STROWALLET_DEBUG_LOGS || "").toLowerCase() === "true";
}

function maskValue(value: string, showStart = 4, showEnd = 2) {
  if (!value) return "";
  const str = String(value);
  if (str.length <= showStart + showEnd) return str;
  return `${str.slice(0, showStart)}***${str.slice(-showEnd)}`;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(headers: any): number | null {
  if (!headers) return null;
  const raw = headers["retry-after"] || headers["Retry-After"];
  if (!raw) return null;
  const asNumber = Number(raw);
  if (Number.isFinite(asNumber) && asNumber >= 0) {
    return Math.round(asNumber * 1000);
  }
  const asDate = new Date(String(raw));
  if (Number.isFinite(asDate.getTime())) {
    const diff = asDate.getTime() - Date.now();
    return diff > 0 ? diff : 0;
  }
  return null;
}

async function postWithRetry(url: string, payload: any, config: any) {
  const maxRetries = 4;
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    try {
      return await bitvcard.post(url, payload, config);
    } catch (err: any) {
      const status = err?.response?.status;
      if (status !== 429 || attempt === maxRetries - 1) throw err;
      const retryAfterMs = parseRetryAfterMs(err?.response?.headers);
      const backoffMs = retryAfterMs ?? 2000 * Math.pow(2, attempt);
      await delay(backoffMs);
    }
  }
  throw new Error("fund-card retry attempts exhausted");
}

let fundCardQueue = Promise.resolve();
function enqueueFundCard<T>(task: () => Promise<T>) {
  const run = fundCardQueue.then(task, task);
  fundCardQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

// 1) Create Customer
const internationalPhone = z.string().regex(/^[1-9]\d{10,14}$/); // e.g., 2348012345678 (no '+')
const mmddyyyy = z.string().regex(/^\d{2}\/\d{2}\/\d{4}$/);
const amountString = z
  .string()
  .regex(/^\d+(\.\d+)?$/)
  .refine((v) => Number(v) > 0, "amount must be greater than zero");
const CardIdSchema = z.union([z.string(), z.number()]).transform((v) => String(v));

// Accept either a remote URL or base64/data-uri for images (idImage, userPhoto)
const UrlOrBase64 = z
  .string()
  .refine((v) => {
    if (!v || typeof v !== "string") return false;
    // Data URI (e.g. data:image/png;base64,...) or raw base64 blob
    const dataUri = /^data:[^;\s]+;base64,[A-Za-z0-9+/=\s]+$/i;
    if (dataUri.test(v)) return true;
    // Try URL
    try {
      // new URL will throw if invalid
      // accept relative/absolute http(s) urls only
      const u = new URL(v);
      return u.protocol === "http:" || u.protocol === "https:" || u.protocol === "data:";
    } catch (err) {
      // not a URL -> test data URI or long base64 blob heuristics
    }
    // Raw base64: require a reasonably long string to reduce false positives
    const rawBase64 = /^[A-Za-z0-9+/=\s]{50,}$/;
    return rawBase64.test(v);
  }, "must be a valid URL or base64 data");

const CreateCustomerSchema = z.object({
  houseNumber: z.string().min(1),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  idNumber: z.string().min(1),
  customerEmail: z.string().email(),
  phoneNumber: internationalPhone,
  dateOfBirth: mmddyyyy, // MM/DD/YYYY
  idImage: UrlOrBase64,
  userPhoto: UrlOrBase64,
  line1: z.string().min(1),
  state: z.string().min(1),
  zipCode: z.string().min(1),
  city: z.string().min(1),
  country: z.string().min(1),
  idType: z.enum(["NIN", "PASSPORT", "DRIVING_LICENSE"]),
});

router.post("/create-user", async (req, res) => {
  try {
    const body = CreateCustomerSchema.parse(req.body || {});
    const public_key = requirePublicKey();
    const payload = { ...body, public_key };
    const queryParams = {
      public_key,
      houseNumber: body.houseNumber,
      firstName: body.firstName,
      lastName: body.lastName,
      idNumber: body.idNumber,
      customerEmail: body.customerEmail,
      phoneNumber: body.phoneNumber,
      dateOfBirth: body.dateOfBirth,
      line1: body.line1,
      state: body.state,
      zipCode: body.zipCode,
      city: body.city,
      country: body.country,
      idType: body.idType,
    } as Record<string, string>;

    const tryCardUserFallback = async () => {
      try {
        const altResp = await bitvcard.post("card-user/", payload, {
          headers: { "Content-Type": "application/json" },
          params: queryParams,
        });
        return altResp.data;
      } catch {
        const altResp = await bitvcard.get("card-user/", { params: queryParams });
        return altResp.data;
      }
    };

    const tryCreateUserGet = async () => {
      const resp = await bitvcard.get("create-user/", { params: queryParams });
      return resp.data;
    };

    let data: any;
    try {
      const resp = await bitvcard.post("create-user/", payload, {
        headers: { "Content-Type": "application/json" },
      });
      data = resp.data;
      const msg = String(data?.message || data?.error || "");
      if (data?.success === false && /register card user failed/i.test(msg)) {
        data = await tryCardUserFallback();
      }
    } catch (firstError: any) {
      if (firstError?.response?.status === 405) {
        data = await tryCreateUserGet();
      } else {
        // Fallback for provider deployments that only parse URL query params.
        try {
          const fallbackResp = await bitvcard.post("create-user/", payload, {
            headers: { "Content-Type": "application/json" },
            params: queryParams,
          });
          data = fallbackResp.data;
          console.warn("[strowallet] create-user primary attempt failed, fallback succeeded", {
            firstStatus: firstError?.response?.status,
            firstMessage: firstError?.response?.data?.message || firstError?.response?.data?.error || firstError?.message,
          });
        } catch (secondError: any) {
          data = await tryCardUserFallback();
          console.warn("[strowallet] create-user attempts failed; card-user fallback used", {
            firstStatus: firstError?.response?.status,
            firstMessage: firstError?.response?.data?.message || firstError?.response?.data?.error || firstError?.message,
            secondStatus: secondError?.response?.status,
            secondMessage: secondError?.response?.data?.message || secondError?.response?.data?.error || secondError?.message,
          });
        }
      }
    }
    const customerId =
      data?.response?.customerId ||
      data?.response?.customer_id ||
      data?.customerId ||
      data?.customer_id;
    if (!customerId && body.customerEmail) {
      try {
        const maxAttempts = Number(process.env.STROWALLET_LOOKUP_ATTEMPTS || (process.env.NODE_ENV === "test" ? 1 : 6));
        const delayMs = Number(process.env.STROWALLET_LOOKUP_DELAY_MS || 1200);
        for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
          if (attempt > 0) await delay(delayMs);
          const lookup = await bitvcard.get("getcardholder/", {
            params: { public_key, customerEmail: body.customerEmail },
          });
          const lookupData = lookup.data;
          const lookupId =
            lookupData?.data?.customerId ||
            lookupData?.data?.customer_id ||
            lookupData?.customerId ||
            lookupData?.customer_id;
          if (lookupId) {
            data.response = { ...(data.response || {}), customerId: lookupId };
            break;
          }
        }
      } catch {
        // ignore lookup failures
      }
    }
    return ok(res, data, 200);
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

// 2) Get Customer
router.get("/getcardholder", async (req, res) => {
  try {
    const public_key = requirePublicKey();
    const params = {
      public_key,
      customerId: req.query.customerId,
      customerEmail: req.query.customerEmail,
    };
    const resp = await bitvcard.get("getcardholder/", { params });
    return ok(res, resp.data, 200);
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

// 3) Update Customer
// Allow partial updates for customer: only `customerId` is required
const UpdateCustomerSchema = z
  .object({ customerId: z.string().min(1) })
  .merge(
    z
      .object({
        firstName: z.string().min(1),
        lastName: z.string().min(1),
        idImage: UrlOrBase64,
        userPhoto: UrlOrBase64,
        phoneNumber: internationalPhone,
        country: z.string().min(1),
        city: z.string().min(1),
        state: z.string().min(1),
        zipCode: z.string().min(1),
        line1: z.string().min(1),
        houseNumber: z.string().min(1),
      })
      .partial()
  );

// Keep existing PUT for compatibility (sends full body including undefineds)
router.put("/updateCardCustomer", async (req, res) => {
  try {
    const body = UpdateCustomerSchema.parse(req.body || {});
    const public_key = requirePublicKey();
    const payload = { ...body, public_key };
    const resp = await bitvcard.put("updateCardCustomer/", payload, {
      headers: { "Content-Type": "application/json" },
      params: payload,
    });
    return ok(res, resp.data, 200);
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

// PATCH variant forwards only provided fields (omits undefined)
router.patch("/updateCardCustomer", async (req, res) => {
  try {
    const parsed = UpdateCustomerSchema.parse(req.body || {});
    const public_key = requirePublicKey();
    // Build payload with only keys that were actually provided in the request body
    const providedBody: Record<string, any> = {};
    for (const [k, v] of Object.entries(req.body || {})) {
      if (v !== undefined) providedBody[k] = v;
    }
    // Ensure customerId exists (required)
    if (!providedBody.customerId) {
      const err: any = new Error("customerId is required in body");
      err.status = 400;
      throw err;
    }
    const payload = { ...providedBody, public_key };
    const resp = await bitvcard.patch("updateCardCustomer/", payload, {
      headers: { "Content-Type": "application/json" },
      params: payload,
    });
    return ok(res, resp.data, 200);
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

// 4) Create NFC Card
const CreateNfcCardSchema = z.object({
  name: z.string().min(1),
  first_name: z.string().min(1),
  last_name: z.string().min(1),
  dob: mmddyyyy,
  id_type: z.enum(["national_id", "passport", "drivers_license"]),
  id_number: z.string().min(1),
  email: z.string().email(),
  line1: z.string().min(1),
  city: z.string().min(1),
  state: z.string().min(1),
  postal_code: z.string().min(1),
  country: z.string().min(3).max(3),
  amount_usd: amountString,
  phone: z.string().min(5),
  mode: z.string().optional(),
});

const LegacyCreateCardSchema = z.object({
  name_on_card: z.string().min(1),
  card_type: z.string().min(1),
  amount: amountString,
  customerEmail: z.string().email().optional(),
  customer_email: z.string().email().optional(),
  mode: z.string().optional(),
});

router.post("/create-card", async (req, res) => {
  try {
    const rawBody = req.body || {};
    const useLegacy =
      rawBody?.name_on_card ||
      rawBody?.card_type ||
      rawBody?.amount ||
      rawBody?.customerEmail ||
      rawBody?.customer_email;
    const public_key = requirePublicKey();

    if (useLegacy) {
      const parsed = applyDefaultMode(LegacyCreateCardSchema.parse(rawBody));
      const payload = {
        ...parsed,
        customerEmail: parsed.customerEmail || parsed.customer_email,
        public_key,
      } as Record<string, any>;
      delete payload.customer_email;
      const resp = await bitvcard.post("create-card/", payload, {
        headers: { "Content-Type": "application/json" },
        params: payload,
      });
      return ok(res, resp.data, 200);
    }

    const body = applyDefaultMode(CreateNfcCardSchema.parse(rawBody));
    const params = { ...body, public_key };
    const resp = await bitvcard.post("create-nfc-card/", undefined, { params });
    return ok(res, resp.data, 200);
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

// 5) Fund NFC Card
const FundCardSchema = z.object({
  card_id: CardIdSchema,
  amount: amountString,
  mode: z.string().optional(),
});

router.post("/fund-card", async (req, res) => {
  try {
    const body = applyDefaultMode(FundCardSchema.parse(req.body || {}));
    const public_key = requirePublicKey();
    const payload = { ...body, public_key, type: "fund" };
    if (shouldDebugStroWallet()) {
      console.log("[strowallet] fund-card request", {
        card_id: maskValue(String(body.card_id), 3, 3),
        amount: String(body.amount),
        mode: body.mode,
        public_key: maskValue(public_key, 4, 4),
      });
    }

    const result = await enqueueFundCard(async () => {
      try {
        const resp = await postWithRetry("fund-withdraw-nfccard/", payload, {
          headers: { "Content-Type": "application/json" },
          params: payload,
        });
        if (shouldDebugStroWallet()) {
          console.log("[strowallet] fund-card response", resp.data);
        }
        return ok(res, resp.data, 200);
      } catch (firstError: any) {
        // Fallback for provider deployments that only parse URL query params.
        const queryParams: Record<string, string> = {
          public_key,
          card_id: body.card_id,
          amount: String(body.amount),
          type: "fund",
        };
        if (body.mode) queryParams.mode = body.mode;
        const fallbackResp = await postWithRetry("fund-withdraw-nfccard/", payload, {
          headers: { "Content-Type": "application/json" },
          params: queryParams,
        });
        if (shouldDebugStroWallet()) {
          console.log("[strowallet] fund-card fallback response", fallbackResp.data);
        }
        console.warn("[strowallet] fund-card primary attempt failed, fallback succeeded", {
          firstStatus: firstError?.response?.status,
          firstMessage: firstError?.response?.data?.message || firstError?.response?.data?.error || firstError?.message,
        });
        return ok(res, fallbackResp.data, 200);
      }
    });

    return result;
  } catch (e) {
    const { status, message } = normalizeError(e);
    if (shouldDebugStroWallet()) {
      console.warn("[strowallet] fund-card error", { status, message });
    }
    return fail(res, message, status);
  }
});

// 6) Get NFC Card Details
const FetchCardDetailSchema = z.object({
  card_id: CardIdSchema,
  mode: z.string().optional(),
});

router.post("/fetch-card-detail", async (req, res) => {
  try {
    const body = applyDefaultMode(FetchCardDetailSchema.parse(req.body || {}));
    const public_key = requirePublicKey();
    const params = { ...body, public_key };
    const resp = await bitvcard.get("fetch-nfccard-detail/", { params });
    return ok(res, resp.data, 200);
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

// 7) NFC Card Transactions (recent)
const CardTransactionsSchema = z.object({
  card_id: CardIdSchema,
  mode: z.string().optional(),
});


router.post("/card-transactions", async (req, res) => {
  try {
    const body = applyDefaultMode(CardTransactionsSchema.parse(req.body || {}));
    const public_key = requirePublicKey();
    const params = { ...body, public_key };
    const resp = await bitvcard.get("nfc-card-transactions/", { params });
    return ok(res, resp.data, 200);
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

// 8) Freeze / Unfreeze NFC Card
const ActionStatusSchema = z.object({
  action: z.enum(["freeze", "unfreeze", "terminate"]),
  card_id: CardIdSchema,
});

router.post("/action/status", async (req, res) => {
  try {
    const body = ActionStatusSchema.parse(req.body || {});
    const public_key = requirePublicKey();
    const status = body.action === "freeze"
      ? "frozen"
      : body.action === "unfreeze"
        ? "active"
        : "terminated";
    const params = { card_id: body.card_id, status, public_key } as Record<string, any>;
    const mode = normalizeMode(getDefaultMode());
    if (mode) (params as any).mode = mode;

    // Some providers support only active/frozen for this endpoint.
    if (body.action !== "terminate") {
      const resp = await bitvcard.post("nfc-cards/status/", undefined, { params });
      return ok(res, resp.data, 200);
    }

    const terminateStatuses = ["terminated", "inactive", "closed", "deactivated", "frozen"];
    let lastError: any = null;
    for (const candidate of terminateStatuses) {
      try {
        const candidateParams = { ...params, status: candidate };
        const resp = await bitvcard.post("nfc-cards/status/", undefined, { params: candidateParams });
        const data: any = resp.data || {};
        return ok(res, {
          ...data,
          action: "terminate",
          statusApplied: candidate,
          providerSupportsTerminate: candidate !== "frozen",
          note: candidate === "frozen"
            ? "Provider does not support hard terminate via this endpoint; fallback status applied."
            : undefined,
        }, 200);
      } catch (err: any) {
        const providerMsg = String(
          err?.response?.data?.message ||
          err?.response?.data?.error ||
          err?.message ||
          ""
        ).toLowerCase();
        const alreadyTerminated =
          providerMsg.includes("already terminated") ||
          providerMsg.includes("from terminated") ||
          providerMsg.includes("cannot transition card from terminated");

        if (alreadyTerminated) {
          return ok(res, {
            ok: true,
            action: "terminate",
            statusApplied: "terminated",
            providerSupportsTerminate: true,
            note: "Provider reports card is already terminated.",
          }, 200);
        }
        lastError = err;
      }
    }

    throw lastError || new Error("Terminate status not accepted by provider");
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

// 9) Full Card History (paginated)
router.get("/apicard-transactions", async (req, res) => {
  try {
    const public_key = requirePublicKey();
    const page = Number(req.query.page ?? 1) || 1;
    const takeRaw = Number(req.query.take ?? 50);
    const take = takeRaw > 0 ? Math.min(takeRaw, 50) : 50; // enforce max 50 per docs
    const cardId = pickCardId(req);

    const params: Record<string, any> = {
      card_id: cardId,
      cardId: cardId,
      page,
      take,
      public_key,
    };
    const mode = normalizeMode(typeof req.query.mode === "string" ? req.query.mode : getDefaultMode());
    const developer_code = typeof req.query.developer_code === "string" ? req.query.developer_code : undefined;
    if (mode) params.mode = mode;
    if (developer_code) params.developer_code = developer_code;
    const resp = await api.get(`apicard-transactions/`, { params });
    return ok(res, resp.data, 200);
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

// 9b) Full Card History (paginated) via POST body (helps when query parsing is unreliable)
router.post("/apicard-transactions", async (req, res) => {
  try {
    const public_key = requirePublicKey();
    const cardId = pickCardId(req);
    const pageRaw = (req.body as any)?.page ?? req.query.page;
    const takeRaw = (req.body as any)?.take ?? req.query.take;
    const page = Number(pageRaw ?? 1) || 1;
    const takeParsed = Number(takeRaw ?? 50);
    const take = takeParsed > 0 ? Math.min(takeParsed, 50) : 50;
    const params: Record<string, any> = {
      card_id: cardId,
      cardId: cardId,
      page,
      take,
      public_key,
    };
    const mode = normalizeMode((req.body as any)?.mode ?? (req.query as any)?.mode ?? getDefaultMode());
    const developer_code = (req.body as any)?.developer_code ?? (req.query as any)?.developer_code;
    if (mode) params.mode = mode;
    if (developer_code) params.developer_code = developer_code;

    const resp = await api.get(`apicard-transactions/`, { params });
    return ok(res, resp.data, 200);
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

// 10) Wallet Balance by currency (e.g., USD, NGN)
router.get("/wallet-balance/:currency", async (req, res) => {
  try {
    const public_key = requirePublicKey();
    const currencyRaw = String(req.params.currency || "USD").trim().toUpperCase();
    const currency = /^[A-Z]{3,5}$/.test(currencyRaw) ? currencyRaw : "USD";

    const resp = await api.get(`wallet/balance/${currency}/`, {
      params: { public_key },
    });
    return ok(res, resp.data, 200);
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

// Virtual Bank Account (create or fetch)
router.get("/virtual-bank/account", async (req, res) => {
  try {
    return fail(res, "Virtual bank accounts are available for Nigerian users only", 403);
    const userId = String(req.query.userId || "").trim();
    if (!userId) return fail(res, "userId is required", 400);
    const existing = await findExistingVirtualAccount(userId);
    if (!existing) return ok(res, { account: null }, 200);
    return ok(res, { account: existing }, 200);
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

router.post("/virtual-bank/account", async (req, res) => {
  try {
    return fail(res, "Virtual bank accounts are available for Nigerian users only", 403);
    const body = VirtualBankRequestSchema.parse(req.body || {});
    if (shouldSkipCreate(virtualAccountCreateLocks, body.userId, VIRTUAL_ACCOUNT_CREATE_TTL_MS)) {
      const cached = virtualAccountCreateLocks.get(body.userId);
      return ok(res, { account: cached?.account ?? null, pending: true }, 200);
    }
    if (!body.forceCreate) {
      const existing = await findExistingVirtualAccount(body.userId);
      if (existing) return ok(res, { account: existing }, 200);
    }

    if (body.forceCreate) {
      virtualAccountCreateLocks.set(body.userId, { startedAt: Date.now() });
    }

    const user = await findUserById(body.userId);
    const accountName = body.accountName || [user?.firstName, user?.lastName].filter(Boolean).join(" ") || user?.username || body.userId;
    const email = body.email || user?.customerEmail;
    const phone = body.phone || user?.phoneNumber;
    if (!email || !phone || !accountName) {
      return fail(res, "Missing email, phone, or accountName for virtual account", 400);
    }

    const public_key = requirePublicKey();
    const webhook_url = body.webhookUrl || getWebhookUrl("/api/webhook/strowallet");
    const provider = normalizeVirtualBankProvider(body.bank);
    const payload: Record<string, any> = {
      public_key,
      email,
      account_name: accountName,
      phone,
      webhook_url,
    };
    if (body.mode) payload.mode = body.mode;
    if (body.developerCode) payload.developer_code = body.developerCode;

    const resp = await api.post(`virtual-bank/${provider}`, payload, {
      headers: { "Content-Type": "application/json" },
    });
    const data = resp.data || {};
    const accountNumber = String(data?.accountNumber || data?.account_number || "");
    const sessionId = String(data?.sessionId || data?.session_id || "");
    if (!accountNumber) {
      return ok(res, { account: null, raw: data }, 200);
    }

    if (isPrismaPersistenceEnabled() && hasPrismaModel("virtualBankAccount")) {
      const saved = await prismaAny.virtualBankAccount.upsert({
        where: { accountNumber },
        create: {
          userId: body.userId,
          provider,
          accountNumber,
          accountName,
          bankName: data?.sourceBankName || data?.bankName || null,
          sessionId: sessionId || null,
          currency: data?.currency || "NGN",
          responseData: data as any,
        },
        update: {
          userId: body.userId,
          provider,
          accountName,
          bankName: data?.sourceBankName || data?.bankName || null,
          sessionId: sessionId || null,
          currency: data?.currency || "NGN",
          responseData: data as any,
        },
      });
      return ok(res, { account: saved, raw: data }, 200);
    }

    if (!isMongoReady()) {
      const response = { account: null, raw: data };
      if (body.forceCreate) virtualAccountCreateLocks.set(body.userId, { startedAt: Date.now(), account: response.account });
      return ok(res, response, 200);
    }

    const VirtualBankAccount = getVirtualBankAccountModel();
    const saved = await VirtualBankAccount.findOneAndUpdate(
      { accountNumber },
      {
        $set: {
          userId: body.userId,
          provider,
          accountName,
          bankName: data?.sourceBankName || data?.bankName,
          sessionId: sessionId || undefined,
          currency: data?.currency || "NGN",
          responseData: data,
        },
      },
      { upsert: true, new: true }
    );
    const response = { account: saved, raw: data };
    if (body.forceCreate) virtualAccountCreateLocks.set(body.userId, { startedAt: Date.now(), account: response.account });
    return ok(res, response, 200);
  } catch (e) {
    if (req?.body?.userId) virtualAccountCreateLocks.delete(String(req.body.userId));
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

// Bank list + account name + transfer
router.get("/banks/list", async (req, res) => {
  try {
    const public_key = requirePublicKey();
    const resp = await api.get("banks/lists", { params: { public_key } });
    return ok(res, resp.data, 200);
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

router.get("/banks/resolve", async (req, res) => {
  try {
    const public_key = requirePublicKey();
    const bank_code = String(req.query.bank_code || "").trim();
    const account_number = String(req.query.account_number || "").trim();
    if (!bank_code || !account_number) return fail(res, "bank_code and account_number are required", 400);
    const resp = await api.get("banks/get-customer-name", {
      params: { public_key, bank_code, account_number },
    });
    return ok(res, resp.data, 200);
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

router.post("/banks/transfer", async (req, res) => {
  try {
    const body = BankTransferSchema.parse(req.body || {});
    const public_key = requirePublicKey();
    const params = {
      public_key,
      amount: body.amount,
      bank_code: body.bank_code,
      account_number: body.account_number,
      narration: body.narration,
      name_enquiry_reference: body.name_enquiry_reference,
      SenderName: body.SenderName,
      mode: body.mode || getDefaultMode(),
    };
    const resp = await api.post("banks/request", undefined, { params });
    return ok(res, resp.data, 200);
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

// USDT address
router.get("/usdt/address", async (req, res) => {
  try {
    const userId = String(req.query.userId || "").trim();
    if (!userId) return fail(res, "userId is required", 400);
    let existing = await findExistingUsdtAddresses(userId);
    if (!existing.length) {
      const user = await findUserById(userId);
      const discovered = await syncUsdtAddressesFromProvider(userId, user?.customerEmail || undefined);
      if (discovered.length) {
        existing = await findExistingUsdtAddresses(userId);
      }
    }
    if (!existing.length) {
      const cached = usdtAddressCreateLocks.get(userId);
      if (cached?.address) return ok(res, { addresses: Array.isArray(cached.address) ? cached.address : [cached.address], address: Array.isArray(cached.address) ? cached.address[0] : cached.address }, 200);
    }
    if (!existing.length) return ok(res, { address: null, addresses: [] }, 200);
    const ordered = SUPPORTED_USDT_NETWORKS.map((network) => existing.find((row: any) => normalizeUsdtNetwork(row?.network) === network)).filter(Boolean);
    return ok(res, { address: ordered[0], addresses: ordered }, 200);
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

router.post("/usdt/address", async (req, res) => {
  try {
    const body = UsdtAddressSchema.parse(req.body || {});
    if (shouldSkipCreate(usdtAddressCreateLocks, body.userId, USDT_ADDRESS_CREATE_TTL_MS)) {
      const cached = usdtAddressCreateLocks.get(body.userId);
      return ok(res, { address: cached?.address ?? null, pending: true }, 200);
    }
    const existing = await findExistingUsdtAddresses(body.userId);
    const requestedNetworks = body.network ? [normalizeUsdtNetwork(body.network)] : [...SUPPORTED_USDT_NETWORKS];
    const existingByNetwork = requestedNetworks
      .map((network) => existing.find((row: any) => normalizeUsdtNetwork(row?.network) === network))
      .filter(Boolean);
    if (existingByNetwork.length === requestedNetworks.length) {
      return ok(res, { address: existingByNetwork[0], addresses: existingByNetwork, created: false }, 200);
    }
    const cachedExisting = usdtAddressCreateLocks.get(body.userId);
    if (cachedExisting?.address) {
      const cachedList = Array.isArray(cachedExisting.address) ? cachedExisting.address : [cachedExisting.address];
      return ok(res, { address: cachedList[0] || null, addresses: cachedList, created: false }, 200);
    }

    if (body.forceCreate) {
      usdtAddressCreateLocks.set(body.userId, { startedAt: Date.now() });
    }

    const user = await findUserById(body.userId);
    const email = body.email || user?.customerEmail;
    if (!email) return fail(res, "Missing email for USDT address", 400);

    const public_key = requirePublicKey();
    const label = body.label || `user:${body.userId}`;
    const webhook_url = body.webhookUrl || getWebhookUrl("/api/webhook/strowallet");
    const createdAddresses: any[] = [];
    const rawResponses: any[] = [];

    for (const network of requestedNetworks) {
      const existingForNetwork = existing.find((row: any) => normalizeUsdtNetwork(row?.network) === network);
      if (existingForNetwork) {
        createdAddresses.push(existingForNetwork);
        continue;
      }

      const params: Record<string, any> = {
        public_key,
        label,
        email,
        webhook_url,
        mode: body.mode || getDefaultMode(),
        network,
      };
      if (shouldDebugStroWallet()) {
        console.log("[strowallet] usdt address request", {
          userId: body.userId,
          label,
          email: maskValue(email, 3, 3),
          webhook_url,
          mode: params.mode,
          network,
          public_key: maskValue(public_key, 4, 4),
        });
      }
      let data: any = {};
      try {
        const resp = await api.post("generate-address", undefined, { params });
        data = resp.data || {};
      } catch (providerErr: any) {
        const providerMessage = String(providerErr?.response?.data?.message || providerErr?.response?.data?.error || providerErr?.message || "");
        if (shouldDebugStroWallet()) {
          console.warn("[strowallet] usdt address request failed", {
            userId: body.userId,
            network,
            message: providerMessage,
            data: providerErr?.response?.data,
          });
        }
        if (providerMessage.toLowerCase().includes("address already exists")) {
          const errorPayload = providerErr?.response?.data || {};
          const recoveredAddress = extractUsdtAddressByNetwork(errorPayload, network);
          if (recoveredAddress) {
            if (isPrismaPersistenceEnabled()) {
              const saved = await upsertUsdtAddressRow({
                userId: body.userId,
                address: recoveredAddress,
                label,
                network,
                responseData: errorPayload,
              });
              createdAddresses.push(saved ?? { userId: body.userId, address: recoveredAddress, label, network, status: "active" });
            } else if (!isMongoReady()) {
              createdAddresses.push({ address: recoveredAddress, userId: body.userId, label, network, status: "active", responseData: errorPayload });
            } else {
              const UsdtAddress = getUsdtAddressModel();
              const saved = await UsdtAddress.findOneAndUpdate(
                { address: recoveredAddress },
                { $set: { userId: body.userId, label, network, responseData: errorPayload } },
                { upsert: true, new: true }
              );
              createdAddresses.push(saved);
            }
            continue;
          }

          const refreshed = await findExistingUsdtAddresses(body.userId);
          const recovered = refreshed.find((row: any) => normalizeUsdtNetwork(row?.network) === network);
          if (recovered) {
            createdAddresses.push(recovered);
            continue;
          }

          const discovered = await syncUsdtAddressesFromProvider(body.userId, email);
          const discoveredByNetwork = discovered.find((row: any) => normalizeUsdtNetwork(row?.network) === network);
          if (discoveredByNetwork) {
            createdAddresses.push(discoveredByNetwork);
            continue;
          }
        }
        rawResponses.push({ network, error: providerErr?.response?.data || providerMessage });
        continue;
      }
      rawResponses.push({ network, data });
      if (shouldDebugStroWallet()) {
        console.log("[strowallet] usdt address response", { network, data });
      }
      const address = extractUsdtAddress(data);
      if (!address) continue;

      if (isPrismaPersistenceEnabled()) {
        const saved = await upsertUsdtAddressRow({ userId: body.userId, address, label, network, responseData: data });
        createdAddresses.push(saved ?? { userId: body.userId, address, label, network, status: "active" });
      } else if (!isMongoReady()) {
        createdAddresses.push({ address, userId: body.userId, label, network, status: "active", responseData: data });
      } else {
        const UsdtAddress = getUsdtAddressModel();
        const saved = await UsdtAddress.findOneAndUpdate(
          { address },
          { $set: { userId: body.userId, label, network, responseData: data } },
          { upsert: true, new: true }
        );
        createdAddresses.push(saved);
      }
    }

    const ordered = SUPPORTED_USDT_NETWORKS.map((network) => createdAddresses.find((row: any) => normalizeUsdtNetwork(row?.network) === network)).filter(Boolean);
    const response = { address: ordered[0] || null, addresses: ordered, raw: rawResponses, created: ordered.length > 0 };
    usdtAddressCreateLocks.set(body.userId, { startedAt: Date.now(), address: ordered });
    return ok(res, response, 200);
  } catch (e) {
    if (req?.body?.userId) usdtAddressCreateLocks.delete(String(req.body.userId));
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

// USDT history by address
router.get("/usdt/history", async (req, res) => {
  try {
    const query = UsdtHistoryQuerySchema.parse(req.query || {});
    const public_key = requirePublicKey();
    const resp = await api.get("get-usdt-history", {
      params: {
        public_key,
        address: query.address,
      },
    });
    return ok(res, resp.data, 200);
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

// USDT balance (platform wallet)
router.get("/usdt/balance", async (req, res) => {
  try {
    const userId = String(req.query.userId || "").trim();
    if (userId) {
      const shouldSync = String(req.query.sync ?? "true").toLowerCase() !== "false";
      if (shouldSync) {
        const addressRows = await findExistingUsdtAddresses(userId);
        for (const addressRow of addressRows) {
          const address = addressRow?.address ? String(addressRow.address) : "";
          if (!address) continue;
          await syncUserUsdtDepositsFromProvider(userId, address, 30).catch((err) => {
            if (shouldDebugStroWallet()) {
              console.warn("[strowallet] usdt balance sync failed", {
                userId,
                address,
                message: err?.message || String(err),
              });
            }
          });
        }
      }

      if (isPrismaPersistenceEnabled()) {
        const user = await prisma.user.findUnique({ where: { userId } });
        const balance = Number(user?.balance ?? 0);
        return ok(res, { balance, currency: "USDT", source: "user" }, 200);
      }
      if (!isMongoReady()) return ok(res, { balance: 0, currency: "USDT", source: "user" }, 200);
      const user = await User.findOne({ userId }).lean();
      const balance = Number(user?.balance ?? 0);
      return ok(res, { balance, currency: "USDT", source: "user" }, 200);
    }

    const public_key = requirePublicKey();
    const currencyRaw = String(req.query.currency || "USD").trim().toUpperCase();
    const normalized = currencyRaw === "USDT" ? "USD" : currencyRaw;
    const currency = /^[A-Z]{3,5}$/.test(normalized) ? normalized : "USD";
    const resp = await api.get(`wallet/balance/${currency}/`, {
      params: { public_key },
    });
    return ok(res, resp.data, 200);
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

// Send USDT
router.post("/usdt/send", async (req, res) => {
  try {
    const body = UsdtSendSchema.parse(req.body || {});
    const public_key = requirePublicKey();
    const vip_key = body.vipKey || process.env.STROWALLET_VIP_KEY;
    if (!vip_key) return fail(res, "Send USDT is available on VIP plan only", 403);
    const params: Record<string, any> = {
      public_key,
      vip_key,
      amount: body.amount,
      address: body.address,
    };
    const mode = normalizeMode(body.mode || getDefaultMode());
    if (mode) params.mode = mode;
    const resp = await api.post("send-usdt", undefined, { params });
    return ok(res, resp.data, 200);
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

// User-level USDT deposit history (internal ledger)
router.get("/usdt/transactions", async (req, res) => {
  try {
    const userId = String(req.query.userId || "").trim();
    if (!userId) return fail(res, "userId is required", 400);
    const limit = Number(req.query.limit || 10);
    const shouldSync = String(req.query.sync ?? "true").toLowerCase() !== "false";
    if (shouldSync) {
      const addressRows = await findExistingUsdtAddresses(userId);
      for (const addressRow of addressRows) {
        const address = addressRow?.address ? String(addressRow.address) : "";
        if (!address) continue;
        await syncUserUsdtDepositsFromProvider(userId, address, Math.max(20, Number(limit) || 10)).catch((err) => {
          if (shouldDebugStroWallet()) {
            console.warn("[strowallet] usdt transactions sync failed", {
              userId,
              address,
              message: err?.message || String(err),
            });
          }
        });
      }
    }

    const items = await listUserUsdtDeposits(userId, limit);
    return ok(res, { items, total: items.length }, 200);
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

// Bills: electricity + airtime + data
router.post("/bills/electricity", async (req, res) => {
  try {
    const body = ElectricitySchema.parse(req.body || {});
    const public_key = requirePublicKey();
    const payload = { public_key, ...body };
    const resp = await api.post("electricity/request", payload, {
      headers: { "Content-Type": "application/json" },
    });
    return ok(res, resp.data, 200);
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

// Bills: airtime + data
router.post("/bills/airtime", async (req, res) => {
  try {
    const body = AirtimeSchema.parse(req.body || {});
    const public_key = requirePublicKey();
    const payload = { public_key, ...body };
    const resp = await api.post("buyairtime/request", payload, {
      headers: { "Content-Type": "application/json" },
    });
    return ok(res, resp.data, 200);
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

router.get("/bills/data/plans", async (req, res) => {
  try {
    const query = DataPlanQuerySchema.parse(req.query || {});
    const public_key = requirePublicKey();
    const resp = await api.get("buydata/plans", {
      params: { public_key, service_name: query.service_name },
    });
    return ok(res, resp.data, 200);
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

router.post("/bills/data", async (req, res) => {
  try {
    const body = BuyDataSchema.parse(req.body || {});
    const public_key = requirePublicKey();
    const payload = { public_key, ...body };
    const resp = await api.post("buydata/request", payload, {
      headers: { "Content-Type": "application/json" },
    });
    return ok(res, resp.data, 200);
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

export default router;
