/* eslint-disable no-console */
require("dotenv").config();

const mongoose = require("mongoose");
const { PrismaClient } = require("@prisma/client");

const User = require("../dist/models/User").default;
const Transaction = require("../dist/models/Transaction").default;
const Card = require("../dist/models/Card").default;
const CardRequest = require("../dist/models/CardRequest").default;

const prisma = new PrismaClient();

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

async function migrateUsers() {
  let count = 0;
  const cursor = User.find({}).lean().cursor();
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

async function migrateCards() {
  let count = 0;
  const cursor = Card.find({}).lean().cursor();
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

async function migrateTransactions() {
  let count = 0;
  const cursor = Transaction.find({}).lean().cursor();
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

async function migrateCardRequests() {
  let count = 0;
  const cursor = CardRequest.find({}).lean().cursor();
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
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "Transaction" RESTART IDENTITY CASCADE');
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "CardRequest" RESTART IDENTITY CASCADE');
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "Card" RESTART IDENTITY CASCADE');
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "User" RESTART IDENTITY CASCADE');
}

async function main() {
  const mongoUri = process.env.MIGRATION_MONGODB_URI || process.env.MONGODB_URI;
  const truncate = process.argv.includes("--truncate");

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
  const users = await migrateUsers();
  const cards = await migrateCards();
  const cardRequests = await migrateCardRequests();
  const txns = await migrateTransactions();

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
