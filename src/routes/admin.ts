import express from "express";
import axios, { AxiosError } from "axios";
import crypto from "crypto";
import http from "http";
import https from "https";
import mongoose from "mongoose";
import { z } from "zod";
import { v2 as cloudinary } from "cloudinary";
import User from "../models/User";
import Customer from "../models/Customer";
import Card from "../models/Card";
import CardRequest from "../models/CardRequest";
import RuntimeAudit from "../models/RuntimeAudit";
import { TelegramLink } from "../models/TelegramLink";
import Transaction from "../models/Transaction";
import { notifyCardLinkedToUser, notifyCardStatusChanged } from "../services/botService";
import { createBroadcastJob, getBroadcastJobById, getBroadcastTargetCount, listBroadcastJobs } from "../services/broadcastService";
import { auditCardTransactions, getReconciliationSummary, reconcileAllCards, reconcileCard } from "../services/reconciliationService";
import { ok, fail } from "../utils/apiResponse";
import prisma from "../utils/prisma";
import { isPrismaPersistenceEnabled } from "../utils/persistence";

const router = express.Router();
const prismaAny = prisma as any;

const BITVCARD_BASE = "https://strowallet.com/api/bitvcard/";
const API_BASE = "https://strowallet.com/api/";
const STROWALLET_PREFER_IPV4 = String(process.env.STROWALLET_PREFER_IPV4 || "true").toLowerCase() !== "false";
const httpAgent = STROWALLET_PREFER_IPV4 ? new http.Agent({ keepAlive: true, family: 4 } as any) : undefined;
const httpsAgent = STROWALLET_PREFER_IPV4 ? new https.Agent({ keepAlive: true, family: 4 } as any) : undefined;
const bitvcard = axios.create({ baseURL: BITVCARD_BASE, timeout: 15000, httpAgent, httpsAgent });
const api = axios.create({ baseURL: API_BASE, timeout: 15000, httpAgent, httpsAgent });
const ADMIN_PREFER_PRISMA_READS = String(process.env.ADMIN_PREFER_PRISMA_READS || "true").toLowerCase() !== "false";

function getDefaultMode() {
  return process.env.STROWALLET_DEFAULT_MODE || (process.env.NODE_ENV !== "production" ? "sandbox" : undefined);
}

function normalizeMode(mode?: string) {
  if (!mode) return undefined;
  const m = String(mode).toLowerCase();
  if (m === "live") return undefined;
  return m;
}

function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction) {
  const adminToken = process.env.ADMIN_API_TOKEN;
  if (!adminToken) return next();
  const provided = req.headers["x-admin-token"] as string | undefined;
  if (provided && provided === adminToken) return next();
  return fail(res, "Unauthorized", 401);
}

function requirePublicKey() {
  const key = process.env.STROWALLET_PUBLIC_KEY;
  if (!key) {
    const err = new Error("Missing STROWALLET_PUBLIC_KEY env");
    (err as any).status = 500;
    throw err;
  }
  return key;
}

function normalizeError(e: any) {
  if (axios.isAxiosError(e)) {
    const ae = e as AxiosError<any>;
    const status = ae.response?.status ?? 400;
    const payload = ae.response?.data as any;
    const msg = payload?.message || payload?.error || ae.message || "Request failed";
    return { status, message: String(msg) };
  }
  const status = e?.status ?? 400;
  const msg = e?.message ?? "Request error";
  return { status, message: String(msg) };
}

function extractField(obj: any, keys: string[]): string | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  for (const key of keys) {
    if (obj[key] != null) return String(obj[key]);
  }
  for (const val of Object.values(obj)) {
    const v = typeof val === "object" ? extractField(val, keys) : undefined;
    if (v) return v;
  }
  return undefined;
}

async function fetchCardDetail(cardId: string, mode?: string) {
  const public_key = requirePublicKey();
  const params: any = { card_id: cardId, public_key };
  if (mode) params.mode = mode;
  const resp = await bitvcard.get("fetch-nfccard-detail/", { params });
  return resp.data;
}

async function actionCard(cardId: string, action: "freeze" | "unfreeze") {
  const public_key = requirePublicKey();
  const status = action === "freeze" ? "frozen" : "active";
  const params: any = { card_id: cardId, status, public_key };
  const mode = normalizeMode(getDefaultMode());
  if (mode) params.mode = mode;
  const resp = await bitvcard.post("nfc-cards/status/", undefined, { params });
  return resp.data;
}

async function fundCard(cardId: string, amount: string, mode?: string) {
  const public_key = requirePublicKey();
  const params: any = { card_id: cardId, amount, public_key, type: "fund" };
  if (mode) params.mode = mode;
  const resp = await bitvcard.post("fund-withdraw-nfccard/", undefined, { params });
  return resp.data;
}

async function fetchCardTransactions(cardId: string, mode?: string) {
  const public_key = requirePublicKey();
  const params: any = { card_id: cardId, public_key };
  if (mode) params.mode = mode;
  const resp = await bitvcard.get("nfc-card-transactions/", { params });
  return resp.data;
}

async function fetchCardHistory(cardId: string, page: number, take: number) {
  const public_key = requirePublicKey();
  const resp = await api.get("apicard-transactions/", {
    params: { card_id: cardId, page, take, public_key },
  });
  return resp.data;
}

const TransactionQuerySchema = z.object({
  userId: z.string().optional(),
  cardId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
const DeclineFeeReportQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).optional(),
  minOccurrences: z.coerce.number().int().min(1).max(1000).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  format: z.enum(["json", "csv"]).optional(),
});
const DECLINE_FEE_MARKER = /decline[\s_-]*fees?/i;

function includesDeclineFeeMarker(value?: any): boolean {
  if (value == null) return false;
  return DECLINE_FEE_MARKER.test(String(value));
}

function isDeclineFeeTransaction(tx: any): boolean {
  return (
    includesDeclineFeeMarker(tx?.metadata?.description) ||
    includesDeclineFeeMarker(tx?.transactionNumber) ||
    includesDeclineFeeMarker(tx?.referenceNumber) ||
    includesDeclineFeeMarker(tx?.responseData?.description) ||
    includesDeclineFeeMarker(tx?.responseData?.merchant)
  );
}

