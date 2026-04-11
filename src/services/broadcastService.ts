import User from "../models/User";
import Customer from "../models/Customer";
import BroadcastJob, { BroadcastFilter } from "../models/BroadcastJob";
import { sendBroadcastToUser } from "./botService";
import prisma from "../utils/prisma";
import { isPrismaPersistenceEnabled } from "../utils/persistence";

const BATCH_SIZE = Math.max(1, Number(process.env.BROADCAST_BATCH_SIZE || 25));
const TICK_MS = Math.max(250, Number(process.env.BROADCAST_TICK_MS || 1000));

let workerTimer: NodeJS.Timeout | null = null;
let workerBusy = false;

function isNumericUserId(value?: string) {
  return /^\d+$/.test(String(value || ""));
}

export async function getBroadcastTargetUserIds(filter: BroadcastFilter): Promise<string[]> {
  if (isPrismaPersistenceEnabled()) {
    if (filter === "balance_positive") {
      const users = await prisma.user.findMany({
        where: { balance: { gt: 0 } },
        select: { userId: true },
      });
      return users.map((u) => String(u.userId)).filter((id) => isNumericUserId(id));
    }

    if (filter === "kyc_approved") {
      const users = await prisma.user.findMany({
        where: { kycStatus: "approved" },
        select: { userId: true },
      });
      return users.map((u) => String(u.userId)).filter((id) => isNumericUserId(id));
    }

    const users = await prisma.user.findMany({ select: { userId: true } });
    return users.map((u) => String(u.userId)).filter((id) => isNumericUserId(id));
  }

  if (filter === "balance_positive") {
    const users = await User.find({ balance: { $gt: 0 }, userId: { $regex: /^\d+$/ } })
      .select({ userId: 1 })
      .lean();
    return users.map((u) => String(u.userId));
  }

  if (filter === "kyc_approved") {
    const approvedCustomers = await Customer.find({ kycStatus: "approved" }).select({ userId: 1 }).lean();
    const ids = new Set(approvedCustomers.map((c) => String(c.userId)).filter((id) => isNumericUserId(id)));
    if (!ids.size) {
      const approvedUsers = await User.find({ kycStatus: "approved", userId: { $regex: /^\d+$/ } })
        .select({ userId: 1 })
        .lean();
      approvedUsers.forEach((u) => ids.add(String(u.userId)));
    }
    return Array.from(ids);
  }

  const users = await User.find({ userId: { $regex: /^\d+$/ } }).select({ userId: 1 }).lean();
  return users.map((u) => String(u.userId));
}

export async function getBroadcastTargetCount(filter: BroadcastFilter) {
  const ids = await getBroadcastTargetUserIds(filter);
  return ids.length;
}

export async function createBroadcastJob(params: {
  createdBy?: string;
  messageText: string;
  imageUrl?: string;
  targetFilter: BroadcastFilter;
}) {
  const active = await BroadcastJob.findOne({ status: "sending" }).lean();
  if (active) {
    const err: any = new Error("Another broadcast is already in progress");
    err.status = 409;
    throw err;
  }

  const targetUserIds = await getBroadcastTargetUserIds(params.targetFilter);
  const job = await BroadcastJob.create({
    createdBy: params.createdBy,
    messageText: params.messageText,
    imageUrl: params.imageUrl,
    targetFilter: params.targetFilter,
    targetUserIds,
    targetCount: targetUserIds.length,
    processedCount: 0,
    successCount: 0,
    failureCount: 0,
    status: "pending",
  });

  return job;
}

async function processOneJobBatch() {
  if (workerBusy) return;
  workerBusy = true;

  try {
    let job = await BroadcastJob.findOne({ status: "sending" }).sort({ createdAt: 1 });
    if (!job) {
      job = await BroadcastJob.findOne({ status: "pending" }).sort({ createdAt: 1 });
      if (!job) return;
      job.status = "sending";
      job.startedAt = new Date();
      await job.save();
    }

    if (!job.targetUserIds.length) {
      job.status = "completed";
      job.completedAt = new Date();
      await job.save();
      return;
    }

    const start = Math.max(0, job.processedCount || 0);
    const end = Math.min(job.targetUserIds.length, start + BATCH_SIZE);
    const batch = job.targetUserIds.slice(start, end);

    let success = 0;
    let failure = 0;

    for (const userId of batch) {
      const r = await sendBroadcastToUser(userId, job.messageText, job.imageUrl);
      if (r.ok) success += 1;
      else failure += 1;
    }

    job.processedCount = end;
    job.successCount += success;
    job.failureCount += failure;

    if (job.processedCount >= job.targetCount) {
      job.status = "completed";
      job.completedAt = new Date();
    }

    await job.save();
  } catch (e: any) {
    const job = await BroadcastJob.findOne({ status: "sending" }).sort({ createdAt: 1 });
    if (job) {
      job.status = "failed";
      job.lastError = e?.message || "Broadcast failed";
      job.completedAt = new Date();
      await job.save();
    }
  } finally {
    workerBusy = false;
  }
}

export function startBroadcastWorker() {
  if (workerTimer) return;
  workerTimer = setInterval(() => {
    processOneJobBatch().catch(() => {});
  }, TICK_MS);
}
