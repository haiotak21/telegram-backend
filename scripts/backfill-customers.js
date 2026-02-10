/*
One-shot script to backfill Customer records from existing User KYC data.
Usage: set MONGODB_URI and optionally MONGODB_DB_NAME, then run:
  node scripts/backfill-customers.js
*/

const mongoose = require("mongoose");
require("dotenv").config();

const MONGO =
  process.env.MONGODB_URI ||
  process.env.MONGODB ||
  "mongodb://localhost:27017/strowallet";

function mapKycStatus(user) {
  const status = String(user?.kycStatus || "").toLowerCase();
  if (status === "approved") return "approved";
  if (status === "declined" || status === "rejected") return "rejected";
  return "pending";
}

function isTruthy(value) {
  return value !== undefined && value !== null && value !== "";
}

function buildUserQuery() {
  return {
    $or: [
      { firstName: { $exists: true, $ne: "" } },
      { lastName: { $exists: true, $ne: "" } },
      { idType: { $exists: true, $ne: "" } },
      { idNumberLast4: { $exists: true, $ne: "" } },
      { idImageUrl: { $exists: true, $ne: "" } },
      { idImageFrontUrl: { $exists: true, $ne: "" } },
      { idImageBackUrl: { $exists: true, $ne: "" } },
      { idImagePdfUrl: { $exists: true, $ne: "" } },
      { userPhotoUrl: { $exists: true, $ne: "" } },
      { kycSubmittedAt: { $exists: true, $ne: null } },
      { strowalletCustomerId: { $exists: true, $ne: "" } },
      { customerEmail: { $exists: true, $ne: "" } },
    ],
  };
}

async function run() {
  console.log("Connecting to", MONGO);
  const options = {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  };
  if (process.env.MONGODB_DB_NAME) {
    options.dbName = process.env.MONGODB_DB_NAME;
  }
  if (process.env.MONGODB_AUTHSOURCE) {
    options.authSource = process.env.MONGODB_AUTHSOURCE;
  }
  await mongoose.connect(MONGO, options);

  const db = mongoose.connection.db;
  const usersColl = db.collection("users");
  const customersColl = db.collection("customers");

  const stats = {
    processed: 0,
    created: 0,
    skipped: 0,
    errors: 0,
  };

  try {
    const users = await usersColl.find(buildUserQuery()).toArray();
    if (!users.length) {
      console.log("No users found with KYC data. Nothing to backfill.");
      return;
    }

    const userIds = users
      .map((u) => String(u.userId || "").trim())
      .filter(Boolean);

    const existing = await customersColl
      .find({ userId: { $in: userIds } }, { projection: { userId: 1 } })
      .toArray();
    const existingSet = new Set(existing.map((c) => String(c.userId)));

    const toInsert = [];

    for (const user of users) {
      stats.processed += 1;
      const userId = String(user.userId || "").trim();
      if (!userId) {
        stats.errors += 1;
        console.warn("Skipping user with missing userId", user?._id || "");
        continue;
      }
      if (existingSet.has(userId)) {
        stats.skipped += 1;
        console.log(`Skipped ${userId} (Customer exists)`);
        continue;
      }

      const kycStatus = mapKycStatus(user);
      const approvedAt =
        kycStatus === "approved"
          ? user.kycApprovedAt || user.kycSubmittedAt || null
          : null;

      const doc = {
        userId,
        customerId: user.strowalletCustomerId || undefined,
        email: user.customerEmail || undefined,
        telegramId: user.telegramId || undefined,
        chatId: user.chatId || undefined,
        username: user.username || undefined,
        firstName: user.firstName || undefined,
        lastName: user.lastName || undefined,
        dateOfBirth: user.dateOfBirth || undefined,
        phoneNumber: user.phoneNumber || undefined,
        line1: user.line1 || undefined,
        city: user.city || undefined,
        state: user.state || undefined,
        zipCode: user.zipCode || undefined,
        country: user.country || undefined,
        houseNumber: user.houseNumber || undefined,
        idType: user.idType || undefined,
        idNumberEncrypted: user.idNumberEncrypted || undefined,
        idNumberLast4: user.idNumberLast4 || undefined,
        idImageUrl: user.idImageUrl || undefined,
        idImageFrontUrl: user.idImageFrontUrl || undefined,
        idImageBackUrl: user.idImageBackUrl || undefined,
        idImagePdfUrl: user.idImagePdfUrl || undefined,
        userPhotoUrl: user.userPhotoUrl || undefined,
        kycStatus,
        submittedAt: user.kycSubmittedAt || undefined,
        approvedAt: approvedAt || undefined,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      if (!isTruthy(doc.customerId)) delete doc.customerId;
      if (!isTruthy(doc.email)) delete doc.email;
      if (!isTruthy(doc.telegramId)) delete doc.telegramId;
      if (!isTruthy(doc.chatId)) delete doc.chatId;
      if (!isTruthy(doc.username)) delete doc.username;
      if (!isTruthy(doc.firstName)) delete doc.firstName;
      if (!isTruthy(doc.lastName)) delete doc.lastName;
      if (!isTruthy(doc.dateOfBirth)) delete doc.dateOfBirth;
      if (!isTruthy(doc.phoneNumber)) delete doc.phoneNumber;
      if (!isTruthy(doc.line1)) delete doc.line1;
      if (!isTruthy(doc.city)) delete doc.city;
      if (!isTruthy(doc.state)) delete doc.state;
      if (!isTruthy(doc.zipCode)) delete doc.zipCode;
      if (!isTruthy(doc.country)) delete doc.country;
      if (!isTruthy(doc.houseNumber)) delete doc.houseNumber;
      if (!isTruthy(doc.idType)) delete doc.idType;
      if (!isTruthy(doc.idNumberEncrypted)) delete doc.idNumberEncrypted;
      if (!isTruthy(doc.idNumberLast4)) delete doc.idNumberLast4;
      if (!isTruthy(doc.idImageUrl)) delete doc.idImageUrl;
      if (!isTruthy(doc.idImageFrontUrl)) delete doc.idImageFrontUrl;
      if (!isTruthy(doc.idImageBackUrl)) delete doc.idImageBackUrl;
      if (!isTruthy(doc.idImagePdfUrl)) delete doc.idImagePdfUrl;
      if (!isTruthy(doc.userPhotoUrl)) delete doc.userPhotoUrl;
      if (!isTruthy(doc.submittedAt)) delete doc.submittedAt;
      if (!isTruthy(doc.approvedAt)) delete doc.approvedAt;

      toInsert.push(doc);
      stats.created += 1;
      console.log(`Created Customer for ${userId} (${kycStatus})`);
    }

    if (toInsert.length) {
      await customersColl.insertMany(toInsert, { ordered: false });
    }

    console.log("Backfill complete:", stats);
  } catch (e) {
    stats.errors += 1;
    console.error("Backfill failed", e?.message || e);
  } finally {
    await mongoose.disconnect();
  }
}

run();
