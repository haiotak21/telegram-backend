/* eslint-disable no-console */
require("dotenv").config();

const mongoose = require("mongoose");
const { PrismaClient } = require("@prisma/client");

const User = require("../dist/models/User").default;
const Transaction = require("../dist/models/Transaction").default;
const Card = require("../dist/models/Card").default;
const CardRequest = require("../dist/models/CardRequest").default;

const prisma = new PrismaClient();

function argValue(flag) {
  const exact = process.argv.find((a) => a.startsWith(`${flag}=`));
  if (!exact) return null;
  return exact.slice(flag.length + 1);
}

function toNullableString(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text.length ? text : null;
}

function toNullableNumber(value) {
  if (value == null) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function toNullableDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function migrateUsers(filter = {}) {
  let count = 0;
  const cursor = User.find(filter).lean().cursor();
  for await (const doc of cursor) {
    const userId = toNullableString(doc.userId);
    if (!userId) continue;

    await prisma.user.upsert({
      where: { userId },
      create: {
        userId,
        telegramId: toNullableString(doc.telegramId),
        chatId: toNullableString(doc.chatId),
        username: toNullableString(doc.username),
        balance: Number(doc.balance || 0),
        currency: toNullableString(doc.currency) || "USDT",
        kycStatus: toNullableString(doc.kycStatus) || "not_started",
        strowalletCustomerId: toNullableString(doc.strowalletCustomerId),
        firstName: toNullableString(doc.firstName),
        lastName: toNullableString(doc.lastName),
        dateOfBirth: toNullableString(doc.dateOfBirth),
        phoneNumber: toNullableString(doc.phoneNumber),
        customerEmail: toNullableString(doc.customerEmail),
        line1: toNullableString(doc.line1),
        city: toNullableString(doc.city),
        state: toNullableString(doc.state),
        zipCode: toNullableString(doc.zipCode),
        country: toNullableString(doc.country),
        houseNumber: toNullableString(doc.houseNumber),
        idType: toNullableString(doc.idType),
        idNumberEncrypted: toNullableString(doc.idNumberEncrypted),
        idNumberLast4: toNullableString(doc.idNumberLast4),
        idImageUrl: toNullableString(doc.idImageUrl),
        idImageFrontUrl: toNullableString(doc.idImageFrontUrl),
        idImageBackUrl: toNullableString(doc.idImageBackUrl),
        idImagePdfUrl: toNullableString(doc.idImagePdfUrl),
        userPhotoUrl: toNullableString(doc.userPhotoUrl),
        kycSubmittedAt: toNullableDate(doc.kycSubmittedAt),
      },
      update: {
        telegramId: toNullableString(doc.telegramId),
        chatId: toNullableString(doc.chatId),
        username: toNullableString(doc.username),
        balance: Number(doc.balance || 0),
        currency: toNullableString(doc.currency) || "USDT",
        kycStatus: toNullableString(doc.kycStatus) || "not_started",
        strowalletCustomerId: toNullableString(doc.strowalletCustomerId),
        firstName: toNullableString(doc.firstName),
        lastName: toNullableString(doc.lastName),
        dateOfBirth: toNullableString(doc.dateOfBirth),
        phoneNumber: toNullableString(doc.phoneNumber),
        customerEmail: toNullableString(doc.customerEmail),
        line1: toNullableString(doc.line1),
        city: toNullableString(doc.city),
        state: toNullableString(doc.state),
        zipCode: toNullableString(doc.zipCode),
        country: toNullableString(doc.country),
        houseNumber: toNullableString(doc.houseNumber),
        idType: toNullableString(doc.idType),
        idNumberEncrypted: toNullableString(doc.idNumberEncrypted),
        idNumberLast4: toNullableString(doc.idNumberLast4),
        idImageUrl: toNullableString(doc.idImageUrl),
        idImageFrontUrl: toNullableString(doc.idImageFrontUrl),
        idImageBackUrl: toNullableString(doc.idImageBackUrl),
        idImagePdfUrl: toNullableString(doc.idImagePdfUrl),
        userPhotoUrl: toNullableString(doc.userPhotoUrl),
        kycSubmittedAt: toNullableDate(doc.kycSubmittedAt),
      },
    });
    count += 1;
    if (count % 100 === 0) console.log(`Migrated users: ${count}`);
  }
  return count;
}

async function migrateCards(filter = {}) {
  let count = 0;
  const cursor = Card.find(filter).lean().cursor();
  for await (const doc of cursor) {
    const cardId = toNullableString(doc.cardId);
    if (!cardId) continue;

    await prisma.card.upsert({
      where: { cardId },
      create: {
        cardId,
        userId: toNullableString(doc.userId),
        customerEmail: toNullableString(doc.customerEmail),
        nameOnCard: toNullableString(doc.nameOnCard),
        cardType: toNullableString(doc.cardType),
        status: toNullableString(doc.status),
        last4: toNullableString(doc.last4),
        currency: toNullableString(doc.currency),
        balance: toNullableString(doc.balance),
        availableBalance: toNullableString(doc.availableBalance),
        lastSync: toNullableDate(doc.lastSync),
      },
      update: {
        userId: toNullableString(doc.userId),
        customerEmail: toNullableString(doc.customerEmail),
        nameOnCard: toNullableString(doc.nameOnCard),
        cardType: toNullableString(doc.cardType),
        status: toNullableString(doc.status),
        last4: toNullableString(doc.last4),
        currency: toNullableString(doc.currency),
        balance: toNullableString(doc.balance),
        availableBalance: toNullableString(doc.availableBalance),
        lastSync: toNullableDate(doc.lastSync),
      },
    });
    count += 1;
    if (count % 100 === 0) console.log(`Migrated cards: ${count}`);
  }
  return count;
}

async function migrateTransactions(filter = {}) {
  let count = 0;
  const cursor = Transaction.find(filter).lean().cursor();
  for await (const doc of cursor) {
    const userId = toNullableString(doc.userId);
    if (!userId) continue;

    await prisma.transaction.create({
      data: {
        userId,
        transactionType: toNullableString(doc.transactionType) || "deposit",
        paymentMethod: toNullableString(doc.paymentMethod) || "system",
        amount: Number(doc.amount || 0),
        currency: toNullableString(doc.currency),
        amountEtb: toNullableNumber(doc.amountEtb),
        amountUsdt: toNullableNumber(doc.amountUsdt),
        feeEtb: toNullableNumber(doc.feeEtb),
        feeUsdt: toNullableNumber(doc.feeUsdt),
        rateSnapshot: toNullableNumber(doc.rateSnapshot),
        transactionNumber: toNullableString(doc.transactionNumber),
        referenceNumber: toNullableString(doc.referenceNumber),
        status: toNullableString(doc.status) || "pending",
        verified: Boolean(doc.verified),
        responseData: doc.responseData || undefined,
        metadata: doc.metadata || undefined,
      },
    });
    count += 1;
    if (count % 500 === 0) console.log(`Migrated transactions: ${count}`);
  }
  return count;
}

async function migrateCardRequests(filter = {}) {
  let count = 0;
  const cursor = CardRequest.find(filter).lean().cursor();
  for await (const doc of cursor) {
    const userId = toNullableString(doc.userId);
    if (!userId) continue;

    await prisma.cardRequest.create({
      data: {
        userId,
        nameOnCard: toNullableString(doc.nameOnCard),
        cardType: toNullableString(doc.cardType),
        amount: toNullableString(doc.amount),
        customerEmail: toNullableString(doc.customerEmail),
        mode: toNullableString(doc.mode),
        status: toNullableString(doc.status) || "pending",
        adminNote: toNullableString(doc.adminNote),
        decisionReason: toNullableString(doc.decisionReason),
        cardId: toNullableString(doc.cardId),
        cardNumber: toNullableString(doc.cardNumber),
        cvc: toNullableString(doc.cvc),
        responseData: doc.responseData || undefined,
        metadata: doc.metadata || undefined,
      },
    });
    count += 1;
    if (count % 200 === 0) console.log(`Migrated card requests: ${count}`);
  }
  return count;
}

async function truncatePrismaTables() {
  console.log("Truncating Supabase tables before migration...");
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "Transaction" RESTART IDENTITY CASCADE',
  );
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "CardRequest" RESTART IDENTITY CASCADE',
  );
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "Card" RESTART IDENTITY CASCADE',
  );
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "User" RESTART IDENTITY CASCADE',
  );
}

