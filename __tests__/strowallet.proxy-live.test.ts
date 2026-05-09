// Live provider check — non-destructive GET endpoints
import dotenv from 'dotenv';
dotenv.config({ path: '.env' });

import express from 'express';
import request from 'supertest';
import strowalletRouter from '../src/routes/strowallet';

// Skip test unless explicitly enabled
const publicKey = process.env.STROWALLET_PUBLIC_KEY;
const runLiveTests = String(process.env.STROWALLET_RUN_LIVE_TESTS || "").toLowerCase() === "true";

describe('StroWallet proxy live checks (non-destructive)', () => {
  let app: express.Express;

  beforeAll(() => {
    if (!publicKey || !runLiveTests) {
      console.warn('Skipping live checks: STROWALLET_RUN_LIVE_TESTS not enabled or STROWALLET_PUBLIC_KEY missing');
    }
    app = express();
    app.use(express.json());
    app.use('/api/strowallet', strowalletRouter);
  });

  it('GET /getcardholder - should respond (live)', async () => {
    if (!publicKey || !runLiveTests) return;
    const res = await request(app).get('/api/strowallet/getcardholder').query({ customerEmail: 'noone@example.com' });
    // Log for report
    // eslint-disable-next-line no-console
    console.log('LIVE-TEST GET /getcardholder =>', res.status, res.body || res.text);
    expect(res.type).toMatch(/json/);
  }, 20000);

  it('GET /apicard-transactions - should respond (live)', async () => {
    if (!publicKey || !runLiveTests) return;
    const res = await request(app).get('/api/strowallet/apicard-transactions').query({ card_id: '1' });
    // eslint-disable-next-line no-console
    console.log('LIVE-TEST GET /apicard-transactions =>', res.status, res.body || res.text);
    expect(res.type).toMatch(/json/);
  }, 20000);
});
