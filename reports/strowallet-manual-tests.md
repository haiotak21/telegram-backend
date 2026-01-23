# StroWallet Proxy Manual Test Report

Date: 2026-01-23

Summary

- Test context: Router mounted directly in an express app (no external network calls). `STROWALLET_PUBLIC_KEY` was not set for these runs, so endpoints that require it return a 500 with a clear message. Validation endpoints return Zod validation errors when required fields missing.

Tested endpoints and results (observed):

- POST /create-user
  - Status: 400
  - Response: Zod validation error (missing required fields such as `houseNumber`, `firstName`, `lastName`, etc.).
  - Notes: Schema requires many fields; now accepts `idImage`/`userPhoto` as URL or base64.

- GET /getcardholder
  - Status: 500
  - Response: { ok: false, error: "Missing STROWALLET_PUBLIC_KEY env" }
  - Notes: Endpoint correctly enforces presence of `STROWALLET_PUBLIC_KEY`.

- PUT /updateCardCustomer
  - Status: 500
  - Response: { ok: false, error: "Missing STROWALLET_PUBLIC_KEY env" }
  - Notes: PUT remains available for clients that send full payloads.

- PATCH /updateCardCustomer
  - Status: 500
  - Response: { ok: false, error: "Missing STROWALLET_PUBLIC_KEY env" }
  - Notes: PATCH forwards only provided fields (omits undefined) to provider.

- POST /create-card
  - Status: 500
  - Response: { ok: false, error: "Missing STROWALLET_PUBLIC_KEY env" }
  - Notes: `card_type` now accepts any non-empty string.

- POST /fund-card
  - Status: 500
  - Response: { ok: false, error: "Missing STROWALLET_PUBLIC_KEY env" }

- POST /fetch-card-detail
  - Status: 500
  - Response: { ok: false, error: "Missing STROWALLET_PUBLIC_KEY env" }

- POST /card-transactions
  - Status: 500
  - Response: { ok: false, error: "Missing STROWALLET_PUBLIC_KEY env" }

- POST /action/status
  - Status: 500
  - Response: { ok: false, error: "Missing STROWALLET_PUBLIC_KEY env" }

- GET /apicard-transactions
  - Status: 500
  - Response: { ok: false, error: "Missing STROWALLET_PUBLIC_KEY env" }

- POST /apicard-transactions
  - Status: 500
  - Response: { ok: false, error: "Missing STROWALLET_PUBLIC_KEY env" }

Notes & Recommendations

- The code now supports the requested doc-aligned changes:
  - `card_type` widened to any non-empty string.
  - `UpdateCustomer` supports partial updates and a `PATCH` that forwards only provided fields.
  - `idImage` and `userPhoto` accept either URLs or base64/data URIs.
  - `mode` validation relaxed/normalized across endpoints.
- To exercise provider integration paths, set `STROWALLET_PUBLIC_KEY` in env and run the script again.

Raw logs (excerpt):

```
MANUAL-TEST POST /create-user => 400 {"ok":false,"error":[...zod errors...]}
MANUAL-TEST GET /getcardholder => 500 {"ok":false,"error":"Missing STROWALLET_PUBLIC_KEY env"}
... (see test console output for full JSON lines)
```

Provider-mock run (STROWALLET_PUBLIC_KEY set):

```
INTEGRATION-TEST POST /create-user => 200 {"ok":true,"data":{"ok":true,"mocked":true,"url":"create-user/","payload":{...}}}
INTEGRATION-TEST POST /create-card => 200 {"ok":true,"data":{"ok":true,"mocked":true,"url":"create-card/","payload":{...}}}
INTEGRATION-TEST POST /fund-card => 200 {"ok":true,"data":{"ok":true,"mocked":true,"url":"fund-card/","payload":{...}}}
INTEGRATION-TEST POST /fetch-card-detail => 200 {"ok":true,...}
INTEGRATION-TEST POST /card-transactions => 200 {"ok":true,...}
INTEGRATION-TEST POST /action/status => 200 {"ok":true,...}
INTEGRATION-TEST GET /apicard-transactions => 200 {"ok":true,...}
INTEGRATION-TEST POST /apicard-transactions => 200 {"ok":true,...}
```

File: `__tests__/strowallet.proxy-manual.test.ts` was used to run these checks. The test logs request/response pairs to stdout when executed with Jest.

End of report.
