const axios = require("axios");

const BASE = process.env.BACKEND || "http://localhost:3000";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "addispay_729Jaidkgs5gdioaI";

async function getFake() {
  const r = await axios.get(`${BASE}/api/wallet/fake-topup`, {
    headers: { "x-admin-token": ADMIN_TOKEN },
  });
  return r.data;
}

async function setFake(val) {
  const r = await axios.put(
    `${BASE}/api/wallet/fake-topup`,
    { value: !!val },
    { headers: { "x-admin-token": ADMIN_TOKEN } },
  );
  return r.data;
}

async function deposit() {
  const body = {
    userId: "script-test",
    paymentMethod: "telebirr",
    amount: 100,
    transactionNumber: `SIM-${Date.now()}`,
  };
  const r = await axios.post(`${BASE}/api/payment/deposit`, body, {
    headers: { "Content-Type": "application/json" },
  });
  return r.data;
}

(async () => {
  try {
    console.log("Current fake-topup:", await getFake());
    console.log("Setting fake-topup = true");
    console.log(await setFake(true));
    console.log("Simulating deposit (should be auto-completed) ...");
    console.log(await deposit());

    console.log("Setting fake-topup = false");
    console.log(await setFake(false));
    console.log("Simulating deposit (should require verification) ...");
    console.log(await deposit());
  } catch (e) {
    console.error("Error during test:", e.response?.data || e.message || e);
  }
})();