async function clearTargetUser(userId, customerEmail) {
  console.log(`Clearing existing Supabase rows for user ${userId}...`);
  await prisma.transaction.deleteMany({ where: { userId } });
  await prisma.cardRequest.deleteMany({
    where: {
      OR: [{ userId }, ...(customerEmail ? [{ customerEmail }] : [])],
    },
  });
  await prisma.card.deleteMany({
    where: {
      OR: [{ userId }, ...(customerEmail ? [{ customerEmail }] : [])],
    },
  });
  await prisma.user.deleteMany({ where: { userId } });
}

async function resolveTargetUserFilter(targetUserId) {
  const users = await User.find({
    $or: [
      { userId: targetUserId },
      { telegramId: targetUserId },
      { chatId: targetUserId },
    ],
  })
    .lean()
    .limit(1);

  const user = users[0] || null;
  if (!user) {
    return {
      userFilter: { userId: targetUserId },
      cardFilter: { userId: targetUserId },
      cardRequestFilter: { userId: targetUserId },
      transactionFilter: { userId: targetUserId },
      resolvedUserId: targetUserId,
      customerEmail: null,
      found: false,
    };
  }

  const resolvedUserId = toNullableString(user.userId) || targetUserId;
  const customerEmail = toNullableString(user.customerEmail);
  return {
    userFilter: { userId: resolvedUserId },
    cardFilter: {
      $or: [
        { userId: resolvedUserId },
        ...(customerEmail ? [{ customerEmail }] : []),
      ],
    },
    cardRequestFilter: {
      $or: [
        { userId: resolvedUserId },
        ...(customerEmail ? [{ customerEmail }] : []),
      ],
    },
    transactionFilter: { userId: resolvedUserId },
    resolvedUserId,
    customerEmail,
    found: true,
  };
}

