# StroWallet Proxy

A backend-only proxy to safely call StroWallet APIs and receive webhooks.

## Setup

1. Copy `.env.example` to `.env` and set your `STROWALLET_PUBLIC_KEY`.
2. Install dependencies:

```bash
npm install
```

3. Run in development (hot-reload):

```bash
npm run dev
```

4. Build and start:

```bash
npm run build
npm start
```

## Endpoints

Base: `/api/strowallet`

- `POST /create-user` – Register customer (KYC)
- `GET /getcardholder` – Retrieve customer by id/email
- `PUT /updateCardCustomer` – Update customer details
- `POST /create-card` – Create virtual card
- `POST /fund-card` – Fund card
- `POST /fetch-card-detail` – Card details
- `POST /card-transactions` – Recent transactions
- `POST /action/status` – Freeze/Unfreeze
- `GET /apicard-transactions` – Full history (paginated)

Payments: `/api/payments`

- `POST /verify` – Verify Telebirr or CBE transaction

Wallet: `/api/wallet`

- `GET /config` (admin) – Read active pricing (requires `x-admin-token` if `ADMIN_API_TOKEN` is set)
- `PUT /config` (admin) – Update USDT rate/fees/limits
- `GET /balance/:userId` – Fetch a user's virtual USDT balance
- `POST /deposit/quote` – Preview ETB→USDT conversion with deposit fees
- `POST /topup/quote` – Preview USDT top-up fee and total charge
- `POST /topup` – Deduct USDT balance and fund a card via StroWallet

Admin dashboard

- Visit `/admin` (same server). Enter `x-admin-token`, edit pricing/limits, and run balance/quote/top-up actions using the API above.

Webhook: `POST /api/webhook/strowallet` (raw body). If `STROWALLET_WEBHOOK_SECRET` is set, signature in `x-strowallet-signature` is verified with HMAC-SHA256.

## Notes

- The proxy injects `public_key` from env; clients must not send it.
- All responses normalized: `{ ok: true, data }` or `{ ok: false, error }`.
- Validate inputs with Zod; phone numbers must be numeric international format without `+`.
- Payment verification uses env-configured validator base URL and bearer token. TLS verification stays on by default; set `PAYMENT_VALIDATION_ALLOW_INSECURE=true` only for explicit dev use.

## Payment Verification

- Endpoint: `POST /api/payments/verify`
- Body: `{ "paymentMethod": "telebirr" | "cbe", "transactionNumber": "12345" }`
- Success response (normalized):

```json
{
  "success": true,
  "message": "Verified",
  "provider": "telebirr",
  "transactionNumber": "...",
  "amount": 100,
  "currency": "ETB",
  "status": "completed",
  "raw": {
    /* provider response */
  }
}
```

- Failure response: `{ "success": false, "message": "..." }` with appropriate HTTP status (400 for bad input, 408 on timeout, 5xx when validator unavailable).

### Required env vars

- `PAYMENT_VALIDATION_BASE_URL` – External validator base URL
- `PAYMENT_VALIDATION_TOKEN` – Bearer token for validator
- `TELEBIRR_PHONE_NUMBER` – Telebirr account/phone used for validation
- `CBE_ACCOUNT_NUMBER` – CBE account number
- `CBE_RECEIVER_NAME` – CBE receiver name
- `PAYMENT_VALIDATION_ALLOW_INSECURE` – Set to `true` only in non-prod to bypass TLS verification

### Wallet & pricing env vars

- `ADMIN_API_TOKEN` – Optional shared secret for `/api/wallet/config`
- `STROWALLET_PUBLIC_KEY` – Required to fund cards from the virtual balance

### Dev-only fake validation

If you don't have a real token yet, you can enable a fake validator for local development:

- `PAYMENT_VALIDATION_FAKE=true` – Short-circuits validation and returns a simulated success
- `PAYMENT_VALIDATION_FAKE_AMOUNT=100` – Optional amount to include in the fake response

