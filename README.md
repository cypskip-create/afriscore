# AfriCore Identity — Phase 1 MVP

The identity & trust wedge for AfriCore. Verifies a business, builds a
tamper-evident trust ledger, computes an explainable trust score, and
gates access to that record behind explicit consent.

# AfriCore — Phase 1 + Between-Phases + Phase 2

Phase 1 built the identity & trust wedge. This adds the hardening that
sits between phases, plus Phase 2: the Data Infrastructure layer —
connectors, normalization, a unified transaction model, and the
financial-profile API.

## What's built

### Phase 1 — Identity & Trust
- **Business Service** / **Person Service** — register + verify, with a
  duplicate-national-ID fraud check on the person side
- **Ledger Service** — SHA-256 hash-chained event log; every state
  change across the whole platform (verification, consent, account
  connection, score updates) lands here
- **Score Service** — explainable 0–100 trust score
- **Consent Service** — grant/revoke access per (subject, grantee,
  purpose, scope)

### Between Phase 1 and 2 — hardening
- **API-key auth** (`src/middleware/apiKeyAuth.ts`, `apiClientService.ts`) —
  replaces the Phase 1 placeholder `x-client-id` header, which let a
  caller simply declare who they were. Now a real key (`POST
  /v1/clients` to mint one) proves identity server-side; consent checks
  use the key's owner, not a client-supplied header.
- **Public ledger-integrity endpoints** — `GET
  /v1/businesses/:id/ledger/verify` and the person equivalent. No auth
  needed since it only proves the hash chain is unbroken, not business
  data — useful as a standalone trust demo for a partner.

### Phase 2 — Data Infrastructure
- **Connector Service** (`connectorService.ts`) — simulated M-Pesa and
  bank connectors. Deliberately return *different* raw shapes (M-Pesa's
  `CR`/`DR`/`FAILED` vs bank's `CREDIT`/`DEBIT` +
  `COMPLETED`/`PENDING`/`REVERSED`) so normalization has real work to
  do — matching the spec's own example of "CR" / "CREDIT" /
  "CREDIT_TRANSACTION" needing to collapse into one canonical type.
- **Normalization Service** (`normalizationService.ts`) — maps both raw
  shapes into one canonical transaction schema (`credit`/`debit`,
  `completed`/`failed`/`pending`).
- **Account Service** / **Transaction Service** — connect a data
  source to a business, sync (fetch → normalize → dedupe → store),
  each new transaction also fires a webhook.
- **Analytics Service** — computes the Financial Profile: revenue,
  expenses, net cash flow, transaction count, 30-day revenue growth.
  Deliberately simple and auditable, no black-box scoring.
- **Webhook Service** — event-driven infra. Records every event
  regardless of subscribers (so `GET /v1/webhooks/events` always shows
  what happened), attempts best-effort delivery to matching active
  subscriptions, and never lets a delivery failure break the operation
  that triggered it.
- **Developer Platform basics** — `POST /v1/clients` to register and
  get an API key; that's the seed of the fuller dashboard from the
  spec (usage, billing, sandbox UI — still not built).

## Not built yet (Phase 3+)

Real KRA/M-Pesa/bank institutional integrations (still simulated),
Invoice/Payment/Payroll/Inventory primitives, Risk/Analytics beyond the
basic financial profile, AI Service, Billing, PostgreSQL migration
(still SQLite — swap `better-sqlite3` for `pg` in `db/index.ts` when
ready; the schema was written to be portable), full sandbox namespace
with simulated failure scenarios, rate limiting, webhook signing.

## Run it

```bash
npm install
npm run build
npm start
# server on :4000, SQLite file at ./africore.db
```

## API — everything under `/v1`

### Developer Platform
- `POST /v1/clients` — register a client, get an API key (`x-api-key` header for everything below that's marked 🔒)
- `GET /v1/clients` — list registered clients (no keys shown)

### Identity & Trust
- `POST /v1/businesses` / `POST /v1/persons` — register
- `POST /v1/businesses/:id/verify` / `POST /v1/persons/:id/verify` — run checks
- `GET /v1/businesses/:id/trust-record` 🔒 + consent — full record + verification history
- `GET /v1/businesses/:id/ledger/verify` — public hash-chain integrity check
- (persons mirror all of the above under `/v1/persons`)

### Consent
- `POST /v1/consents` — grant `{subject_type, subject_id, grantee, purpose, scope}`
- `DELETE /v1/consents/:id` — revoke
- `GET /v1/consents?subject_type=&subject_id=` — list

### Data Infrastructure
- `POST /v1/businesses/:id/accounts/connect` — `{provider: "mpesa"|"bank", account_identifier}`
- `GET /v1/businesses/:id/accounts` — list connected sources
- `POST /v1/businesses/:id/accounts/:accountId/sync` — pull + normalize + store new transactions
- `GET /v1/businesses/:id/transactions` — normalized transaction list, any provider, one schema
- `GET /v1/businesses/:id/financial-profile` 🔒 + consent — revenue, expenses, cash flow, growth

### Webhooks
- `POST /v1/webhooks` 🔒 — subscribe: `{event_pattern: "transaction.created"|"transaction.*"|..., target_url}`
- `GET /v1/webhooks` 🔒 — list your subscriptions
- `GET /v1/webhooks/events?event_type=` 🔒 — see recently emitted events (sandbox visibility)

## Next build steps

1. Swap simulated connectors for real KRA / M-Pesa Daraja / bank open-banking calls
2. PostgreSQL migration for production deployment
3. Rate limiting + webhook signing (HMAC) on the gateway
4. Invoice/Payment primitives + the reconciliation engine (spec section 18)
5. A proper sandbox namespace with simulate-failure scenarios, separate from live data