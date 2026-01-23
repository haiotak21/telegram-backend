// Integration-style manual test: set STROWALLET_PUBLIC_KEY and mock axios to simulate provider responses
process.env.STROWALLET_PUBLIC_KEY = 'pub_test';

jest.mock('axios', () => ({
  create: jest.fn(() => ({
    post: jest.fn(async (_url: string, _payload?: any) => ({ data: { ok: true, mocked: true, url: _url, payload: _payload } })),
    put: jest.fn(async (_url: string, _payload?: any) => ({ data: { ok: true, mocked: true, url: _url, payload: _payload } })),
    patch: jest.fn(async (_url: string, _payload?: any) => ({ data: { ok: true, mocked: true, url: _url, payload: _payload } })),
    get: jest.fn(async (_url: string, _opts?: any) => ({ data: { ok: true, mocked: true, url: _url, params: _opts?.params } })),
  })),
}));

import express from 'express';
import request from 'supertest';
import strowalletRouter from '../src/routes/strowallet';

describe('StroWallet proxy provider-mock smoke', () => {
  let app: express.Express;
  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/', strowalletRouter);
  });

  it('should return provider-mocked success responses when public key present', async () => {
    const checks = [
      { method: 'post', path: '/create-user', body: { houseNumber: '1', firstName: 'A', lastName: 'B', idNumber: 'X', customerEmail: 'a@b.com', phoneNumber: '12345678901', dateOfBirth: '01/01/1990', idImage: 'https://example.com/i.png', userPhoto: 'https://example.com/u.png', line1: 'L1', state: 'S', zipCode: 'Z', city: 'C', country: 'CT', idType: 'NIN' } },
      { method: 'post', path: '/create-card', body: { name_on_card: 'Me', card_type: 'visa', amount: '10', customerEmail: 'a@b.com' } },
      { method: 'post', path: '/fund-card', body: { card_id: '1', amount: '5' } },
      { method: 'post', path: '/fetch-card-detail', body: { card_id: '1' } },
      { method: 'post', path: '/card-transactions', body: { card_id: '1' } },
      { method: 'post', path: '/action/status', body: { action: 'freeze', card_id: '1' } },
      { method: 'get', path: '/apicard-transactions', query: { card_id: '1' } },
      { method: 'post', path: '/apicard-transactions', body: { card_id: '1' } },
    ];

    for (const c of checks) {
      let res;
      if (c.method === 'get') res = await request(app).get(c.path).query((c as any).query || {});
      else res = await (request(app) as any)[c.method](c.path).send(c.body || {});

      // Log concise record
      // eslint-disable-next-line no-console
      console.log('INTEGRATION-TEST', c.method.toUpperCase(), c.path, '=>', res.status, JSON.stringify(res.body));

      expect(res.status).toBe(200);
      expect(res.body).toBeDefined();
      expect(res.body.ok).toBe(true);
    }
  }, 20000);
});
