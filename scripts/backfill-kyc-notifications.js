// One-time script to notify users with High/Low KYC in StroWallet who missed notification
// Usage: node scripts/backfill-kyc-notifications.js

const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config();

const User = require('../src/models/User').default;
const Customer = require('../src/models/Customer').default;
const { notifyKycStatus } = require('../src/services/botService');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI || '', {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  });

  const customers = await Customer.find({
    kycStatus: { $in: ['high kyc', 'low kyc', 'high_kyc', 'low_kyc', 'high-kyc', 'low-kyc'] },
  }).lean();

  let notified = 0;
  for (const customer of customers) {
    const userId = customer.userId;
    if (!userId) continue;
    const status = /high/i.test(customer.kycStatus) ? 'approved' : 'rejected';
    try {
      await notifyKycStatus(userId, status);
      notified++;
      console.log(`Notified user ${userId} as ${status}`);
    } catch (e) {
      console.warn(`Failed to notify user ${userId}:`, e.message);
    }
  }
  console.log(`Done. Notified ${notified} users.`);
  process.exit(0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