function csvEscape(value: any): string {
  const str = value == null ? "" : String(value);
  if (/[,"\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

const CardLinkSchema = z
  .object({
    cardId: z.string().min(1),
    customerEmail: z.string().email().optional(),
    userId: z.string().min(1).optional(),
    nameOnCard: z.string().min(1).optional(),
    cardType: z.string().min(1).optional(),
    status: z.string().min(1).optional(),
    last4: z.string().min(4).max(4).optional(),
    currency: z.string().min(1).optional(),
    balance: z.string().optional(),
    cardNumber: z.string().min(6).optional(),
    cvc: z.string().min(3).max(4).optional(),
    expiry: z.string().min(4).optional(),
  })
  .refine((v) => v.customerEmail || v.userId, {
    message: "customerEmail or userId is required",
  });

const BroadcastFilterSchema = z.enum(["all", "balance_positive"]);

const BroadcastCreateSchema = z.object({
  messageText: z.string().min(1).max(4096),
  imageUrl: z.string().url().optional(),
  targetFilter: BroadcastFilterSchema,
  createdBy: z.string().optional(),
});

const BroadcastUploadSchema = z.object({
  imageData: z.string().min(1),
  fileName: z.string().optional(),
  mimeType: z.string().optional(),
});

const UsdtRecoverySchema = z.object({
  userId: z.string().min(1),
  address: z.string().min(5),
  label: z.string().optional(),
  responseData: z.any().optional(),
});

const UsdtBindAddressSchema = z.object({
  userId: z.string().min(1),
  trc20: z.string().min(10).optional(),
  bep20: z.string().min(10).optional(),
  polygon: z.string().min(10).optional(),
}).refine((value) => Boolean(value.trc20 || value.bep20 || value.polygon), {
  message: "At least one network address is required",
});

const UsdtResetAddressSchema = z.object({
  userId: z.string().min(1),
  networks: z.array(z.enum(["TRC20", "BEP20", "POLYGON"])).optional(),
});

function tokenFingerprint(token?: string) {
  const raw = String(token || "").trim();
  if (!raw) return "none";
  if (raw.length <= 8) return `${raw[0] || "*"}***${raw[raw.length - 1] || "*"}`;
  return `${raw.slice(0, 4)}***${raw.slice(-4)}`;
}

async function upsertUsdtByUserNetworkPrisma(params: {
  userId: string;
  network: "TRC20" | "BEP20" | "POLYGON";
  address: string;
  label: string;
  responseData: any;
}) {
  const responseDataJson = JSON.stringify(params.responseData ?? {});
  const existingRows = await prismaAny.$queryRawUnsafe(
    'SELECT "id" FROM "UsdtAddress" WHERE "userId" = $1 AND UPPER(COALESCE("network", \'\')) = $2 ORDER BY "updatedAt" DESC LIMIT 1',
    params.userId,
    params.network
  );
  const existing = Array.isArray(existingRows) && existingRows.length ? existingRows[0] : null;

  if (existing?.id) {
    const updatedRows = await prismaAny.$queryRawUnsafe(
      `UPDATE "UsdtAddress"
       SET "address" = $1,
           "label" = $2,
           "network" = $3,
           "status" = 'active',
           "responseData" = $4::jsonb,
           "updatedAt" = NOW()
       WHERE "id" = $5
       RETURNING *`,
      params.address,
      params.label,
      params.network,
      responseDataJson,
      String(existing.id)
    );
    return Array.isArray(updatedRows) && updatedRows.length ? updatedRows[0] : null;
  }

  const insertedRows = await prismaAny.$queryRawUnsafe(
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
    params.label,
    params.network,
    responseDataJson
  );
  return Array.isArray(insertedRows) && insertedRows.length ? insertedRows[0] : null;
}

function ensureCloudinary() {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  if (!cloudName || !apiKey || !apiSecret) {
    const err: any = new Error("Cloudinary is not configured");
    err.status = 500;
    throw err;
  }
  cloudinary.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret, secure: true });
}

function startOfUtcDay(date = new Date()) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function toFiniteNumber(value: any, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function extractTransactionMetadata(tx: any) {
  const metadata = tx?.metadata && typeof tx.metadata === "object" && !Array.isArray(tx.metadata) ? tx.metadata : {};
  return {
    kind: String(metadata?.kind || "").toLowerCase(),
    source: String(metadata?.source || "").toLowerCase(),
    direction: String(metadata?.direction || "").toLowerCase(),
    cardId: metadata?.cardId ? String(metadata.cardId) : undefined,
    recipientUserId: metadata?.recipientUserId ? String(metadata.recipientUserId) : undefined,
    senderUserId: metadata?.senderUserId ? String(metadata.senderUserId) : undefined,
  };
}

function isBillPaymentTxn(tx: any) {
  const meta = extractTransactionMetadata(tx);
  return meta.kind === "bill_payment" || meta.source.startsWith("bill_") || String(tx?.transactionType || "").toLowerCase() === "bill";
}

function isP2pTransferTxn(tx: any) {
  const meta = extractTransactionMetadata(tx);
  return meta.kind === "p2p_transfer" && meta.direction === "debit";
}

function isWalletCardTopupTxn(tx: any) {
  const meta = extractTransactionMetadata(tx);
  return meta.source === "wallet_card_topup" || meta.kind === "wallet_card_topup";
}

function isWalletCardRequestTxn(tx: any) {
  const meta = extractTransactionMetadata(tx);
  return meta.kind === "card_request_wallet" || meta.source === "wallet_card_request";
}

async function buildUserLookup(userIds: string[]) {
  const uniqueIds = Array.from(new Set(userIds.filter(Boolean)));
  if (!uniqueIds.length) return new Map<string, any>();
  if (isPrismaPersistenceEnabled()) {
    const users = await prisma.user.findMany({ where: { userId: { in: uniqueIds } } });
    return new Map(users.map((u) => [u.userId, u]));
  }
  const users = await User.find({ userId: { $in: uniqueIds } }).lean();
  return new Map(users.map((u) => [u.userId, u]));
}

function userDisplayName(user: any) {
  return [user?.firstName, user?.lastName].filter(Boolean).join(" ") || user?.username || user?.customerEmail || null;
}

router.get("/stats", requireAdmin, async (_req, res) => {
  try {
    const since = startOfUtcDay();
    const allUsersBalance = isPrismaPersistenceEnabled()
      ? await prisma.user.aggregate({ _sum: { balance: true } })
      : await User.aggregate([{ $group: { _id: null, balance: { $sum: "$balance" } } }]);
    const totalWalletBalances = Number(isPrismaPersistenceEnabled() ? (allUsersBalance as any)?._sum?.balance || 0 : (allUsersBalance as any)?.[0]?.balance || 0);
    const referralsTotal = await TelegramLink.countDocuments({ $and: [{ referrerUserId: { $exists: true } }, { referrerUserId: { $ne: null } }, { referrerUserId: { $ne: "" } }] });

    if (isPrismaPersistenceEnabled()) {
      const [usersTotal, cardHoldersRows, transactionsTotal, todayTxns, referralLinks] = await Promise.all([
        prisma.user.count(),
        prisma.card.findMany({
          where: {
            cardId: { not: "" },
            userId: { not: null },
          },
          select: { userId: true },
          distinct: ["userId"],
        }),
        prisma.transaction.count(),
        prisma.transaction.findMany({ where: { createdAt: { gte: since } }, take: 2000, orderBy: { createdAt: "desc" } }),
        Promise.resolve(referralsTotal),
      ]);
      const cardHolders = cardHoldersRows.filter((row) => Boolean(row.userId)).length;
      let totalP2pTransfersToday = 0;
      let totalBillsPaidToday = 0;
      let totalCardTopUpsToday = 0;
      let totalFeeRevenueToday = 0;
      for (const tx of todayTxns as any[]) {
        if (isP2pTransferTxn(tx)) totalP2pTransfersToday += 1;
        if (isBillPaymentTxn(tx) && String(tx?.status || "").toLowerCase() === "completed") totalBillsPaidToday += 1;
        if (isWalletCardTopupTxn(tx) && String(tx?.status || "").toLowerCase() === "completed") {
          totalCardTopUpsToday += 1;
          totalFeeRevenueToday += toFiniteNumber(tx?.feeUsdt ?? tx?.metadata?.feeUsd ?? 0);
        }
        if (isWalletCardRequestTxn(tx) && String(tx?.status || "").toLowerCase() === "completed") {
          totalFeeRevenueToday += toFiniteNumber(tx?.metadata?.feeUsd ?? tx?.feeUsdt ?? 0);
        }
      }
      return ok(res, {
        usersTotal,
        cardHolders,
        transactionsTotal,
        totalWalletBalances,
        totalP2pTransfersToday,
        totalBillsPaidToday,
        totalCardTopUpsToday,
        totalReferralsAllTime: referralLinks,
        totalFeeRevenueToday: Number(totalFeeRevenueToday.toFixed(2)),
      });
    }

    const [usersTotal, cardHolders, transactionsTotal, todayTxns] = await Promise.all([
      User.countDocuments({}),
      Card.distinct("userId", { cardId: { $exists: true, $ne: "" } }).then((ids) => ids.length),
      Transaction.countDocuments({}),
      Transaction.find({ createdAt: { $gte: since } }).sort({ createdAt: -1 }).limit(2000).lean(),
    ]);
    let totalP2pTransfersToday = 0;
    let totalBillsPaidToday = 0;
    let totalCardTopUpsToday = 0;
    let totalFeeRevenueToday = 0;
    for (const tx of todayTxns as any[]) {
      if (isP2pTransferTxn(tx)) totalP2pTransfersToday += 1;
      if (isBillPaymentTxn(tx) && String(tx?.status || "").toLowerCase() === "completed") totalBillsPaidToday += 1;
      if (isWalletCardTopupTxn(tx) && String(tx?.status || "").toLowerCase() === "completed") {
        totalCardTopUpsToday += 1;
        totalFeeRevenueToday += toFiniteNumber(tx?.feeUsdt ?? tx?.metadata?.feeUsd ?? 0);
      }
      if (isWalletCardRequestTxn(tx) && String(tx?.status || "").toLowerCase() === "completed") {
        totalFeeRevenueToday += toFiniteNumber(tx?.metadata?.feeUsd ?? tx?.feeUsdt ?? 0);
      }
    }
    return ok(res, {
      usersTotal,
      cardHolders,
      transactionsTotal,
      totalWalletBalances,
      totalP2pTransfersToday,
      totalBillsPaidToday,
      totalCardTopUpsToday,
      totalReferralsAllTime: referralsTotal,
      totalFeeRevenueToday: Number(totalFeeRevenueToday.toFixed(2)),
    });
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

router.get("/broadcast/targets", requireAdmin, async (req, res) => {
  try {
    const filter = BroadcastFilterSchema.parse(req.query.filter || "all");
    const targetCount = await getBroadcastTargetCount(filter);
    return ok(res, { targetCount, filter });
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

router.post("/broadcast/upload-image", requireAdmin, async (req, res) => {
  try {
    const body = BroadcastUploadSchema.parse(req.body || {});
    const isDataUrl = body.imageData.startsWith("data:image/");
    if (!isDataUrl) return fail(res, "imageData must be a data URL", 400);
    if (body.imageData.length > 11_000_000) return fail(res, "Image is too large", 400);

    ensureCloudinary();
    const uploaded = await cloudinary.uploader.upload(body.imageData, {
      folder: process.env.CLOUDINARY_FOLDER || "strowallet-broadcasts",
      resource_type: "image",
      public_id: body.fileName ? body.fileName.replace(/[^a-zA-Z0-9_-]/g, "_") : undefined,
    });
    return ok(res, { imageUrl: uploaded.secure_url });
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

router.post("/broadcast", requireAdmin, async (req, res) => {
  try {
    const body = BroadcastCreateSchema.parse(req.body || {});
    const job = await createBroadcastJob({
      createdBy: body.createdBy || "admin",
      messageText: body.messageText,
      imageUrl: body.imageUrl,
      targetFilter: body.targetFilter,
    });
    return ok(
      res,
      {
        id: String((job as any)._id),
        status: job.status,
        targetCount: job.targetCount,
        successCount: job.successCount,
        failureCount: job.failureCount,
        processedCount: job.processedCount,
      },
      201
    );
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

router.post("/usdt/recover", requireAdmin, async (req, res) => {
  try {
    const body = UsdtRecoverySchema.parse(req.body || {});
    const address = body.address.trim();
    const label = body.label || `user:${body.userId}`;
    const responseData = body.responseData ?? { recovered: true, address };

    if (isPrismaPersistenceEnabled()) {
      const saved = await prismaAny.usdtAddress.upsert({
        where: { address },
        create: {
          id: crypto.randomUUID(),
          userId: body.userId,
          address,
          label,
          network: "TRC20",
          status: "active",
          responseData,
        },
        update: {
          userId: body.userId,
          label,
          network: "TRC20",
          status: "active",
          responseData,
        },
      });
      return ok(res, { address: saved }, 200);
    }

    const UsdtAddress = require("../models/UsdtAddress").default as any;
    const saved = await UsdtAddress.findOneAndUpdate(
      { address },
      {
        $set: {
          userId: body.userId,
          label,
          network: "TRC20",
          status: "active",
          responseData,
        },
      },
      { upsert: true, new: true }
    );
    return ok(res, { address: saved }, 200);
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

router.post("/usdt/bind-address", requireAdmin, async (req, res) => {
  try {
    const body = UsdtBindAddressSchema.parse(req.body || {});
    const userId = body.userId.trim();
    const label = `user:${userId}`;
    const rowsToBind = [
      { network: "TRC20" as const, address: body.trc20?.trim() || "" },
      { network: "BEP20" as const, address: body.bep20?.trim() || "" },
      { network: "POLYGON" as const, address: body.polygon?.trim() || "" },
    ].filter((item) => Boolean(item.address));

    const saved: any[] = [];
    const nowIso = new Date().toISOString();
    const providedToken = req.headers["x-admin-token"] as string | undefined;

    if (isPrismaPersistenceEnabled()) {
      for (const row of rowsToBind) {
        const responseData = {
          source: "admin_bind",
          at: nowIso,
          network: row.network,
          userId,
        };
        const bound = await upsertUsdtByUserNetworkPrisma({
          userId,
          network: row.network,
          address: row.address,
          label,
          responseData,
        });
        if (bound) saved.push(bound);
      }
    } else {
      const UsdtAddress = require("../models/UsdtAddress").default as any;
      for (const row of rowsToBind) {
        const responseData = {
          source: "admin_bind",
          at: nowIso,
          network: row.network,
          userId,
        };
        let bound: any;
        try {
          bound = await UsdtAddress.findOneAndUpdate(
            { userId, network: row.network },
            {
              $set: {
                userId,
                address: row.address,
                label,
                network: row.network,
                status: "active",
                responseData,
              },
            },
            { upsert: true, new: true }
          );
        } catch {
          bound = await UsdtAddress.findOneAndUpdate(
            { address: row.address },
            {
              $set: {
                userId,
                label,
                network: row.network,
                status: "active",
                responseData,
              },
            },
            { upsert: true, new: true }
          );
        }
        if (bound) saved.push(bound);
      }
    }

    console.log("[admin] usdt bind-address", {
      userId,
      networks: rowsToBind.map((row) => row.network),
      token: tokenFingerprint(providedToken),
      at: nowIso,
    });

    return ok(res, {
      userId,
      bound: saved,
      count: saved.length,
      message: "USDT addresses bound successfully",
    }, 200);
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

router.post("/usdt/reset-addresses", requireAdmin, async (req, res) => {
  try {
    const body = UsdtResetAddressSchema.parse(req.body || {});
    const userId = body.userId.trim();
    const networks = Array.isArray(body.networks) ? body.networks : [];
    const nowIso = new Date().toISOString();
    const providedToken = req.headers["x-admin-token"] as string | undefined;

    let deleted = 0;

    if (isPrismaPersistenceEnabled()) {
      if (networks.length) {
        for (const network of networks) {
          const rows = await prismaAny.$queryRawUnsafe(
            `DELETE FROM "UsdtAddress"
             WHERE "userId" = $1
               AND UPPER(COALESCE("network", 'TRC20')) = $2
             RETURNING "id"`,
            userId,
            network
          );
          deleted += Array.isArray(rows) ? rows.length : 0;
        }
      } else {
        const rows = await prismaAny.$queryRawUnsafe(
          `DELETE FROM "UsdtAddress"
           WHERE "userId" = $1
           RETURNING "id"`,
          userId
        );
        deleted += Array.isArray(rows) ? rows.length : 0;
      }
    } else {
      const UsdtAddress = require("../models/UsdtAddress").default as any;
      const filter: any = { userId };
      if (networks.length) filter.network = { $in: networks };
      const result = await UsdtAddress.deleteMany(filter);
      deleted = Number(result?.deletedCount || 0);
    }

    console.log("[admin] usdt reset-addresses", {
      userId,
      networks: networks.length ? networks : "all",
      deleted,
      token: tokenFingerprint(providedToken),
      at: nowIso,
    });

    const deletedAny = deleted > 0;

    return ok(res, {
      userId,
      networks: networks.length ? networks : ["TRC20", "BEP20", "POLYGON"],
      deleted,
      status: deletedAny ? "reset" : "noop",
      message: deletedAny
        ? "USDT addresses reset successfully"
        : "No local USDT addresses found for this user. If provider reports existing addresses, use Bind USDT Addresses.",
    }, 200);
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

router.get("/broadcast", requireAdmin, async (req, res) => {
  try {
    const limitRaw = Number(req.query.limit || 20);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 && limitRaw <= 100 ? limitRaw : 20;
    const items = await listBroadcastJobs(limit);
    return ok(res, {
      items: items.map((j: any) => ({
        id: String(j._id),
        createdBy: j.createdBy,
        status: j.status,
        targetFilter: j.targetFilter,
        targetCount: j.targetCount,
        processedCount: j.processedCount,
        successCount: j.successCount,
        failureCount: j.failureCount,
        createdAt: j.createdAt,
        startedAt: j.startedAt,
        completedAt: j.completedAt,
      })),
    });
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

router.get("/broadcast/:id", requireAdmin, async (req, res) => {
  try {
    const id = String(req.params.id);
    const job = await getBroadcastJobById(id);
    if (!job) return fail(res, "Broadcast not found", 404);
    return ok(res, {
      id: String((job as any)._id),
      status: job.status,
      targetFilter: job.targetFilter,
      targetCount: job.targetCount,
      processedCount: job.processedCount,
      successCount: job.successCount,
      failureCount: job.failureCount,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      lastError: job.lastError,
    });
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

router.get("/users/:telegramUserId/telegram-link", requireAdmin, async (req, res) => {
  try {
    const telegramUserId = String(req.params.telegramUserId || "").trim();
    if (!telegramUserId) return fail(res, "telegramUserId is required", 400);

    const user = await User.findOne({ userId: telegramUserId })
      .select({ userId: 1, username: 1, chatId: 1, firstName: 1, lastName: 1, customerEmail: 1 })
      .lean();

    const chatIdRaw = user?.chatId || telegramUserId;
    const chatIdNum = Number(chatIdRaw);
    const chatId = Number.isFinite(chatIdNum) ? chatIdNum : null;

    const link = chatId != null ? await TelegramLink.findOne({ chatId }).lean() : null;

    const usernameRaw = user?.username ? String(user.username).trim() : "";
    const username = usernameRaw ? usernameRaw.replace(/^@+/, "") : null;
    const deepLink = chatId != null ? `tg://user?id=${chatId}` : null;
    const webLink = username ? `https://t.me/${username}` : null;

    return ok(res, {
      userId: telegramUserId,
      chatId,
      username,
      name: [user?.firstName, user?.lastName].filter(Boolean).join(" ") || null,
      customerEmail: user?.customerEmail || link?.customerEmail || null,
      linkedCardIds: link?.cardIds || [],
      deepLink,
      webLink,
    });
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

router.post("/cards/link", requireAdmin, async (req, res) => {
  try {
    const body = CardLinkSchema.parse(req.body || {});
    const cardId = body.cardId.trim();
    let userId = body.userId?.trim();
    let customerEmail = body.customerEmail?.trim();

    if (isPrismaPersistenceEnabled()) {
      if (userId) {
        const prismaUser = await prisma.user.findUnique({ where: { userId } });
        if (!prismaUser) return fail(res, "User not found for provided telegram userId", 404);
        customerEmail = customerEmail || prismaUser.customerEmail || undefined;
      } else if (customerEmail) {
        const prismaUser = await prisma.user.findFirst({ where: { customerEmail } });
        if (prismaUser?.userId) userId = prismaUser.userId;
      }
    } else {
      if (!userId && customerEmail) {
        const customer = await Customer.findOne({ email: customerEmail }).lean();
        if (customer?.userId) userId = customer.userId;
      }
      if (!userId && customerEmail) {
        const user = await User.findOne({ customerEmail }).lean();
        if (user?.userId) userId = user.userId;
      }
      if (userId && !customerEmail) {
        const customer = await Customer.findOne({ userId }).lean();
        customerEmail = customer?.email;
        if (!customerEmail) {
          const user = await User.findOne({ userId }).lean();
          customerEmail = user?.customerEmail;
        }
      }
    }

    const detail = await fetchCardDetail(cardId, normalizeMode(getDefaultMode())).catch(() => null);
    const providedCardNumber = body.cardNumber?.trim();
    const last4 =
      body.last4 ||
      (providedCardNumber ? providedCardNumber.slice(-4) : undefined) ||
      extractField(detail, ["last4", "card_last4", "cardLast4", "cardSuffix"]) ||
      (extractField(detail, ["card_number", "cardNumber"]) || "").slice(-4) ||
      undefined;

    const cardUpdate: any = {
      cardId,
      userId: userId || undefined,
      customerEmail: customerEmail || undefined,
      nameOnCard: body.nameOnCard || extractField(detail, ["name_on_card", "nameOnCard", "name"]),
      cardType: body.cardType || extractField(detail, ["card_type", "cardType", "brand"]),
      status: body.status || extractField(detail, ["card_status", "status", "state"]) || "active",
      last4,
      currency: body.currency || extractField(detail, ["currency", "ccy"]),
      balance: body.balance || extractField(detail, ["balance", "available_balance", "availableBalance"]),
      availableBalance: extractField(detail, ["available_balance", "availableBalance"]),
      lastSync: new Date(),
    };

    if (isPrismaPersistenceEnabled()) {
      await prisma.card.upsert({
        where: { cardId },
        create: {
          cardId,
          userId: userId || null,
          customerEmail: customerEmail || null,
          nameOnCard: cardUpdate.nameOnCard || null,
          cardType: cardUpdate.cardType || null,
          status: cardUpdate.status || null,
          last4: cardUpdate.last4 || null,
          currency: cardUpdate.currency || null,
          balance: cardUpdate.balance || null,
          availableBalance: cardUpdate.availableBalance || null,
          lastSync: cardUpdate.lastSync || new Date(),
        },
        update: {
          userId: userId || null,
          customerEmail: customerEmail || null,
          nameOnCard: cardUpdate.nameOnCard || undefined,
          cardType: cardUpdate.cardType || undefined,
          status: cardUpdate.status || undefined,
          last4: cardUpdate.last4 || undefined,
          currency: cardUpdate.currency || undefined,
          balance: cardUpdate.balance || undefined,
          availableBalance: cardUpdate.availableBalance || undefined,
          lastSync: cardUpdate.lastSync || new Date(),
        },
      });
    } else {
      await Card.findOneAndUpdate({ cardId }, { $set: cardUpdate }, { upsert: true, new: true });
    }

    if (!isPrismaPersistenceEnabled() && userId) {
      const chatId = Number(userId);
      if (Number.isFinite(chatId)) {
        await TelegramLink.findOneAndUpdate(
          { chatId },
          { $addToSet: { cardIds: cardId }, ...(customerEmail ? { $set: { customerEmail } } : {}) },
          { upsert: true }
        );
      }
    }

    if (!isPrismaPersistenceEnabled() && customerEmail) {
      await TelegramLink.findOneAndUpdate(
        { customerEmail },
        { $addToSet: { cardIds: cardId } },
        { upsert: true }
      );
    }

    if (userId || customerEmail) {
      if (isPrismaPersistenceEnabled()) {
        const where: any = {
          status: { in: ["pending", "approved"] },
          OR: [
            ...(userId ? [{ userId }] : []),
            ...(customerEmail ? [{ customerEmail }] : []),
          ],
        };
        const latestRequest = await prisma.cardRequest.findFirst({
          where,
          orderBy: { updatedAt: "desc" },
        });
        if (latestRequest) {
          await prisma.cardRequest.update({
            where: { id: latestRequest.id },
            data: {
              cardId,
              status: "approved",
              ...(providedCardNumber ? { cardNumber: providedCardNumber } : {}),
              ...(body.cvc ? { cvc: body.cvc } : {}),
              ...(body.expiry
                ? { metadata: { ...((latestRequest.metadata as any) || {}), expiry: body.expiry } }
                : {}),
            },
          });
        }
      } else {
        await CardRequest.findOneAndUpdate(
          {
            $or: [
              ...(userId ? [{ userId }] : []),
              ...(customerEmail ? [{ customerEmail }] : []),
            ],
          },
          {
            $set: {
              cardId,
              status: "approved",
              ...(providedCardNumber ? { cardNumber: providedCardNumber } : {}),
              ...(body.cvc ? { cvc: body.cvc } : {}),
              ...(body.expiry ? { "metadata.expiry": body.expiry } : {}),
            },
          },
          { new: true, upsert: true }
        );
      }
    }

    if (userId) {
      await notifyCardLinkedToUser(userId, {
        cardId,
        cardType: cardUpdate.cardType,
        nameOnCard: cardUpdate.nameOnCard,
        last4: cardUpdate.last4,
      }).catch((err) => {
        console.warn("[admin] failed to send linked-card notification", {
          userId,
          cardId,
          error: (err as any)?.message || String(err),
        });
      });
    }

    return ok(res, { cardId, userId, customerEmail, linked: true });
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

const CardSearchSchema = z.object({
  search: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

router.get("/cards", requireAdmin, async (req, res) => {
  try {
    const { search, limit } = CardSearchSchema.parse(req.query || {});
    const q = search?.trim();

    if (isPrismaPersistenceEnabled()) {
      const where: any = {};
      if (q) {
        const isNumeric = /^\d+$/.test(q);
        where.OR = [
          ...(isNumeric ? [{ userId: q }] : []),
          { customerEmail: q },
          { cardId: q },
        ];
      }

      const items = await prisma.card.findMany({
        where,
        orderBy: { updatedAt: "desc" },
        take: limit || 100,
      });

      const userIds = Array.from(new Set(items.map((c) => c.userId).filter(Boolean))) as string[];
      const users = userIds.length ? await prisma.user.findMany({ where: { userId: { in: userIds } } }) : [];
      const userMap = new Map(users.map((u) => [u.userId, u]));

      return ok(res, {
        cards: items.map((c) => ({
          cardId: c.cardId,
          userId: c.userId,
          userName: c.userId
            ? [userMap.get(c.userId)?.firstName, userMap.get(c.userId)?.lastName].filter(Boolean).join(" ") || undefined
            : undefined,
          customerEmail: c.customerEmail,
          email: c.customerEmail,
          nameOnCard: c.nameOnCard,
          cardType: c.cardType,
          status: c.status,
          last4: c.last4,
          currency: c.currency,
          balance: c.balance != null && !Number.isNaN(Number(c.balance)) ? Number(c.balance) : c.balance,
          availableBalance: c.availableBalance,
          createdAt: c.createdAt,
          updatedAt: c.updatedAt,
        })),
      });
    }

    const query: any = {};
    if (q) {
      const isNumeric = /^\d+$/.test(q);
      query.$or = [
        ...(isNumeric ? [{ userId: q }] : []),
        { customerEmail: q },
        { cardId: q },
      ];
    }
    const items = await Card.find(query)
      .sort({ updatedAt: -1 })
      .limit(limit || 100)
      .lean();

    const userIds = Array.from(new Set(items.map((c) => c.userId).filter(Boolean)));
    const users = await User.find({ userId: { $in: userIds } }).lean();
    const userMap = new Map(users.map((u) => [u.userId, u]));

    return ok(res, {
      cards: items.map((c) => ({
        cardId: c.cardId,
        userId: c.userId,
        userName: c.userId ? [userMap.get(c.userId)?.firstName, userMap.get(c.userId)?.lastName].filter(Boolean).join(" ") || undefined : undefined,
        customerEmail: c.customerEmail,
        email: c.customerEmail,
        nameOnCard: c.nameOnCard,
        cardType: c.cardType,
        status: c.status,
        last4: c.last4,
        currency: c.currency,
        balance: c.balance != null && !Number.isNaN(Number(c.balance)) ? Number(c.balance) : c.balance,
        availableBalance: c.availableBalance,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      })),
    });
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

router.post("/cards/:cardId/refresh", requireAdmin, async (req, res) => {
  try {
    const cardId = String(req.params.cardId);
    const mode = typeof req.body?.mode === "string" ? req.body.mode : undefined;
    const detail = await fetchCardDetail(cardId, mode);
    const data = detail?.data ?? detail;
    if (isPrismaPersistenceEnabled()) {
      await prisma.card.upsert({
        where: { cardId },
        create: {
          cardId,
          nameOnCard: data?.name_on_card || data?.name || null,
          cardType: data?.card_type || data?.brand || null,
          status: data?.status || data?.state || null,
          last4: data?.last4 || data?.card_last4 || data?.cardLast4 || null,
          currency: data?.currency || data?.ccy || null,
          balance: data?.balance || data?.available_balance || null,
          availableBalance: data?.available_balance || null,
          lastSync: new Date(),
        },
        update: {
          nameOnCard: data?.name_on_card || data?.name || undefined,
          cardType: data?.card_type || data?.brand || undefined,
          status: data?.status || data?.state || undefined,
          last4: data?.last4 || data?.card_last4 || data?.cardLast4 || undefined,
          currency: data?.currency || data?.ccy || undefined,
          balance: data?.balance || data?.available_balance || undefined,
          availableBalance: data?.available_balance || undefined,
          lastSync: new Date(),
        },
      });
    } else {
      await Card.findOneAndUpdate(
        { cardId },
        {
          $set: {
            nameOnCard: data?.name_on_card || data?.name,
            cardType: data?.card_type || data?.brand,
            status: data?.status || data?.state,
            last4: data?.last4 || data?.card_last4 || data?.cardLast4,
            currency: data?.currency || data?.ccy,
            balance: data?.balance || data?.available_balance,
            availableBalance: data?.available_balance,
            lastSync: new Date(),
          },
        },
        { upsert: true, new: true }
      );
    }
    return ok(res, { detail: data });
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

router.post("/cards/:cardId/action", requireAdmin, async (req, res) => {
  try {
    const cardId = String(req.params.cardId);
    const action = req.body?.action === "freeze" ? "freeze" : "unfreeze";
    const card = isPrismaPersistenceEnabled()
      ? await prisma.card.findUnique({ where: { cardId } })
      : await Card.findOne({ cardId });
    if (!card) return fail(res, "Card not found", 404);
    const currentStatus = String(card.status || "").toLowerCase();
    if (action === "freeze" && currentStatus === "frozen") {
      return fail(res, "Card already frozen", 400);
    }
    if (action === "unfreeze" && currentStatus === "active") {
      return fail(res, "Card already active", 400);
    }
    const result = await actionCard(cardId, action);
    const nextStatus = action === "freeze" ? "frozen" : "active";
    if (isPrismaPersistenceEnabled()) {
      await prisma.card.update({
        where: { cardId },
        data: { status: nextStatus, lastSync: new Date() },
      });
    } else {
      await Card.findOneAndUpdate(
        { cardId },
        { $set: { status: nextStatus, lastSync: new Date() } },
        { new: true }
      );
    }
    await notifyCardStatusChanged(cardId, nextStatus);
    return ok(res, { result });
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

router.post("/cards/:cardId/reactivate", requireAdmin, async (req, res) => {
  try {
    const cardId = String(req.params.cardId);
    const card = isPrismaPersistenceEnabled()
      ? await prisma.card.findUnique({ where: { cardId } })
      : await Card.findOne({ cardId });
    if (!card) return fail(res, "Card not found", 404);

    const currentStatus = String(card.status || "").toLowerCase();
    if (currentStatus !== "terminated" && currentStatus !== "inactive" && currentStatus !== "closed") {
      return fail(res, "Only terminated cards can be reactivated", 400);
    }

    const result = await actionCard(cardId, "unfreeze");
    const nextStatus = "active";

    if (isPrismaPersistenceEnabled()) {
      await prisma.card.update({ where: { cardId }, data: { status: nextStatus, lastSync: new Date() } });
    } else {
      await Card.findOneAndUpdate({ cardId }, { $set: { status: nextStatus, lastSync: new Date() } }, { new: true });
    }

    await notifyCardStatusChanged(cardId, nextStatus);
    return ok(res, { result, status: nextStatus });
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

router.post("/transfers/:reference/reverse", requireAdmin, async (req, res) => {
  try {
    const reference = String(req.params.reference || "").trim();
    if (!reference) return fail(res, "Reference is required", 400);

    if (isPrismaPersistenceEnabled()) {
      const original = await prisma.transaction.findFirst({
        where: {
          OR: [
            { transactionNumber: reference },
            { referenceNumber: reference },
          ],
          metadata: {
            path: ["kind"],
            equals: "p2p_transfer",
          },
        } as any,
        orderBy: { createdAt: "desc" },
      });
      if (!original) return fail(res, "Transfer not found", 404);
      const meta = extractTransactionMetadata(original as any);
      const amount = toFiniteNumber((original as any)?.amountUsdt ?? (original as any)?.amount ?? 0);
      const senderUserId = String((original as any)?.userId || "");
      const receiverUserId = meta.recipientUserId || "";
      if (!senderUserId || !receiverUserId) return fail(res, "Transfer metadata is incomplete", 400);
      const sender = await prisma.user.findUnique({ where: { userId: senderUserId } });
      const receiver = await prisma.user.findUnique({ where: { userId: receiverUserId } });
      if (!sender || !receiver) return fail(res, "Sender or receiver not found", 404);

      await prisma.$transaction(async (tx: any) => {
        await tx.user.update({ where: { userId: senderUserId }, data: { balance: { increment: amount } } });
        await tx.user.update({ where: { userId: receiverUserId }, data: { balance: { decrement: amount } } });
        await tx.transaction.create({
          data: {
            userId: senderUserId,
            transactionType: "deposit",
            paymentMethod: "system",
            amount,
            amountUsdt: amount,
            currency: "USDT",
            transactionNumber: `${reference}-REV-S`,
            referenceNumber: `${reference}-REV`,
            status: "completed",
            verified: true,
            metadata: { kind: "p2p_transfer_reversal", direction: "credit", originalReference: reference, receiverUserId },
          },
        });
        await tx.transaction.create({
          data: {
            userId: receiverUserId,
            transactionType: "withdrawal",
            paymentMethod: "system",
            amount,
            amountUsdt: amount,
            currency: "USDT",
            transactionNumber: `${reference}-REV-R`,
            referenceNumber: `${reference}-REV`,
            status: "completed",
            verified: true,
            metadata: { kind: "p2p_transfer_reversal", direction: "debit", originalReference: reference, senderUserId },
          },
        });
        await tx.transaction.updateMany({
          where: { OR: [{ transactionNumber: reference }, { referenceNumber: reference }] },
          data: { metadata: { ...(original as any).metadata, reversedAt: new Date(), reversedBy: "admin" } },
        });
      });
      return ok(res, { reversed: true, reference, amount });
    }

    const original = await Transaction.findOne({
      $or: [{ transactionNumber: reference }, { referenceNumber: reference }],
      transactionType: "withdrawal",
      "metadata.kind": "p2p_transfer",
    }).lean();
    if (!original) return fail(res, "Transfer not found", 404);
    const meta = extractTransactionMetadata(original as any);
    const amount = toFiniteNumber((original as any)?.amountUsdt ?? (original as any)?.amount ?? 0);
    const senderUserId = String((original as any)?.userId || "");
    const receiverUserId = meta.recipientUserId || "";
    if (!senderUserId || !receiverUserId) return fail(res, "Transfer metadata is incomplete", 400);
    const sender = await User.findOne({ userId: senderUserId }).lean();
    const receiver = await User.findOne({ userId: receiverUserId }).lean();
    if (!sender || !receiver) return fail(res, "Sender or receiver not found", 404);

    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      await User.updateOne({ userId: senderUserId }, { $inc: { balance: amount } }, { session });
      await User.updateOne({ userId: receiverUserId }, { $inc: { balance: -amount } }, { session });
      await Transaction.create([
        {
          userId: senderUserId,
          transactionType: "deposit",
          paymentMethod: "system",
          amount,
          amountUsdt: amount,
          currency: "USDT",
          transactionNumber: `${reference}-REV-S`,
          referenceNumber: `${reference}-REV`,
          status: "completed",
          verified: true,
          metadata: { kind: "p2p_transfer_reversal", direction: "credit", originalReference: reference, receiverUserId },
        },
        {
          userId: receiverUserId,
          transactionType: "withdrawal",
          paymentMethod: "system",
          amount,
          amountUsdt: amount,
          currency: "USDT",
          transactionNumber: `${reference}-REV-R`,
          referenceNumber: `${reference}-REV`,
          status: "completed",
          verified: true,
          metadata: { kind: "p2p_transfer_reversal", direction: "debit", originalReference: reference, senderUserId },
        },
      ], { session });
      await Transaction.updateMany(
        { $or: [{ transactionNumber: reference }, { referenceNumber: reference }] },
        { $set: { metadata: { ...(original as any).metadata, reversedAt: new Date(), reversedBy: "admin" } } },
        { session }
      );
      await session.commitTransaction();
      session.endSession();
      return ok(res, { reversed: true, reference, amount });
    } catch (err) {
      try { await session.abortTransaction(); } catch {}
      session.endSession();
      throw err;
    }
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

router.post("/cards/:cardId/fund", requireAdmin, async (_req, res) => {
  return fail(res, "Admin funding is disabled. StroWallet is the source of truth.", 405);
});

router.get("/cards/:cardId/transactions", requireAdmin, async (req, res) => {
  try {
    const cardId = String(req.params.cardId);
    const mode = typeof req.query.mode === "string" ? req.query.mode : undefined;
    const history = String(req.query.history || "recent");
    if (history === "full") {
      const page = Number(req.query.page || 1);
      const take = Number(req.query.take || 50);
      const data = await fetchCardHistory(cardId, page, take);
      return ok(res, { data });
    }
    const data = await fetchCardTransactions(cardId, mode);
    return ok(res, { data });
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

// Local card transactions (webhook-synced)
router.get("/transactions", requireAdmin, async (req, res) => {
  try {
    const { userId, cardId, limit } = TransactionQuerySchema.parse(req.query || {});

    if (isPrismaPersistenceEnabled()) {
      const take = limit || 50;
      const rows = await prisma.transaction.findMany({
        where: {
          transactionType: "card",
          ...(userId ? { userId } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: cardId ? Math.max(take * 5, 200) : take,
      });

      const filtered = cardId
        ? rows.filter((t) => String((t.metadata as any)?.cardId || "") === cardId).slice(0, take)
        : rows;

      let declineFeeCount = 0;
      const transactions = filtered.map((t) => {
        const isDeclineFee = isDeclineFeeTransaction(t);
        if (isDeclineFee) declineFeeCount += 1;
        return {
          id: t.id,
          userId: t.userId,
          cardId: (t.metadata as any)?.cardId,
          amount: t.amount,
          currency: t.currency,
          direction: (t.metadata as any)?.direction,
          description: (t.metadata as any)?.description,
          status: t.status,
          createdAt: t.createdAt,
          isDeclineFee,
          warningTags: isDeclineFee ? ["DECLINE_FEE"] : [],
        };
      });

      return ok(res, { transactions, declineFeeCount });
    }

    const query: any = { transactionType: "card" };
    if (userId) query.userId = userId;
    if (cardId) query["metadata.cardId"] = cardId;

    const items = await Transaction.find(query)
      .sort({ createdAt: -1 })
      .limit(limit || 50)
      .lean();

    let declineFeeCount = 0;
    const transactions = items.map((t) => {
      const isDeclineFee = isDeclineFeeTransaction(t);
      if (isDeclineFee) declineFeeCount += 1;
      return {
        id: t._id,
        userId: t.userId,
        cardId: t.metadata?.cardId,
        amount: t.amount,
        currency: t.currency,
        direction: t.metadata?.direction,
        description: t.metadata?.description,
        status: t.status,
        createdAt: t.createdAt,
        isDeclineFee,
        warningTags: isDeclineFee ? ["DECLINE_FEE"] : [],
      };
    });

    return ok(res, { transactions, declineFeeCount });
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

const AdminReportQuerySchema = z.object({
  userId: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  format: z.enum(["json", "csv"]).optional(),
  search: z.string().optional(),
});

const WalletAdjustSchema = z.object({
  userId: z.string().min(1),
  amountUsdt: z.number().positive(),
  reason: z.string().min(1).max(500),
  action: z.enum(["credit", "debit"]),
});

function toDateOrUndefined(value?: string) {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

async function fetchWalletBalanceSummary(userId: string) {
  const since = startOfUtcDay();
  if (isPrismaPersistenceEnabled()) {
    const user = await prisma.user.findUnique({ where: { userId } });
    if (!user) return null;
    const txns = await prisma.transaction.findMany({
      where: { userId, createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      take: 500,
    });
    let totalDeposited = 0;
    let totalTransferredOut = 0;
    let totalTopUpsToCard = 0;
    let lastDeposit: Date | null = null;
    let lastActivity: Date | null = null;
    for (const tx of txns as any[]) {
      const createdAt = tx?.createdAt ? new Date(tx.createdAt) : null;
      if (createdAt && (!lastActivity || createdAt > lastActivity)) lastActivity = createdAt;
      const status = String(tx?.status || "").toLowerCase();
      if (status === "completed" && ["deposit", "manual_deposit"].includes(String(tx?.transactionType || ""))) {
        totalDeposited += toFiniteNumber(tx?.amountUsdt ?? tx?.amount ?? 0);
        if (createdAt && (!lastDeposit || createdAt > lastDeposit)) lastDeposit = createdAt;
      }
      if (status === "completed" && isP2pTransferTxn(tx)) {
        totalTransferredOut += toFiniteNumber(tx?.amountUsdt ?? tx?.amount ?? 0);
      }
      if (status === "completed" && isWalletCardTopupTxn(tx)) {
        totalTopUpsToCard += toFiniteNumber(tx?.metadata?.topupAmountUsd ?? tx?.amountUsdt ?? tx?.amount ?? 0);
      }
    }
    return {
      userId,
      username: user.username || null,
      phoneNumber: user.phoneNumber || null,
      balance: Number(user.balance ?? 0),
      currency: user.currency || "USDT",
      lastDeposit: lastDeposit,
      lastActivity: lastActivity,
      totalDeposited: Number(totalDeposited.toFixed(2)),
      totalTransferredOut: Number(totalTransferredOut.toFixed(2)),
      totalTopUpsToCard: Number(totalTopUpsToCard.toFixed(2)),
    };
  }

  const user = await User.findOne({ userId }).lean();
  if (!user) return null;
  const txns = await Transaction.find({ userId, createdAt: { $gte: since } }).sort({ createdAt: -1 }).limit(500).lean();
  let totalDeposited = 0;
  let totalTransferredOut = 0;
  let totalTopUpsToCard = 0;
  let lastDeposit: Date | null = null;
  let lastActivity: Date | null = null;
  for (const tx of txns as any[]) {
    const createdAt = tx?.createdAt ? new Date(tx.createdAt) : null;
    if (createdAt && (!lastActivity || createdAt > lastActivity)) lastActivity = createdAt;
    const status = String(tx?.status || "").toLowerCase();
    if (status === "completed" && ["deposit", "manual_deposit"].includes(String(tx?.transactionType || ""))) {
      totalDeposited += toFiniteNumber(tx?.amountUsdt ?? tx?.amount ?? 0);
      if (createdAt && (!lastDeposit || createdAt > lastDeposit)) lastDeposit = createdAt;
    }
    if (status === "completed" && isP2pTransferTxn(tx)) {
      totalTransferredOut += toFiniteNumber(tx?.amountUsdt ?? tx?.amount ?? 0);
    }
    if (status === "completed" && isWalletCardTopupTxn(tx)) {
      totalTopUpsToCard += toFiniteNumber(tx?.metadata?.topupAmountUsd ?? tx?.amountUsdt ?? tx?.amount ?? 0);
    }
  }
  return {
    userId,
    username: user.username || null,
    phoneNumber: user.phoneNumber || null,
    balance: Number(user.balance ?? 0),
    currency: user.currency || "USDT",
    lastDeposit,
    lastActivity,
    totalDeposited: Number(totalDeposited.toFixed(2)),
    totalTransferredOut: Number(totalTransferredOut.toFixed(2)),
    totalTopUpsToCard: Number(totalTopUpsToCard.toFixed(2)),
  };
}

router.get("/wallet/balances", requireAdmin, async (req, res) => {
  try {
    const query = AdminReportQuerySchema.parse(req.query || {});
    const search = String(query.search || "").trim();
    const limit = query.limit || 20;
    const where = search
      ? isPrismaPersistenceEnabled()
        ? {
            OR: [
              { userId: search },
              { phoneNumber: search },
              { username: search },
              { customerEmail: search },
            ],
          }
        : {
            $or: [
              { userId: search },
              { phoneNumber: search },
              { username: search },
              { customerEmail: search },
            ],
          }
      : undefined;

    const users = isPrismaPersistenceEnabled()
      ? await prisma.user.findMany({ where, orderBy: { updatedAt: "desc" }, take: limit })
      : await User.find(where || {}).sort({ updatedAt: -1 }).limit(limit).lean();
    const userIds = users.map((u: any) => String(u.userId));
    const summaries = [] as any[];
    for (const userId of userIds) {
      const summary = await fetchWalletBalanceSummary(userId);
      if (summary) summaries.push(summary);
    }
    return ok(res, { items: summaries });
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

router.post("/wallet/balances/adjust", requireAdmin, async (req, res) => {
  try {
    const body = WalletAdjustSchema.parse(req.body || {});
    const amount = toFiniteNumber(body.amountUsdt, 0);
    if (amount <= 0) return fail(res, "Amount must be greater than 0", 400);
    const now = new Date();
    const txType = body.action === "credit" ? "manual_deposit" : "withdrawal";
    const delta = body.action === "credit" ? amount : -amount;
    const reference = `ADMIN-${body.action.toUpperCase()}-${Date.now()}`;

    if (isPrismaPersistenceEnabled()) {
      const result = await prisma.$transaction(async (tx: any) => {
        const user = await tx.user.findUnique({ where: { userId: body.userId } });
        if (!user) throw new Error("User not found");
        if (body.action === "debit" && Number(user.balance ?? 0) < amount) {
          throw new Error("Insufficient wallet balance");
        }
        const updated = body.action === "credit"
          ? await tx.user.update({ where: { userId: body.userId }, data: { balance: { increment: amount } } })
          : await tx.user.update({ where: { userId: body.userId }, data: { balance: { decrement: amount } } });
        await tx.transaction.create({
          data: {
            userId: body.userId,
            transactionType: txType,
            paymentMethod: "system",
            amount: amount,
            amountUsdt: amount,
            currency: "USDT",
            transactionNumber: reference,
            referenceNumber: reference,
            status: "completed",
            verified: true,
            metadata: {
              kind: "wallet_adjustment",
              action: body.action,
              reason: body.reason,
              archivedBy: "admin_wallet_adjustment",
              adjustedAt: now,
            },
          },
        });
        await RuntimeAudit.create({
          key: `wallet_adjust_${body.userId}`,
          oldValue: null,
          newValue: { action: body.action, amount, reason: body.reason, reference },
        }).catch(() => {});
        return { balance: Number(updated.balance ?? 0) };
      });
      return ok(res, { userId: body.userId, balance: result.balance, reference });
    }

    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const user = await User.findOne({ userId: body.userId }).session(session);
      if (!user) throw new Error("User not found");
      if (body.action === "debit" && Number(user.balance ?? 0) < amount) {
        throw new Error("Insufficient wallet balance");
      }
      const updated = await User.findOneAndUpdate(
        { userId: body.userId },
        body.action === "credit" ? { $inc: { balance: amount } } : { $inc: { balance: -amount } },
        { new: true, session }
      ).lean();
      await Transaction.create([
        {
          userId: body.userId,
          transactionType: txType,
          paymentMethod: "system",
          amount,
          amountUsdt: amount,
          currency: "USDT",
          transactionNumber: reference,
          referenceNumber: reference,
          status: "completed",
          verified: true,
          metadata: { kind: "wallet_adjustment", action: body.action, reason: body.reason, adjustedAt: now },
        },
      ], { session });
      await RuntimeAudit.create([{ key: `wallet_adjust_${body.userId}`, oldValue: null, newValue: { action: body.action, amount, reason: body.reason, reference } }], { session }).catch(() => {});
      await session.commitTransaction();
      session.endSession();
      return ok(res, { userId: body.userId, balance: Number(updated?.balance ?? 0), reference });
    } catch (err) {
      try { await session.abortTransaction(); } catch {}
      session.endSession();
      throw err;
    }
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

function maybeCsv(res: express.Response, filename: string, header: string[], rows: any[][], asCsv = false) {
  if (!asCsv) return null;
  const csv = [header.join(","), ...rows.map((row) => row.map(csvEscape).join(","))].join("\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename=${filename}`);
  res.status(200).send(csv);
  return true;
}

router.get("/reports/card-topups", requireAdmin, async (req, res) => {
  try {
    const query = AdminReportQuerySchema.parse(req.query || {});
    const since = toDateOrUndefined(query.from) || startOfUtcDay();
    const until = toDateOrUndefined(query.to);
    const limit = query.limit || 100;
    const formatCsv = query.format === "csv";

    const txFilter: any = {
      createdAt: until ? { gte: since, lte: until } : { gte: since },
    };
    const txs = isPrismaPersistenceEnabled()
      ? await prisma.transaction.findMany({ where: txFilter, orderBy: { createdAt: "desc" }, take: limit * 5 })
      : await Transaction.find(txFilter).sort({ createdAt: -1 }).limit(limit * 5).lean();
    const rows = (txs as any[])
      .filter(isWalletCardTopupTxn)
      .filter((tx) => !query.userId || String(tx.userId) === String(query.userId))
      .slice(0, limit)
      .map((tx) => ({
        createdAt: tx.createdAt,
        userId: tx.userId,
        cardId: extractTransactionMetadata(tx).cardId || tx?.metadata?.cardId || null,
        amountToCard: toFiniteNumber(tx?.metadata?.topupAmountUsd ?? tx?.amountUsdt ?? tx?.amount ?? 0),
        feeUsd: toFiniteNumber(tx?.feeUsdt ?? tx?.metadata?.feeUsd ?? 0),
        walletDeducted: toFiniteNumber(tx?.metadata?.totalDebitUsd ?? tx?.amountUsdt ?? tx?.amount ?? 0),
        status: tx.status,
      }));
    const summary = {
      totalTopUps: rows.length,
      totalFeesCollected: Number(rows.reduce((sum, row) => sum + row.feeUsd, 0).toFixed(2)),
      totalVolume: Number(rows.reduce((sum, row) => sum + row.amountToCard, 0).toFixed(2)),
    };
    if (maybeCsv(res, "card-topup-report.csv", ["createdAt", "userId", "cardId", "amountToCard", "feeUsd", "walletDeducted", "status"], rows.map((row) => [row.createdAt, row.userId, row.cardId || "", row.amountToCard, row.feeUsd, row.walletDeducted, row.status]), formatCsv)) return;
    return ok(res, { summary, rows });
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

router.get("/reports/card-requests-wallet", requireAdmin, async (req, res) => {
  try {
    const query = AdminReportQuerySchema.parse(req.query || {});
    const since = toDateOrUndefined(query.from) || startOfUtcDay();
    const until = toDateOrUndefined(query.to);
    const limit = query.limit || 100;
    const formatCsv = query.format === "csv";
    const txFilter: any = { createdAt: until ? { gte: since, lte: until } : { gte: since } };
    const txs = isPrismaPersistenceEnabled()
      ? await prisma.transaction.findMany({ where: txFilter, orderBy: { createdAt: "desc" }, take: limit * 10 })
      : await Transaction.find(txFilter).sort({ createdAt: -1 }).limit(limit * 10).lean();
    const cardRequests = isPrismaPersistenceEnabled()
      ? await prisma.cardRequest.findMany({ where: { updatedAt: until ? { gte: since, lte: until } : { gte: since } }, orderBy: { updatedAt: "desc" }, take: limit * 10 })
      : await CardRequest.find({ updatedAt: until ? { $gte: since, $lte: until } : { $gte: since }, $or: [{ metadata: { $exists: true } }, { amount: { $exists: true } }] }).sort({ updatedAt: -1 }).limit(limit * 10).lean();

    const rows = [
      ...(txs as any[])
        .filter(isWalletCardRequestTxn)
        .map((tx) => ({
          createdAt: tx.createdAt,
          userId: tx.userId,
          cardFunded: toFiniteNumber(tx?.metadata?.cardAmountUsd ?? tx?.amountUsdt ?? tx?.amount ?? 0),
          fee: toFiniteNumber(tx?.metadata?.feeUsd ?? tx?.feeUsdt ?? 0),
          walletDeducted: toFiniteNumber(tx?.metadata?.totalUsd ?? tx?.amountUsdt ?? tx?.amount ?? 0),
          status: tx.status,
          tier: tx?.metadata?.tier || null,
        })),
      ...cardRequests
        .filter((r: any) => String(r?.metadata?.paymentMethod || r?.metadata?.source || "").toLowerCase() === "wallet")
        .map((r: any) => ({
          createdAt: r.createdAt,
          userId: r.userId,
          cardFunded: toFiniteNumber(r?.metadata?.cardAmountUsd ?? r?.amount ?? 0),
          fee: toFiniteNumber(r?.metadata?.feeUsd ?? 0),
          walletDeducted: toFiniteNumber(r?.metadata?.totalUsd ?? r?.amount ?? 0),
          status: r.status,
          tier: r?.metadata?.tier || null,
        })),
    ]
      .filter((row) => !query.userId || String(row.userId) === String(query.userId))
      .slice(0, limit);
    const summary = {
      totalRequests: rows.length,
      totalFeesCollected: Number(rows.reduce((sum, row) => sum + row.fee, 0).toFixed(2)),
    };
    if (maybeCsv(res, "card-request-wallet-report.csv", ["createdAt", "userId", "cardFunded", "fee", "walletDeducted", "status", "tier"], rows.map((row) => [row.createdAt, row.userId, row.cardFunded, row.fee, row.walletDeducted, row.status, row.tier || ""]), formatCsv)) return;
    return ok(res, { summary, rows });
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

router.get("/reports/transfers", requireAdmin, async (req, res) => {
  try {
    const query = AdminReportQuerySchema.parse(req.query || {});
    const since = toDateOrUndefined(query.from) || startOfUtcDay();
    const until = toDateOrUndefined(query.to);
    const limit = query.limit || 100;
    const formatCsv = query.format === "csv";
    const txFilter: any = { createdAt: until ? { gte: since, lte: until } : { gte: since } };
    const txs = isPrismaPersistenceEnabled()
      ? await prisma.transaction.findMany({ where: txFilter, orderBy: { createdAt: "desc" }, take: limit * 10 })
      : await Transaction.find(txFilter).sort({ createdAt: -1 }).limit(limit * 10).lean();
    const rowsRaw = (txs as any[]).filter(isP2pTransferTxn).filter((tx) => !query.userId || String(tx.userId) === String(query.userId));
    const userMap = await buildUserLookup(rowsRaw.flatMap((tx) => [tx.userId, extractTransactionMetadata(tx).recipientUserId].filter(Boolean) as string[]));
    const rows = rowsRaw.slice(0, limit).map((tx) => {
      const meta = extractTransactionMetadata(tx);
      const sender = userMap.get(String(tx.userId));
      const receiver = meta.recipientUserId ? userMap.get(meta.recipientUserId) : null;
      return {
        createdAt: tx.createdAt,
        senderUserId: tx.userId,
        senderName: userDisplayName(sender),
        receiverUserId: meta.recipientUserId || null,
        receiverName: userDisplayName(receiver),
        amount: toFiniteNumber(tx?.amountUsdt ?? tx?.amount ?? 0),
        reference: tx.transactionNumber || tx.referenceNumber || null,
        status: tx.status,
      };
    });
    if (maybeCsv(res, "transfer-history.csv", ["createdAt", "senderUserId", "senderName", "receiverUserId", "receiverName", "amount", "reference", "status"], rows.map((row) => [row.createdAt, row.senderUserId, row.senderName || "", row.receiverUserId || "", row.receiverName || "", row.amount, row.reference || "", row.status]), formatCsv)) return;
    return ok(res, { summary: { totalTransfers: rows.length, totalAmount: Number(rows.reduce((sum, row) => sum + row.amount, 0).toFixed(2)) }, rows });
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

router.get("/reports/bills", requireAdmin, async (req, res) => {
  try {
    const query = AdminReportQuerySchema.parse(req.query || {});
    const since = toDateOrUndefined(query.from) || startOfUtcDay();
    const until = toDateOrUndefined(query.to);
    const limit = query.limit || 100;
    const formatCsv = query.format === "csv";
    const txFilter: any = { createdAt: until ? { gte: since, lte: until } : { gte: since } };
    const txs = isPrismaPersistenceEnabled()
      ? await prisma.transaction.findMany({ where: txFilter, orderBy: { createdAt: "desc" }, take: limit * 10 })
      : await Transaction.find(txFilter).sort({ createdAt: -1 }).limit(limit * 10).lean();
    const rows = (txs as any[])
      .filter(isBillPaymentTxn)
      .filter((tx) => !query.userId || String(tx.userId) === String(query.userId))
      .slice(0, limit)
      .map((tx) => {
        const meta = extractTransactionMetadata(tx);
        return {
          createdAt: tx.createdAt,
          userId: tx.userId,
          billType: meta.kind || meta.source || String(tx?.metadata?.billType || tx?.metadata?.type || "bill"),
          provider: tx?.metadata?.provider || tx?.metadata?.operator || tx?.metadata?.vendor || null,
          number: tx?.metadata?.number || tx?.metadata?.phoneNumber || tx?.metadata?.meterNumber || tx?.referenceNumber || tx?.transactionNumber || null,
          amount: toFiniteNumber(tx?.amountUsdt ?? tx?.amount ?? 0),
          reference: tx.transactionNumber || tx.referenceNumber || null,
          status: tx.status,
        };
      });
    if (maybeCsv(res, "bill-payment-history.csv", ["createdAt", "userId", "billType", "provider", "number", "amount", "reference", "status"], rows.map((row) => [row.createdAt, row.userId, row.billType, row.provider || "", row.number || "", row.amount, row.reference || "", row.status]), formatCsv)) return;
    return ok(res, { summary: { totalPaidToday: rows.length, totalVolumeToday: Number(rows.reduce((sum, row) => sum + row.amount, 0).toFixed(2)), failedToday: rows.filter((row) => String(row.status).toLowerCase() === "failed").length }, rows });
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

router.get("/reports/referrals", requireAdmin, async (req, res) => {
  try {
    const query = AdminReportQuerySchema.parse(req.query || {});
    const limit = query.limit || 100;
    const refs = await TelegramLink.find({ $and: [{ referrerUserId: { $exists: true } }, { referrerUserId: { $ne: null } }, { referrerUserId: { $ne: "" } }] }).sort({ referredAt: -1, updatedAt: -1 }).limit(1000).lean();
    const referrerIds = Array.from(new Set(refs.map((r) => String(r.referrerUserId)).filter(Boolean)));
    const inviteeIds = Array.from(new Set(refs.map((r) => String(r.chatId)).filter(Boolean)));
    const userMap = await buildUserLookup([...referrerIds, ...inviteeIds]);
    const grouped = new Map<string, { userId: string; invited: number; verified: number; lastReferral?: Date; usernames: string[] }>();
    for (const row of refs as any[]) {
      const referrerUserId = String(row.referrerUserId || "").trim();
      if (!referrerUserId) continue;
      const current = grouped.get(referrerUserId) || { userId: referrerUserId, invited: 0, verified: 0, lastReferral: undefined, usernames: [] };
      current.invited += 1;
      const invitee = userMap.get(String(row.chatId));
      const status = String(invitee?.kycStatus || "").toLowerCase();
      if (status === "approved" || status === "pending") current.verified += 1;
      const referredAt = row.referredAt ? new Date(row.referredAt) : row.updatedAt ? new Date(row.updatedAt) : undefined;
      if (referredAt && (!current.lastReferral || referredAt > current.lastReferral)) current.lastReferral = referredAt;
      grouped.set(referrerUserId, current);
    }
    const rows = Array.from(grouped.values())
      .sort((a, b) => b.invited - a.invited || b.verified - a.verified)
      .slice(0, limit)
      .map((entry) => ({
        userId: entry.userId,
        userName: userDisplayName(userMap.get(entry.userId)),
        invited: entry.invited,
        verified: entry.verified,
        lastReferral: entry.lastReferral || null,
      }));
    const topReferrer = rows[0] ? `${rows[0].userName || rows[0].userId} (${rows[0].invited} invites)` : null;
    return ok(res, {
      summary: { totalReferrals: refs.length, verified: rows.reduce((sum, row) => sum + row.verified, 0), topReferrer },
      rows,
    });
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

router.get("/cards/terminated", requireAdmin, async (req, res) => {
  try {
    const query = AdminReportQuerySchema.parse(req.query || {});
    const limit = query.limit || 100;
    if (isPrismaPersistenceEnabled()) {
      const cards = await prisma.card.findMany({ where: { status: { in: ["terminated", "TERMINATED", "inactive", "INACTIVE", "closed", "CLOSED"] } }, orderBy: { updatedAt: "desc" }, take: limit });
      const userMap = await buildUserLookup(Array.from(new Set(cards.map((c) => c.userId).filter(Boolean) as string[])));
      return ok(res, { rows: cards.map((c) => ({ cardId: c.cardId, userId: c.userId, userName: userDisplayName(userMap.get(String(c.userId))), last4: c.last4, balanceReturned: Number(c.balance ?? c.availableBalance ?? 0), status: c.status, terminatedAt: c.updatedAt })) });
    }
    const cards = await Card.find({ status: { $in: ["terminated", "TERMINATED", "inactive", "INACTIVE", "closed", "CLOSED"] } }).sort({ updatedAt: -1 }).limit(limit).lean();
    const userMap = await buildUserLookup(Array.from(new Set(cards.map((c: any) => c.userId).filter(Boolean) as string[])));
    return ok(res, { rows: cards.map((c: any) => ({ cardId: c.cardId, userId: c.userId, userName: userDisplayName(userMap.get(String(c.userId))), last4: c.last4, balanceReturned: Number(c.balance ?? c.availableBalance ?? 0), status: c.status, terminatedAt: c.updatedAt })) });
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

router.get("/transactions/decline-fees/report", requireAdmin, async (req, res) => {
  try {
    const { days, minOccurrences, limit, format } = DeclineFeeReportQuerySchema.parse(req.query || {});
    const windowDays = days || 30;
    const minimum = minOccurrences || 3;
    const maxRows = limit || 200;

    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
    const shouldUsePrismaRead = ADMIN_PREFER_PRISMA_READS || isPrismaPersistenceEnabled() || mongoose.connection.readyState !== 1;
    const txns = shouldUsePrismaRead
      ? await prisma.transaction.findMany({
          where: {
            transactionType: "card",
            createdAt: { gte: since },
          },
          orderBy: { createdAt: "desc" },
          take: 10000,
        })
      : await Transaction.find({
          transactionType: "card",
          createdAt: { $gte: since },
          $or: [
            { "metadata.description": { $regex: DECLINE_FEE_MARKER } },
            { transactionNumber: { $regex: DECLINE_FEE_MARKER } },
            { referenceNumber: { $regex: DECLINE_FEE_MARKER } },
          ],
        })
          .sort({ createdAt: -1 })
          .limit(10000)
          .lean();

    const grouped = new Map<string, {
      userId: string;
      occurrences: number;
      totalFeeUsd: number;
      firstSeenAt?: Date;
      lastSeenAt?: Date;
      cards: Set<string>;
      sampleRefs: string[];
    }>();

    for (const tx of txns) {
      if (!isDeclineFeeTransaction(tx)) continue;
      const userId = String(tx.userId || "").trim();
      if (!userId) continue;

      const amount = Number(tx.amount || 0);
      const feeAbs = Number.isFinite(amount) ? Math.abs(amount) : 0;
      const current = grouped.get(userId) || {
        userId,
        occurrences: 0,
        totalFeeUsd: 0,
        firstSeenAt: undefined,
        lastSeenAt: undefined,
        cards: new Set<string>(),
        sampleRefs: [],
      };

      current.occurrences += 1;
      current.totalFeeUsd += feeAbs;

      if (tx.createdAt) {
        const createdAt = new Date(tx.createdAt);
        if (!current.firstSeenAt || createdAt < current.firstSeenAt) current.firstSeenAt = createdAt;
        if (!current.lastSeenAt || createdAt > current.lastSeenAt) current.lastSeenAt = createdAt;
      }

      const metadata = tx.metadata && typeof tx.metadata === "object" && !Array.isArray(tx.metadata) ? (tx.metadata as any) : undefined;
      if (metadata?.cardId) current.cards.add(String(metadata.cardId));
      const ref = tx.transactionNumber || tx.referenceNumber;
      if (ref && current.sampleRefs.length < 5) current.sampleRefs.push(String(ref));

      grouped.set(userId, current);
    }

    const impacted = Array.from(grouped.values())
      .filter((entry) => entry.occurrences >= minimum)
      .sort((a, b) => b.occurrences - a.occurrences || b.totalFeeUsd - a.totalFeeUsd)
      .slice(0, maxRows);

    const userIds = impacted.map((i) => i.userId);
    const users = userIds.length
      ? shouldUsePrismaRead
        ? await prisma.user.findMany({
            where: { userId: { in: userIds } },
            select: { userId: true, firstName: true, lastName: true, customerEmail: true },
          })
        : await User.find({ userId: { $in: userIds } })
            .select({ userId: 1, firstName: 1, lastName: 1, customerEmail: 1 })
            .lean()
      : [];
    const userMap = new Map(users.map((u) => [String(u.userId), u]));

    const rows = impacted.map((entry) => {
      const user = userMap.get(entry.userId);
      return {
        userId: entry.userId,
        userName: [user?.firstName, user?.lastName].filter(Boolean).join(" ") || null,
        customerEmail: user?.customerEmail || null,
        occurrences: entry.occurrences,
        totalFeeUsd: Number(entry.totalFeeUsd.toFixed(2)),
        affectedCards: Array.from(entry.cards),
        firstSeenAt: entry.firstSeenAt || null,
        lastSeenAt: entry.lastSeenAt || null,
        sampleRefs: entry.sampleRefs,
      };
    });

    if (format === "csv") {
      const header = [
        "userId",
        "userName",
        "customerEmail",
        "occurrences",
        "totalFeeUsd",
        "affectedCards",
        "firstSeenAt",
        "lastSeenAt",
        "sampleRefs",
      ].join(",");

      const lines = rows.map((r) =>
        [
          csvEscape(r.userId),
          csvEscape(r.userName || ""),
          csvEscape(r.customerEmail || ""),
          csvEscape(r.occurrences),
          csvEscape(r.totalFeeUsd),
          csvEscape(r.affectedCards.join("|")),
          csvEscape(r.firstSeenAt ? new Date(r.firstSeenAt).toISOString() : ""),
          csvEscape(r.lastSeenAt ? new Date(r.lastSeenAt).toISOString() : ""),
          csvEscape(r.sampleRefs.join("|")),
        ].join(",")
      );

      const csv = [header, ...lines].join("\n");
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename=decline-fee-report-${Date.now()}.csv`);
      return res.status(200).send(csv);
    }

    return ok(res, {
      generatedAt: new Date(),
      windowDays,
      minOccurrences: minimum,
      totalAffectedUsers: rows.length,
      rows,
    });
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

// Reconciliation summary
router.get("/reconciliation", requireAdmin, async (req, res) => {
  try {
    if (isPrismaPersistenceEnabled()) {
      return ok(res, { items: [] });
    }
    const limit = Number(req.query.limit || 50);
    const mismatchOnly = String(req.query.mismatchOnly || "false").toLowerCase() === "true";
    const items = await getReconciliationSummary(limit, mismatchOnly);
    return ok(res, { items });
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

// Run reconciliation for all cards
router.post("/reconciliation/run", requireAdmin, async (req, res) => {
  try {
    const mode = typeof req.body?.mode === "string" ? req.body.mode : undefined;
    const limit = req.body?.limit ? Number(req.body.limit) : undefined;
    const results = await reconcileAllCards({ mode, notify: true, limit });
    return ok(res, { results });
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

// Force reconciliation for a card
router.post("/reconciliation/:cardId/force", requireAdmin, async (req, res) => {
  try {
    const cardId = String(req.params.cardId);
    const mode = typeof req.body?.mode === "string" ? req.body.mode : undefined;
    const result = await reconcileCard(cardId, { mode, notify: true });
    return ok(res, { result });
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

export default router;
