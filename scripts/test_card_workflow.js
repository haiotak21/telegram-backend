require("dotenv").config();
const mongoose = require("mongoose");
const User = require("../dist/models/User").default;
const CardRequest = require("../dist/models/CardRequest").default;
const Card = require("../dist/models/Card").default;

(async () => {
  const stamp = Date.now();
  const approvedId = `test_approved_${stamp}`;
  const pendingId = `test_pending_${stamp}`;
  const activeId = `test_active_${stamp}`;

  await mongoose.connect(process.env.MONGODB_URI);

  await User.deleteMany({ userId: approvedId });
  await User.deleteMany({ userId: pendingId });
  await User.deleteMany({ userId: activeId });
  await CardRequest.deleteMany({ userId: approvedId });
  await CardRequest.deleteMany({ userId: pendingId });
  await Card.deleteMany({ userId: activeId });

  await User.create({
    userId: approvedId,
    firstName: "Test",
    lastName: "Approved",
    customerEmail: "approved@example.com",
    kycStatus: "approved",
  });
  await User.create({
    userId: pendingId,
    firstName: "Test",
    lastName: "Pending",
    customerEmail: "pending@example.com",
    kycStatus: "pending",
  });
  await User.create({
    userId: activeId,
    firstName: "Test",
    lastName: "Active",
    customerEmail: "active@example.com",
    kycStatus: "approved",
  });

  const reqApproved = await CardRequest.create({
    userId: approvedId,
    nameOnCard: "Test Approved",
    cardType: "visa",
    amount: "3",
    customerEmail: "approved@example.com",
    status: "pending",
  });
  const reqPending = await CardRequest.create({
    userId: pendingId,
    nameOnCard: "Test Pending",
    cardType: "visa",
    amount: "3",
    customerEmail: "pending@example.com",
    status: "pending",
  });

  await Card.create({
    cardId: `CARD_TEST_${stamp}`,
    userId: activeId,
    customerEmail: "active@example.com",
    status: "active",
    last4: "1234",
  });

  console.log(
    JSON.stringify({
      approvedId,
      pendingId,
      activeId,
      reqApprovedId: reqApproved._id.toString(),
      reqPendingId: reqPending._id.toString(),
    }),
  );

  await mongoose.disconnect();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
