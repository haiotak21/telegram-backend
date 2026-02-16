// One-time script to notify users with High/Low KYC in StroWallet who missed notification
// Usage: node scripts/backfill-kyc-notifications.js

const mongoose = require("mongoose");
const dotenv = require("dotenv");
dotenv.config();

async function main() {
  // Dynamically import ESM modules from compiled JS (no /src/ in dist)
  const User = (await import("../dist/models/User.js")).default;
  const Customer = (await import("../dist/models/Customer.js")).default;
  const { notifyKycStatus } = await import("../dist/services/botService.js");

  await mongoose.connect(
    process.env.MONGODB_URI || process.env.MONGO_URI || "",
    {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    },
  );

  const customers = await Customer.find({
    kycStatus: {
      $in: [
        "high kyc",
        "low kyc",
        "high_kyc",
        "low_kyc",
        "high-kyc",
        "low-kyc",
      ],
    },
    $or: [{ kycNotified: { $exists: false } }, { kycNotified: false }],
  });

  let notified = 0;
  for (const customer of customers) {
    const userId = customer.userId;
    if (!userId) continue;
    const status = /high/i.test(customer.kycStatus) ? "approved" : "rejected";
    try {
      await notifyKycStatus(userId, status);
      await Customer.updateOne(
        { _id: customer._id },
        { $set: { kycNotified: true } },
      );
      notified++;
      console.log(`Notified user ${userId} as ${status}`);
    } catch (e) {
      console.warn(`Failed to notify user ${userId}:`, e.message);
    }
  }
  console.log(`Done. Notified ${notified} users.`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
