import { dbExec, isPostgres, rawSqliteDb } from "./adapter";

// Table/column types here (TEXT, REAL, INTEGER) are valid in both SQLite
// and PostgreSQL, so one schema string works for both engines — the only
// engine-specific handling needed is the two ADD-COLUMN migration guards
// below, since SQLite and Postgres differ on ALTER TABLE ... IF NOT EXISTS.
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS businesses (
    id TEXT PRIMARY KEY,
    legal_name TEXT NOT NULL,
    trading_name TEXT,
    registration_number TEXT,
    kra_pin TEXT,
    jurisdiction TEXT DEFAULT 'KE',
    industry TEXT,
    status TEXT DEFAULT 'pending_verification',
    trust_score REAL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS persons (
    id TEXT PRIMARY KEY,
    full_name TEXT NOT NULL,
    national_id_hash TEXT,
    phone_hash TEXT,
    status TEXT DEFAULT 'pending_verification',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS ledger (
    id TEXT PRIMARY KEY,
    subject_type TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    event_data TEXT NOT NULL,
    prev_hash TEXT NOT NULL,
    entry_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_ledger_subject ON ledger (subject_type, subject_id, created_at);

  CREATE TABLE IF NOT EXISTS consents (
    id TEXT PRIMARY KEY,
    subject_type TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    grantee TEXT NOT NULL,
    purpose TEXT NOT NULL,
    scope TEXT NOT NULL,
    status TEXT DEFAULT 'active',
    granted_at TEXT NOT NULL,
    revoked_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_consents_subject ON consents (subject_type, subject_id);

  CREATE TABLE IF NOT EXISTS api_clients (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    api_key_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    account_identifier TEXT NOT NULL,
    status TEXT DEFAULT 'connected',
    connected_at TEXT NOT NULL,
    disconnected_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_accounts_business ON accounts (business_id);

  CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    business_id TEXT NOT NULL,
    external_id TEXT NOT NULL,
    amount REAL NOT NULL,
    currency TEXT DEFAULT 'KES',
    type TEXT NOT NULL,
    counterparty TEXT,
    category TEXT,
    status TEXT NOT NULL,
    source_provider TEXT NOT NULL,
    raw_status TEXT,
    occurred_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (account_id, external_id)
  );

  CREATE INDEX IF NOT EXISTS idx_transactions_business ON transactions (business_id, occurred_at);

  CREATE TABLE IF NOT EXISTS webhook_subscriptions (
    id TEXT PRIMARY KEY,
    client_name TEXT NOT NULL,
    event_pattern TEXT NOT NULL,
    target_url TEXT NOT NULL,
    status TEXT DEFAULT 'active',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS webhook_events (
    id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL,
    delivery_attempts INTEGER DEFAULT 0,
    last_delivery_status TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_webhook_events_type ON webhook_events (event_type, created_at);

  CREATE TABLE IF NOT EXISTS invoices (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL,
    customer_reference TEXT NOT NULL,
    amount REAL NOT NULL,
    currency TEXT DEFAULT 'KES',
    issue_date TEXT NOT NULL,
    due_date TEXT,
    status TEXT DEFAULT 'unpaid',
    matched_transaction_id TEXT,
    created_at TEXT NOT NULL,
    paid_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_invoices_business ON invoices (business_id, status);
`;

export async function migrate(): Promise<void> {
  await dbExec(SCHEMA);

  if (isPostgres) {
    await dbExec(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS matched_invoice_id TEXT;`);
    await dbExec(`ALTER TABLE webhook_subscriptions ADD COLUMN IF NOT EXISTS secret TEXT;`);
  } else {
    const transactionCols = rawSqliteDb!.prepare(`PRAGMA table_info(transactions)`).all() as { name: string }[];
    if (!transactionCols.some((c) => c.name === "matched_invoice_id")) {
      rawSqliteDb!.exec(`ALTER TABLE transactions ADD COLUMN matched_invoice_id TEXT`);
    }

    const webhookSubCols = rawSqliteDb!.prepare(`PRAGMA table_info(webhook_subscriptions)`).all() as { name: string }[];
    if (!webhookSubCols.some((c) => c.name === "secret")) {
      rawSqliteDb!.exec(`ALTER TABLE webhook_subscriptions ADD COLUMN secret TEXT`);
    }
  }
}

export { dbGet, dbAll, dbRun, dbExec, isPostgres } from "./adapter";