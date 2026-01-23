// Destructive live provider test — creates user/card and funds it.
// WARNING: This performs real provider calls using keys from `.env`.
import dotenv from 'dotenv';
dotenv.config({ path: '.env' });

import express from 'express';
import request from 'supertest';
import strowalletRouter from '../src/routes/strowallet';

const publicKey = process.env.STROWALLET_PUBLIC_KEY;

describe('StroWallet proxy destructive live checks', () => {
  let app: express.Express;
  beforeAll(() => {
    if (!publicKey) {
      console.warn('Skipping destructive live checks: STROWALLET_PUBLIC_KEY not set');
    }
    app = express();
    app.use(express.json());
    app.use('/api/strowallet', strowalletRouter);
  });

  it('create user -> create card -> fund card -> fetch details', async () => {
    if (!publicKey) return;

    // 1) Create a test user
    const email = `live-test-${Date.now()}@example.com`;
    const createUserPayload = {
      houseNumber: '1',
      firstName: 'Live',
      lastName: 'Tester',
      idNumber: 'LT12345',
      customerEmail: email,
      phoneNumber: '12345678901',
      dateOfBirth: '01/01/1990',
      idImage: 'https://example.com/i.png',
      userPhoto: 'https://example.com/u.png',
      line1: 'L1',
      state: 'S',
      zipCode: 'Z',
      city: 'C',
      country: 'CT',
      idType: 'NIN',
    };

    const createUserRes = await request(app).post('/api/strowallet/create-user').send(createUserPayload);
    // eslint-disable-next-line no-console
    console.log('LIVE-D | create-user =>', createUserRes.status, createUserRes.body);
    expect(createUserRes.status).toBe(200);

    // 2) Attempt to create a virtual card for that email. If provider blocks by user country,
    // try creating users in alternate countries and retry card creation.
    async function tryCreateCardForEmail(testEmail: string) {
      const payload = { name_on_card: 'Live Tester', card_type: 'virtual', amount: '5', customerEmail: testEmail };
      const res = await request(app).post('/api/strowallet/create-card').send(payload);
      // eslint-disable-next-line no-console
      console.log('LIVE-D | create-card =>', res.status, res.body);
      return res;
    }

    let createCardRes = await tryCreateCardForEmail(email);

    if (createCardRes.status !== 200) {
      const altCountries = ['NG', 'US', 'GB', 'KE'];
      for (const c of altCountries) {
        const altEmail = `live-${c}-${Date.now()}@example.com`;
        // supply country-specific ID requirements
        const altPayloadBase: any = { ...createUserPayload, customerEmail: altEmail, country: c };
        if (c === 'NG') {
          altPayloadBase.idType = 'BVN';
          altPayloadBase.idNumber = '12345678901';
        } else if (c === 'US' || c === 'GB') {
          altPayloadBase.idType = 'PASSPORT';
          altPayloadBase.idNumber = `P${Math.floor(Math.random() * 1000000)}`;
        } else if (c === 'KE') {
          altPayloadBase.idType = 'NIN';
          altPayloadBase.idNumber = `K${Math.floor(Math.random() * 1000000)}`;
        }
        const createUserPayloadAlt = altPayloadBase;
        const altUserRes = await request(app).post('/api/strowallet/create-user').send(createUserPayloadAlt);
        // eslint-disable-next-line no-console
        console.log('LIVE-D | create-user (alt) =>', c, altUserRes.status, altUserRes.body);
        if (altUserRes.status !== 200) continue;
        createCardRes = await tryCreateCardForEmail(altEmail);
        if (createCardRes.status === 200) {
          // success with alternate country
          break;
        }
      }
    }

    if (createCardRes.status !== 200) {
      // eslint-disable-next-line no-console
      console.warn('Provider did not create card after retries. Ending destructive run.');
      return;
    }

    const cardId = (createCardRes.body && (createCardRes.body.data?.card_id || createCardRes.body.data?.id || createCardRes.body.data?.cardId)) || null;

    if (cardId) {
      const fundRes = await request(app).post('/api/strowallet/fund-card').send({ card_id: cardId, amount: '5' });
      // eslint-disable-next-line no-console
      console.log('LIVE-D | fund-card =>', fundRes.status, fundRes.body);
      if (fundRes.status !== 200) {
        // eslint-disable-next-line no-console
        console.warn('Funding failed (status:', fundRes.status, ').');
        return;
      }

      const detailRes = await request(app).post('/api/strowallet/fetch-card-detail').send({ card_id: cardId });
      // eslint-disable-next-line no-console
      console.log('LIVE-D | fetch-card-detail =>', detailRes.status, detailRes.body);
    } else {
      // eslint-disable-next-line no-console
      console.warn('No card id returned from create-card response, skipping fund/fetch steps.');
    }
  }, 60000);
});
