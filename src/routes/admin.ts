import express from "express";
import axios, { AxiosError } from "axios";
import http from "http";
import https from "https";
import mongoose from "mongoose";
import { z } from "zod";
import { v2 as cloudinary } from "cloudinary";
import User from "../models/User";
import Customer from "../models/Customer";
import Card from "../models/Card";
import CardRequest from "../models/CardRequest";
import { TelegramLink } from "../models/TelegramLink";
import Transaction from "../models/Transaction";
import { notifyCardLinkedToUser, notifyCardStatusChanged } from "../services/botService";
import { createBroadcastJob, getBroadcastJobById, getBroadcastTargetCount, listBroadcastJobs } from "../services/broadcastService";
import { auditCardTransactions, getReconciliationSummary, reconcileAllCards, reconcileCard } from "../services/reconciliationService";
import { ok, fail } from "../utils/apiResponse";
import prisma from "../utils/prisma";
import { isPrismaPersistenceEnabled } from "../utils/persistence";

const router = express.Router();

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

function normalizeKycProviderStatus(value?: any): "pending" | "approved" | "rejected" | undefined {
  if (value == null) return undefined;
  const compact = String(value).toLowerCase().replace(/[\s_-]+/g, "");
  if (["approved", "verified", "success", "active", "highkyc"].includes(compact)) return "approved";
  if (["pending", "processing", "review", "unreviewkyc"].includes(compact)) return "pending";
  if (["declined", "rejected", "failed", "lowkyc"].includes(compact)) return "rejected";
  return undefined;
}