async function main() {
  const mongoUri = process.env.MIGRATION_MONGODB_URI || process.env.MONGODB_URI;
  const truncate = process.argv.includes("--truncate");
  const targetUserId = argValue("--userId");
  const wipeUser = process.argv.includes("--wipe-user");

  if (!mongoUri) {
    throw new Error("MIGRATION_MONGODB_URI or MONGODB_URI is required");
  }
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required");
  }

  console.log("Connecting Mongo source...");
  await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 15000 });
  console.log("Connecting Supabase target...");
  await prisma.$connect();

  if (truncate) {
    await truncatePrismaTables();
  }

  console.log("Starting migration...");
  let users = 0;
  let cards = 0;
  let cardRequests = 0;
  let txns = 0;

  if (targetUserId) {
    const scope = await resolveTargetUserFilter(targetUserId);
    if (!scope.found) {
      console.warn(
        `Target user ${targetUserId} not found in Mongo by userId/telegramId/chatId.`,
      );
    } else {
      console.log(
        `Targeted restore for userId=${scope.resolvedUserId}${scope.customerEmail ? ` email=${scope.customerEmail}` : ""}`,
      );
    }
    if (wipeUser) {
      await clearTargetUser(scope.resolvedUserId, scope.customerEmail);
    }
    users = await migrateUsers(scope.userFilter);
    cards = await migrateCards(scope.cardFilter);
    cardRequests = await migrateCardRequests(scope.cardRequestFilter);
    txns = await migrateTransactions(scope.transactionFilter);
  } else {
    users = await migrateUsers();
    cards = await migrateCards();
    cardRequests = await migrateCardRequests();
    txns = await migrateTransactions();
  }

  console.log("Migration complete", {
    users,
    cards,
    cardRequests,
    transactions: txns,
  });
}

main()
  .catch((err) => {
    console.error("Migration failed:", err?.message || err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await mongoose.disconnect();
    } catch {}
    try {
      await prisma.$disconnect();
    } catch {}
  });
