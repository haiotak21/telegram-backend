import express from "express";
import request from "supertest";
import strowalletRouter from "../src/routes/strowallet";

// This test file performs a lightweight "manual" exercise of the stroWallet proxy
// routes by mounting the router in a fresh express app and making requests.

const app = express();
app.use(express.json());
app.use("/", strowalletRouter);

describe("StroWallet proxy manual smoke", () => {
  it("should respond on each route (expecting missing public key error)", async () => {
    const tests = [
      { method: "post", path: "/create-user", body: { customerEmail: "test@example.com" } },
      { method: "get", path: "/getcardholder" },
      { method: "put", path: "/updateCardCustomer", body: { customerId: "c1" } },
      { method: "patch", path: "/updateCardCustomer", body: { customerId: "c1" } },
      { method: "post", path: "/create-card", body: { name_on_card: "Me", card_type: "visa", amount: "10", customerEmail: "a@b.com" } },
      { method: "post", path: "/fund-card", body: { card_id: "1", amount: "5" } },
      { method: "post", path: "/fetch-card-detail", body: { card_id: "1" } },
      { method: "post", path: "/card-transactions", body: { card_id: "1" } },
      { method: "post", path: "/action/status", body: { action: "freeze", card_id: "1" } },
      { method: "get", path: "/apicard-transactions", query: { card_id: "1" } },
      { method: "post", path: "/apicard-transactions", body: { card_id: "1" } },
    ];

    for (const t of tests) {
      let res;
      if (t.method === "get") {
        res = await request(app).get(t.path).query((t as any).query || {});
      } else if (t.method === "post") {
        res = await request(app).post(t.path).send(t.body || {});
      } else if (t.method === "put") {
        res = await request(app).put(t.path).send(t.body || {});
      } else if (t.method === "patch") {
        res = await request(app).patch(t.path).send(t.body || {});
      } else {
        // fallback dynamic call
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        res = await (request(app) as any)[t.method](t.path).send(t.body || {});
      }

      // Log details for the manual testing report
      // eslint-disable-next-line no-console
      console.log('MANUAL-TEST', t.method.toUpperCase(), t.path, '=>', res.status, JSON.stringify(res.body));

      // All routes should return JSON; if STROWALLET_PUBLIC_KEY is not set we expect a 500 error
      expect(res.type).toMatch(/json/);
      if (res.status === 500) {
        expect(res.body.error).toMatch(/Missing STROWALLET_PUBLIC_KEY/);
      } else {
        expect(typeof res.body).toBe("object");
      }
    }
  }, 20000);
});
