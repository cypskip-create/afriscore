# AfriCore Identity — Phase 1 MVP

The identity & trust wedge for AfriCore. Verifies a business, builds a
tamper-evident trust ledger, computes an explainable trust score, and
gates access to that record behind explicit consent.

# AfriCore — Phase 1 through 7

Phase 1 built the identity & trust wedge. Between-phases hardened it
with real API-key auth. Phase 2 added Data Infrastructure. Phase 3
added Business Operations (invoices + reconciliation) plus gateway
hardening. Phase 4 added Business Intelligence. Phase 5 added a
natural-language query layer and a real PostgreSQL migration. This
added Phase 6: fuzzy reconciliation matching and the first automated
test suite. This adds Phase 7: **route-level integration tests** —
closing the gap where auth and consent gating had only ever been
verified by hand. 42 tests total now, including ones that actively
simulate database tampering and consent-bypass attempts.

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

### Phase 3 — Business Operations
- **Invoice Service** (`invoiceService.ts`) — create/list invoices per business
- **Reconciliation Engine** (`reconciliationService.ts`) — the spec's
  section-18 feature: matches unpaid invoices to unmatched completed
  credit transactions by exact amount, marks the invoice paid, links
  the transaction, logs it to the ledger, fires an `invoice.paid`
  webhook. Deliberately simple matching for Phase 3 (exact amount,
  oldest transaction first) — fuzzy/partial matching is a next step.
- **Rate limiting** (`middleware/rateLimit.ts`) — in-memory fixed-window
  limiter, 120 req/min per API key (or IP if unauthenticated). Swap for
  a Redis-backed limiter before running multiple instances.
- **Signed webhooks** — every subscription now gets a per-subscription
  HMAC secret (`whsec_...`, shown once at subscribe time, never
  re-exposed). Every delivery includes an `x-africore-signature` header
  so a partner can verify the webhook actually came from AfriCore.

