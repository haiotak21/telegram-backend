/*
One-shot script to backfill card links from stored StroWallet webhook events.
Usage: set MONGODB_URI and optionally MONGODB_DB_NAME, then run:
  node scripts/backfill-card-links.js
*/

const mongoose = require("mongoose");
require("dotenv").config();

const MONGO =
  process.env.MONGODB_URI ||
  process.env.MONGODB ||
  "mongodb://localhost:27017/strowallet";

function extractField(obj, keys) {
  if (!obj || typeof obj !== "object") return undefined;
  for (const key of keys) {
    if (obj[key]) return String(obj[key]);
  }
  for (const val of Object.values(obj)) {
    const v = typeof val === "object" ? extractField(val, keys) : undefined;
    if (v) return v;
  }
  return undefined;
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
  const eventsColl = db.collection("webhookevents");
  const cardsColl = db.collection("cards");
  const usersColl = db.collection("users");
  const customersColl = db.collection("customers");
  const linksColl = db.collection("telegramlinks");
  const cardRequestsColl = db.collection("cardrequests");

  const stats = {
    scanned: 0,
    linked: 0,
    skipped: 0,
    errors: 0,
  };

  try {
    const cursor = eventsColl
      .find({ type: "card.created" })
      .sort({ receivedAt: -1 });
    while (await cursor.hasNext()) {
      const event = await cursor.next();
      stats.scanned += 1;
      const payload = event?.payload || {};
      const cardId = extractField(payload, ["card_id", "cardId", "id", "card"]);
      if (!cardId) {
        stats.skipped += 1;
        continue;
      }
      const customerEmail = extractField(payload, ["customerEmail", "email"]);
      const customerId = extractField(payload, [
        "customerId",
        "customer_id",
        "cardholderId",
        "card_holder_id",
      ]);

      let userId;
      if (customerEmail) {
        const customer = await customersColl.findOne({ email: customerEmail });
        if (customer?.userId) userId = String(customer.userId);
      }
      if (!userId && customerId) {
        const customer = await customersColl.findOne({ customerId });
        if (customer?.userId) userId = String(customer.userId);
      }
      if (!userId && customerEmail) {
        const user = await usersColl.findOne({ customerEmail });
        if (user?.userId) userId = String(user.userId);
      }

      await cardsColl.updateOne(
        { cardId },
        {
          $set: {
            cardId,
            customerEmail: customerEmail || undefined,
            userId: userId || undefined,
            lastSync: new Date(),
          },
        },
        { upsert: true },
      );

      if (userId) {
        const chatId = Number(userId);
        if (Number.isFinite(chatId)) {
          await linksColl.updateOne(
            { chatId },
            {
              $addToSet: { cardIds: cardId },
              ...(customerEmail ? { $set: { customerEmail } } : {}),
            },
            { upsert: true },
          );
        }
      }

      if (customerEmail) {
        await linksColl.updateOne(
          { customerEmail },
          { $addToSet: { cardIds: cardId } },
          { upsert: true },
        );
      }

      if (userId || customerEmail) {
        await cardRequestsColl.updateOne(
          {
            $or: [
              ...(userId ? [{ userId }] : []),
              ...(customerEmail ? [{ customerEmail }] : []),
            ],
          },
          { $set: { cardId, status: "approved" } },
        );
      }

      stats.linked += 1;
      if (stats.linked % 50 === 0) {
        console.log("Linked", stats.linked, "cards...");
      }
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