Note: Fake mode is for local testing only and must not be used in production.

## Telegram Bot

- The service starts a Telegram bot (long-polling) if `TELEGRAM_BOT_TOKEN` is configured.
- Commands:
  - `/linkemail your@example.com` — Link your email for notifications
  - `/linkcard CARD_ID` — Link a specific card id
  - `/unlink` — Remove all links
  - `/status` — Show current links
- Webhook events are stored in MongoDB and used to notify linked chats in real-time.

## Sample Requests (proxy)

Create Customer:

```bash
curl -X POST http://localhost:3000/api/strowallet/create-user \
	-H "Content-Type: application/json" \
	-d '{
		"houseNumber":"12B","firstName":"John","lastName":"Doe","idNumber":"AB123456",
		"customerEmail":"john@example.com","phoneNumber":"2348012345678","dateOfBirth":"01/15/1990",
		"idImage":"https://example.com/id.jpg","userPhoto":"https://example.com/photo.jpg",
		"line1":"123 Main Street","state":"Lagos","zipCode":"100001","city":"Ikeja","country":"NG",
		"idType":"PASSPORT"
	}'
```

Create Card:

```bash
curl -X POST http://localhost:3000/api/strowallet/create-card \
	-H "Content-Type: application/json" \
	-d '{
		"name_on_card":"My Name","card_type":"visa","amount":"5",
		"customerEmail":"mydemo@gmail.com","mode":"sandbox"
	}'
```

Fund Card:

```bash
curl -X POST http://localhost:3000/api/strowallet/fund-card \
	-H "Content-Type: application/json" \
	-d '{"card_id":"CARD_ID","amount":"3","mode":"sandbox"}'
```

Card Details:

```bash
curl -X POST http://localhost:3000/api/strowallet/fetch-card-detail \
	-H "Content-Type: application/json" \
	-d '{"card_id":"CARD_ID","mode":"sandbox"}'
```

Freeze / Unfreeze:

```bash
curl -X POST http://localhost:3000/api/strowallet/action/status \
	-H "Content-Type: application/json" \
	-d '{"action":"freeze","card_id":"CARD_ID"}'
```

Recent Transactions:

```bash
curl -X POST http://localhost:3000/api/strowallet/card-transactions \
	-H "Content-Type: application/json" \
	-d '{"card_id":"CARD_ID","mode":"sandbox"}'
```

Full Card History:

```bash
curl "http://localhost:3000/api/strowallet/apicard-transactions?card_id=CARD_ID&page=1&take=50"
```

Webhook (local test):

```bash
curl -X POST http://localhost:3000/api/webhook/strowallet \
	-H "Content-Type: application/json" \
	-d '{"id":"evt_test","type":"card.funded","data":{"card_id":"CARD123","amount":"5","currency":"USD"}}'
```

Response shape (normalized):

```json
{ "ok": true, "data": { /* provider response */ } }
{ "ok": false, "error": "message" }
```

## Fly.io Deployment (container-friendly)

1. Build and run locally:

```bash
docker build -t strowallet-proxy .
docker run --env-file .env -p 3000:3000 strowallet-proxy
```

2. Fly launch (uses Dockerfile):

```bash
fly launch --no-deploy
fly secrets set STROWALLET_PUBLIC_KEY=... STROWALLET_WEBHOOK_SECRET=... TELEGRAM_BOT_TOKEN=... MONGODB_URI=...
fly deploy
```

3. Example fly.toml (copy as needed):

```toml
app = "strowallet-proxy"
primary_region = "iad"

[build]
	dockerfile = "Dockerfile"

[env]
	PORT = "3000"

[http_service]
	internal_port = 3000
	force_https = true
	auto_stop_machines = true
	auto_start_machines = true
	min_machines_running = 1
```

Point your StroWallet webhook to `https://<your-fly-app>.fly.dev/api/webhook/strowallet`.
