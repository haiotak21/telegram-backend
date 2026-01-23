# CBE Verifier Custom

Custom TypeScript library to verify CBE (Commercial Bank of Ethiopia) transactions by id, message, or verification link, detect ids from images, and parse receipt PDFs.

## Install

```bash
pnpm install
```

## Build

```bash
pnpm run compile
```

## Test

```bash
pnpm test
```

## Usage

```ts
import { verify } from "cbe-verifier-custom";

// By link
await verify({
  link: "https://apps.cbe.com.et:100/?id=FT26015S1WKK73850447",
  timeoutMs: 30000,
});

// By SMS message (id/link auto-extracted)
await verify({
  message: "Dear ... https://apps.cbe.com.et:100/?id=FT26015S1WKK73850447 ...",
});

// By id
await verify({
  transactionId: "FT26015S1WKK73850447",
  cbeVerificationUrl: "https://apps.cbe.com.et:100/",
});
```

## API

- `verify(request: VerifyRequest): Promise<Either<VerifyFailure, TransactionDetail>>`

  - `VerifyRequest`: `transactionId?`, `message?`, `link?`, `accountNumberOfSenderOrReceiver?`, `cbeVerificationUrl?`, `timeoutMs?`
  - `VerifyFailure`: `INVALID_TRANSACTION_ID | INVALID_ACCOUNT_NO | TRANSACTION_NOT_FOUND | API_REQUEST_FAILED`
  - `TransactionDetail`: `{ fullText, amount?, payer?, receiver?, reference?, payerAccount?, receiverAccount?, reason?, date? }`

- `detectTransactionId(buffer, { googleVisionAPIKey? })`
  - Returns `{ value, detectedFrom: 'QR_CODE' | 'TEXT_RECOGNITION', timeTaken }` or `null`.

## Notes

- Requires network access to `https://apps.cbe.com.et:100/` (often geo-restricted).
- `timeoutMs` can be raised if the endpoint is slow (e.g., 30000 ms).
- Axios body limits are disabled to allow large PDFs.
