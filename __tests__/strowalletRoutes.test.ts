import express from 'express';
let supertest: any;
let hasSupertest = true;
try {
  // prefer require so missing types don't break local runs
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  supertest = require('supertest');
} catch (e) {
  hasSupertest = false;
}

jest.mock('axios', () => ({
  create: jest.fn(() => ({ post: jest.fn().mockResolvedValue({ data: { ok: true } }), get: jest.fn().mockResolvedValue({ data: { ok: true } }) })),
}));

import strowalletRouter from '../src/routes/strowallet';

(hasSupertest ? describe : describe.skip)('strowallet routes', () => {
  let app: express.Express;

  beforeAll(() => {
    process.env.STROWALLET_PUBLIC_KEY = 'pub_test';
    app = express();
    app.use(express.json());
    app.use('/api/strowallet', strowalletRouter);
  });

  it('create-user delegates to provider', async () => {
    const res = await supertest(app).post('/api/strowallet/create-user').send({
      houseNumber: '1', firstName: 'A', lastName: 'B', idNumber: 'X', customerEmail: 'a@b.com', phoneNumber: '12345678901', dateOfBirth: '01/01/1990', idImage: 'https://example.com/i.png', userPhoto: 'https://example.com/u.png', line1: 'L1', state: 'S', zipCode: 'Z', city: 'C', country: 'CT', idType: 'NIN'
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('apicard-transactions GET requires card_id', async () => {
    const res = await supertest(app).get('/api/strowallet/apicard-transactions');
    // debug: log response to investigate unexpected 500
    // eslint-disable-next-line no-console
    console.log('DEBUG apicard GET:', res.status, 'text=', res.text, 'body=', res.body, 'headers=', res.headers);
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('apicard-transactions POST accepts body card_id', async () => {
    const res = await supertest(app).post('/api/strowallet/apicard-transactions').send({ card_id: 'card1' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