### Phase 4 — Business Intelligence
- **Insights Service** (`insightsService.ts`) — four deterministic,
  auditable analyses built on real transaction/invoice data, no AI
  involved (per the spec's own principle: use structured data, not
  generic AI guesses):
  - `getOverdueInvoices` — unpaid invoices past their due date, sorted
    by days overdue
  - `getCashFlowForecast` — linear projection from transaction
    history, with an honest `confidence` rating (low/medium/high)
    based on how much history it's actually built on
  - `getUnusualTransactions` — statistical outliers (>2 standard
    deviations from the business's own mean transaction size), needs
    5+ transactions to compute
  - `getCustomerConcentration` — revenue share by customer, computed
    over paid invoices only
  - This is the data layer an AI/NLP agent (spec section 20/21) would
    eventually query — deliberately kept separate so the *answers*
    stay grounded in code, not model guesswork, even after a real LLM
    is wired in on top.

### Phase 5 — Query Layer + PostgreSQL
- **Query Service** (`queryService.ts`) — `POST /v1/businesses/:id/ask
  {"question": "..."}`. Rule-based keyword-intent matching routes plain-
  language questions to the right Insights Service function. Not a real
  LLM (no API key available to wire one in, and the spec is explicit
  that answers should come from structured data, not model guesswork)
  — every answer is 100% grounded in real data, zero hallucination
  risk, narrower phrasing coverage than a real NLU. Swap
  `matchIntent()` for an LLM call later without touching the data
  layer underneath.
- **Dual-engine DB adapter** (`db/adapter.ts`) — every service calls
  `dbGet`/`dbAll`/`dbRun`/`dbExec` instead of touching a driver
  directly. No `DATABASE_URL` set → SQLite (local dev). `DATABASE_URL`
  set → PostgreSQL, genuinely async via `pg`. Same SQL strings work
  against both engines (the adapter translates `?`/`@name` placeholders
  to Postgres's `$1, $2, ...` transparently) — the one exception is the
  dedup insert in `transactionService.ts`, which needs `INSERT OR
  IGNORE` (SQLite) vs `ON CONFLICT DO NOTHING` (Postgres) since that
  syntax genuinely differs between engines.
- **This was tested against a real, running Postgres instance** — not
  just written and assumed to work. Full flow (business creation,
  verification, duplicate-ID detection, account connection, M-Pesa +
  bank sync and normalization, reconciliation, insights, the ask
  layer, ledger integrity, and re-sync deduplication via `ON CONFLICT`)
  ran clean on both SQLite and Postgres with identical results.

### Phase 6 — Fuzzy Reconciliation + Tests
- **Three-strategy matching** (`reconciliationService.ts`), tried in
  descending confidence order:
  - `exact` (confidence 1.0) — one transaction matching to the cent
  - `tolerance` (0.9) — one transaction within 2% of the invoice,
    capped at KES 100. Real payments rarely land exactly: M-Pesa
    charges, bank fees and rounding all shave a little off. The
    shortfall is recorded in the match note and on the ledger rather
    than silently absorbed.
  - `partial` (0.75) — several transactions summing to the invoice
    within tolerance, i.e. installment payments. Capped at
    combinations of 4 across 40 candidates, since subset-sum is
    exponential and an unbounded search would stall the request on a
    business with a busy till.
  - A payment can only ever settle one invoice (claimed within a run
    and persisted via `matched_invoice_id`), and unmatched invoices
    now return a machine-readable `reason` instead of a bare ID.
  - `findMatch()` is deliberately pure (no DB access) so the matching
    logic is directly unit-testable.
- **Test suite** (`src/__tests__/`) — 22 tests via Node's built-in
  runner, no extra dependencies. Run with `npm test`.
  - `ledger.test.ts` — the ones that matter most: two tests actively
    tamper with the database (editing a stored trust score, deleting a
    middle entry) and assert the chain detects it and names the broken
    entry. The product's core claim, now verified rather than asserted.
  - `reconciliation.test.ts` — all three strategies, the tolerance cap
    on large invoices, preference ordering, and the null cases.
  - `normalization.test.ts` — including a test asserting M-Pesa `CR`
    and bank `CREDIT`/`COMPLETED` produce *identical* canonical output,
    which is the entire justification for the normalization layer.

### Phase 7 — API Integration Tests
- **`app.ts` split out from `index.ts`** — the Express app is now built
  by a `createApp()` factory that binds no port, so tests drive the real
  HTTP stack in-process (routing, auth middleware, consent gating,
  status codes) instead of shelling out to curl against a live server.
  `index.ts` keeps only `migrate()` + `listen()`.
- **`api.test.ts`** — 20 route-level tests. The ones that matter:
  - trust-record rejects no key / forged key / valid key without consent
  - revoking consent cuts off access immediately
  - client A's consent grants client B nothing (consent is per-grantee)
  - `financial-profile`, `insights` and `ask` all enforce the same gate
  - API keys and webhook secrets are never re-exposed after creation
  - a raw national ID never appears in any response body
  - full pipeline: connect → sync → dedupe on re-sync → tolerance-match
    an invoice → financial profile
- **Test isolation fixes** — suites run with `--test-concurrency=1` and a
  `pretest` cleanup step, because each suite binds its own SQLite file
  through a module-level singleton and would otherwise race. (The
  `before` hook deliberately does *not* delete the DB file: the adapter
  already holds an open handle from import time, and deleting it
  mid-run causes `SQLITE_IOERR_FSTAT`.)

## Not built yet (Phase 8+)

Real KRA/M-Pesa/bank institutional integrations (still simulated —
needs partnerships, not code), Payroll/Inventory primitives, a real
LLM wired into the query layer for broader natural-language coverage,
Billing, full sandbox namespace with simulated failure scenarios,
Redis-backed rate limiting for multi-instance deployments, a proper
migration framework (the current guard in `db/index.ts` is fine for
two extra columns but won't scale past a handful of schema changes),
and tests against Postgres specifically (the suite runs on SQLite;
the Postgres path was verified manually against a live instance).

## Run it

```bash
npm install
npm run build
npm start
# server on :4000
# No DATABASE_URL set -> SQLite file at ./africore.db
# DATABASE_URL set     -> PostgreSQL (tested against a real instance)
```

## Test it

```bash
npm test   # builds, then runs 42 tests via Node's built-in runner
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

### Business Operations
- `POST /v1/businesses/:id/invoices` — `{customer_reference, amount, due_date?}`
- `GET /v1/businesses/:id/invoices?status=unpaid` — list, optionally filtered
- `POST /v1/businesses/:id/reconcile` — run matching. Returns
  `{matched, unmatched_invoices}`, where each match carries
  `match_type` (`exact`|`tolerance`|`partial`), a `confidence` score,
  the `transaction_ids` that settled it, and a `note` explaining any
  shortfall — so low-confidence matches can be audited rather than
  trusted blindly.

### Business Intelligence
- `GET /v1/businesses/:id/insights` 🔒 + consent — bundles all four:
  `overdue_invoices`, `cash_flow_forecast`, `unusual_transactions`,
  `customer_concentration`

### Query Layer
- `POST /v1/businesses/:id/ask` 🔒 + consent — `{question: "which invoices are overdue?"}`
  → `{question, matched_intent, answer, data}`. Recognized intents:
  overdue invoices, cash flow forecast, unusual transactions, customer
  concentration, financial profile, trust score. Unmatched questions
  get an honest "couldn't match that" response, never a guess.

## Next build steps

1. Swap simulated connectors for real KRA / M-Pesa Daraja / bank open-banking calls (needs institutional partnerships first)
2. Wire a real LLM into the query layer for broader natural-language coverage (swap `matchIntent()` in `queryService.ts` — the data layer underneath doesn't need to change)
3. Counterparty-name matching to raise confidence on tolerance/partial matches
4. Run the test suite against Postgres in CI, not just SQLite
5. A proper sandbox namespace with simulate-failure scenarios, separate from live data
6. Redis-backed rate limiting once running more than one instance
7. A real migration framework once schema changes outgrow the current PRAGMA-guard approach