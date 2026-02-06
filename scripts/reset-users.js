/*
One-shot script to reset all users: zero balances, clear telegram links, archive or remove transactions.
Usage: set MONGODB_URI and optionally REMOVE_TRANSACTIONS env, then run:
  node scripts/reset-users.js
*/

const mongoose = require("mongoose");
require("dotenv").config();

const MONGO =
  process.env.MONGODB_URI ||
  process.env.MONGODB ||
  "mongodb://localhost:27017/strowallet";
const REMOVE =
  (process.env.REMOVE_TRANSACTIONS || "false").toLowerCase() === "true";

async function run() {
  console.log("Connecting to", MONGO);
  await mongoose.connect(MONGO, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  });
  const db = mongoose.connection.db;

  try {
    const usersColl = db.collection("users");
    const linksColl = db.collection("telegramlinks");
    const txColl = db.collection("transactions");
    const auditColl = db.collection("runtimeaudits");

    const usersRes = await usersColl.updateMany(
      {},
      { $set: { balance: 0, currency: "USDT" } },
    );
    console.log(
      "Users updated:",
      usersRes.modifiedCount ||
        usersRes.result?.nModified ||
        usersRes.matchedCount,
    );

    const linksRes = await linksColl.updateMany({}, { $set: { cardIds: [] } });
    console.log(
      "Links updated:",
      linksRes.modifiedCount ||
        linksRes.result?.nModified ||
        linksRes.matchedCount,
    );

    const now = new Date();
    const archiveRes = await txColl.updateMany(
      { status: { $ne: "cancelled" } },
      {
        $set: {
          status: "cancelled",
          metadata: { archivedBy: "script_reset", archivedAt: now },
        },
      },
    );
    console.log(
      "Transactions archived:",
      archiveRes.modifiedCount ||
        archiveRes.result?.nModified ||
        archiveRes.matchedCount,
    );

    if (REMOVE) {
      const delRes = await txColl.deleteMany({});
      console.log("Transactions removed:", delRes.deletedCount);
    }

    try {
      await auditColl.insertOne({
        key: "reset_users",
        oldValue: null,
        newValue: {
          usersZeroed: usersRes.modifiedCount || null,
          linksCleared: linksRes.modifiedCount || null,
          transactionsArchived: archiveRes.modifiedCount || null,
          removedTransactions: REMOVE,
        },
        changedBy: "script",
        reason: "One-shot migration reset",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      console.log("Audit recorded");
    } catch (e) {
      console.warn("Failed to insert audit", e?.message || e);
    }

    console.log("Done");
  } catch (e) {
    console.error("Error", e?.message || e);
  } finally {
    await mongoose.disconnect();
  }
}

run();