async function fetchCardholderKyc(customerId?: string | null, customerEmail?: string | null) {
  const public_key = requirePublicKey();
  const params: any = { public_key };
  if (customerId) params.customerId = customerId;
  if (customerEmail) params.customerEmail = customerEmail;
  const resp = await bitvcard.get("getcardholder/", {
    params,
  });
  const payload = resp.data;
  const status = normalizeKycProviderStatus(
    extractField(payload, ["kycStatus", "verificationStatus", "status", "state", "kyc_state"])
  );
  const providerCustomerId =
    extractField(payload, ["customerId", "customer_id", "cardholderId", "card_holder_id"]) || customerId || undefined;
  const providerEmail = extractField(payload, ["customerEmail", "customer_email", "email"]) || customerEmail || undefined;
  return { status, providerCustomerId, providerEmail };
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

const SearchSchema = z.object({
  search: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

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

const BroadcastFilterSchema = z.enum(["all", "kyc_approved", "balance_positive"]);

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

router.get("/stats", requireAdmin, async (_req, res) => {
  try {
    if (isPrismaPersistenceEnabled()) {
      const [usersTotal, kycApproved, cardHoldersRows, transactionsTotal] = await Promise.all([
        prisma.user.count(),
        prisma.user.count({ where: { kycStatus: "approved" } }),
        prisma.card.findMany({
          where: {
            cardId: { not: "" },
            userId: { not: null },
          },
          select: { userId: true },
          distinct: ["userId"],
        }),
        prisma.transaction.count(),
      ]);
      const cardHolders = cardHoldersRows.filter((row) => Boolean(row.userId)).length;
      return ok(res, { usersTotal, kycApproved, cardHolders, transactionsTotal });
    }

    const [usersTotal, kycApproved, cardHolders, transactionsTotal] = await Promise.all([
      User.countDocuments({}),
      Customer.countDocuments({ kycStatus: "approved" }),
      Card.distinct("userId", { cardId: { $exists: true, $ne: "" } }).then((ids) => ids.length),
      Transaction.countDocuments({}),
    ]);
    return ok(res, { usersTotal, kycApproved, cardHolders, transactionsTotal });
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

router.get("/users", requireAdmin, async (req, res) => {
  try {
    const { search, limit } = SearchSchema.parse(req.query || {});
    const q = search?.trim();

    if (isPrismaPersistenceEnabled()) {
      const baseWhere: any = {
        OR: [
          { kycStatus: { in: ["pending", "approved", "declined"] } },
          { kycSubmittedAt: { not: null } },
          { strowalletCustomerId: { not: null } },
        ],
      };

      let where: any = baseWhere;
      if (q) {
        const isNumeric = /^\d+$/.test(q);
        where = {
          AND: [
            baseWhere,
            {
              OR: [
                ...(isNumeric ? [{ userId: q }] : []),
                { customerEmail: q },
                { strowalletCustomerId: q },
              ],
            },
          ],
        };
      }

      const items = await prisma.user.findMany({
        where,
        orderBy: [{ kycSubmittedAt: "desc" }, { updatedAt: "desc" }],
        take: limit || 50,
      });

      const users = items.map((u) => ({
        telegramUserId: u.userId,
        customerId: u.strowalletCustomerId || null,
        kycStatus: u.kycStatus || "not_started",
        customerKycStatus: null,
        userKycStatus: u.kycStatus || null,
        firstName: u.firstName,
        lastName: u.lastName,
        customerEmail: u.customerEmail,
        idType: u.idType,
        submittedAt: u.kycSubmittedAt,
      }));

      return ok(res, { users });
    }

    const baseQuery: any = {
      $or: [
        { kycStatus: { $in: ["pending", "approved", "declined"] } },
        { kycSubmittedAt: { $exists: true, $ne: null } },
        { strowalletCustomerId: { $exists: true, $ne: null } },
      ],
    };

    let query: any = baseQuery;

    if (q) {
      const isNumeric = /^\d+$/.test(q);
      query = {
        $and: [
          baseQuery,
          {
            $or: [
              ...(isNumeric ? [{ userId: q }] : []),
              { customerEmail: q },
              { strowalletCustomerId: q },
            ],
          },
        ],
      };
    }

    const items = await User.find(query)
      .sort({ kycSubmittedAt: -1, updatedAt: -1 })
      .limit(limit || 50)
      .lean();

    const userIds = items.map((u) => u.userId);
    const customers = await Customer.find({ userId: { $in: userIds } }).lean();
    const customerMap = new Map(customers.map((c) => [c.userId, c]));

    const users = items.map((u) => {
      const customer = customerMap.get(u.userId);
      return {
        telegramUserId: u.userId,
        customerId: customer?.customerId || u.strowalletCustomerId,
        kycStatus: customer?.kycStatus || "not_started",
        customerKycStatus: customer?.kycStatus || null,
        userKycStatus: u.kycStatus || null,
        firstName: u.firstName,
        lastName: u.lastName,
        customerEmail: customer?.email || u.customerEmail,
        idType: u.idType,
        submittedAt: customer?.submittedAt || u.kycSubmittedAt,
      };
    });

    return ok(res, { users });
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

router.get("/users/:telegramUserId/kyc-status", requireAdmin, async (req, res) => {
  try {
    const telegramUserId = String(req.params.telegramUserId);
    const refresh = String(req.query.refresh || "false").toLowerCase() === "true";
    if (isPrismaPersistenceEnabled()) {
      let user = await prisma.user.findUnique({ where: { userId: telegramUserId } });
      if (!user) return fail(res, "User not found", 404);

      if (refresh && (user.strowalletCustomerId || user.customerEmail)) {
        try {
          const refreshed = await fetchCardholderKyc(user.strowalletCustomerId, user.customerEmail);
          if (refreshed.status || refreshed.providerCustomerId || refreshed.providerEmail) {
            user = await prisma.user.update({
              where: { userId: telegramUserId },
              data: {
                ...(refreshed.status ? { kycStatus: refreshed.status } : {}),
                ...(refreshed.providerCustomerId ? { strowalletCustomerId: refreshed.providerCustomerId } : {}),
                ...(refreshed.providerEmail ? { customerEmail: refreshed.providerEmail } : {}),
              },
            });
          }
        } catch (err) {
          console.warn("[admin] kyc refresh failed", { telegramUserId, error: (err as any)?.message || String(err) });
        }
      }

      return ok(res, {
        telegramUserId: user.userId,
        customerId: user.strowalletCustomerId || null,
        customerEmail: user.customerEmail || null,
        kycStatus: user.kycStatus || "not_started",
        customerKycStatus: null,
        userKycStatus: user.kycStatus || null,
        submittedAt: user.kycSubmittedAt,
        idType: user.idType,
        name: [user.firstName, user.lastName].filter(Boolean).join(" "),
      });
    }

    let user = await User.findOne({ userId: telegramUserId }).lean();
    if (!user) return fail(res, "User not found", 404);
    let customer = await Customer.findOne({ userId: telegramUserId }).lean();
    if (!customer) return fail(res, "Customer not found", 404);

    if (refresh && (customer.customerId || customer.email || user.strowalletCustomerId || user.customerEmail)) {
      try {
        const refreshed = await fetchCardholderKyc(
          customer.customerId || user.strowalletCustomerId,
          customer.email || user.customerEmail
        );
        if (refreshed.status || refreshed.providerCustomerId || refreshed.providerEmail) {
          await Promise.all([
            User.updateOne(
              { userId: telegramUserId },
              {
                $set: {
                  ...(refreshed.status ? { kycStatus: refreshed.status } : {}),
                  ...(refreshed.providerCustomerId ? { strowalletCustomerId: refreshed.providerCustomerId } : {}),
                  ...(refreshed.providerEmail ? { customerEmail: refreshed.providerEmail } : {}),
                },
              }
            ),
            Customer.updateOne(
              { userId: telegramUserId },
              {
                $set: {
                  ...(refreshed.status ? { kycStatus: refreshed.status } : {}),
                  ...(refreshed.providerCustomerId ? { customerId: refreshed.providerCustomerId } : {}),
                  ...(refreshed.providerEmail ? { email: refreshed.providerEmail } : {}),
                },
              }
            ),
          ]);
          user = await User.findOne({ userId: telegramUserId }).lean();
          customer = await Customer.findOne({ userId: telegramUserId }).lean();
        }
      } catch (err) {
        console.warn("[admin] kyc refresh failed", { telegramUserId, error: (err as any)?.message || String(err) });
      }
    }

    if (!user) return fail(res, "User not found", 404);
    if (!customer) return fail(res, "Customer not found", 404);

    return ok(res, {
      telegramUserId: user.userId,
      customerId: customer.customerId || user.strowalletCustomerId,
      customerEmail: customer.email || user.customerEmail,
      kycStatus: customer.kycStatus,
      customerKycStatus: customer.kycStatus,
      userKycStatus: user.kycStatus || null,
      submittedAt: customer.submittedAt || user.kycSubmittedAt,
      idType: user.idType,
      name: [user.firstName, user.lastName].filter(Boolean).join(" "),
    });
  } catch (e) {
    const { status, message } = normalizeError(e);
    return fail(res, message, status);
  }
});

router.get("/users/:telegramUserId/kyc-debug", requireAdmin, async (req, res) => {
  try {
    const telegramUserId = String(req.params.telegramUserId);
    const user = await User.findOne({ userId: telegramUserId }).lean();
    if (!user) return fail(res, "User not found", 404);

    const missing = [
      user.idType ? null : "idType",
      user.idImageUrl || user.idImageFrontUrl || user.idImageBackUrl || user.idImagePdfUrl ? null : "idImage",
      user.userPhotoUrl ? null : "userPhoto",
      user.strowalletCustomerId ? null : "strowalletCustomerId",
    ].filter(Boolean);

    return ok(res, {
      telegramUserId: user.userId,
      kycStatus: user.kycStatus || "not_started",
      strowalletCustomerId: user.strowalletCustomerId,
      customerEmail: user.customerEmail,
      idType: user.idType,
      idImageUrl: user.idImageUrl,
      idImageFrontUrl: user.idImageFrontUrl,
      idImageBackUrl: user.idImageBackUrl,
      idImagePdfUrl: user.idImagePdfUrl,
      userPhotoUrl: user.userPhotoUrl,
      submittedAt: user.kycSubmittedAt,
      missing,
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

router.get("/users/:telegramUserId/kyc-payload", requireAdmin, async (req, res) => {
  try {
    const telegramUserId = String(req.params.telegramUserId);
    const user = await User.findOne({ userId: telegramUserId }).lean();
    if (!user) return fail(res, "User not found", 404);

    const idImage = user.idImagePdfUrl || user.idImageFrontUrl || user.idImageUrl || user.idImageBackUrl;
    const payload = {
      public_key: process.env.STROWALLET_PUBLIC_KEY,
      houseNumber: user.houseNumber,
      firstName: user.firstName,
      lastName: user.lastName,
      idNumber: "<FILL_WITH_USER_ID_NUMBER>",
      customerEmail: user.customerEmail,
      phoneNumber: user.phoneNumber,
      dateOfBirth: user.dateOfBirth,
      idImage,
      userPhoto: user.userPhotoUrl,
      line1: user.line1,
      state: user.state,
      zipCode: user.zipCode,
      city: user.city,
      country: user.country,
      idType: user.idType,
    };

    return ok(res, {
      note: "idNumber is not stored in plain text; fill it from the user. idNumberLast4 provided for reference.",
      idNumberLast4: user.idNumberLast4,
      payload,
    });
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
