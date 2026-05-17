import User from "../models/User";
import BroadcastJob, { BroadcastFilter } from "../models/BroadcastJob";
import { sendBroadcastToUser } from "./botService";
import prisma from "../utils/prisma";
import { isPrismaPersistenceEnabled } from "../utils/persistence";

const BATCH_SIZE = Math.max(1, Number(process.env.BROADCAST_BATCH_SIZE || 25));
const TICK_MS = Math.max(250, Number(process.env.BROADCAST_TICK_MS || 1000));

let workerTimer: NodeJS.Timeout | null = null;
let workerBusy = false;

type BroadcastStatus = "pending" | "sending" | "completed" | "failed";

type InMemoryBroadcastJob = {
  id: string;
  createdBy?: string;
  messageText: string;
  imageUrl?: string;
  targetFilter: BroadcastFilter;
  targetUserIds: string[];
  targetCount: number;
  processedCount: number;
  successCount: number;
  failureCount: number;
  status: BroadcastStatus;
  lastError?: string;
  startedAt?: Date;
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
};

const inMemoryBroadcastJobs = new Map<string, InMemoryBroadcastJob>();

function toInMemoryJobResponse(job: InMemoryBroadcastJob) {
  return {
    _id: job.id,
    createdBy: job.createdBy,
    targetFilter: job.targetFilter,
    targetCount: job.targetCount,
    processedCount: job.processedCount,
    successCount: job.successCount,
    failureCount: job.failureCount,
    status: job.status,
    lastError: job.lastError,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
  };
}

async function processInMemoryJob(jobId: string) {
  const job = inMemoryBroadcastJobs.get(jobId);
  if (!job) return;
  if (job.status === "completed" || job.status === "failed") return;

  job.status = "sending";
  if (!job.startedAt) job.startedAt = new Date();
  job.updatedAt = new Date();

  try {
    while (job.processedCount < job.targetCount) {
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
      job.updatedAt = new Date();

      if (job.processedCount < job.targetCount) {
        await new Promise((resolve) => setTimeout(resolve, TICK_MS));
      }
    }

    job.status = "completed";
    job.completedAt = new Date();
    job.updatedAt = new Date();
  } catch (e: any) {
    job.status = "failed";
    job.lastError = e?.message || "Broadcast failed";
    job.completedAt = new Date();
    job.updatedAt = new Date();
  }
}

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
      return users.map((u: any) => String(u.userId)).filter((id: string) => isNumericUserId(id));
    }

    const users = await prisma.user.findMany({ select: { userId: true } });
    return users.map((u: any) => String(u.userId)).filter((id: string) => isNumericUserId(id));
  }

  if (filter === "balance_positive") {
    const users = await User.find({ balance: { $gt: 0 }, userId: { $regex: /^\d+$/ } })
      .select({ userId: 1 })
      .lean();
    return users.map((u) => String(u.userId));
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
  if (isPrismaPersistenceEnabled()) {
    const active = Array.from(inMemoryBroadcastJobs.values()).find((j) => j.status === "sending" || j.status === "pending");
    if (active) {
      const err: any = new Error("Another broadcast is already in progress");
      err.status = 409;
      throw err;
    }

    const targetUserIds = await getBroadcastTargetUserIds(params.targetFilter);
    const now = new Date();
    const id = `job_${now.getTime()}_${Math.random().toString(36).slice(2, 8)}`;
    const job: InMemoryBroadcastJob = {
      id,
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
      createdAt: now,
      updatedAt: now,
    };
    inMemoryBroadcastJobs.set(id, job);
    setTimeout(() => {
      processInMemoryJob(id).catch(() => {});
    }, 0);
    return toInMemoryJobResponse(job);
  }

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

export async function listBroadcastJobs(limit: number) {
  if (isPrismaPersistenceEnabled()) {
    return Array.from(inMemoryBroadcastJobs.values())
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit)
      .map(toInMemoryJobResponse);
  }

  return BroadcastJob.find({})
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
}

export async function getBroadcastJobById(id: string) {
  if (isPrismaPersistenceEnabled()) {
    const job = inMemoryBroadcastJobs.get(id);
    return job ? toInMemoryJobResponse(job) : null;
  }

  return BroadcastJob.findById(id).lean();
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
