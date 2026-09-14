import Database from "better-sqlite3";
import path from "path";

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "../../africore.db");

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

export function migrate() {
  db.exec(`
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

    -- Hash-chained ledger: every verification / trust event is an
    -- immutable, tamper-evident entry. Each entry's hash depends on
    -- the previous entry's hash, so altering history breaks the chain.
    CREATE TABLE IF NOT EXISTS ledger (
      id TEXT PRIMARY KEY,
      subject_type TEXT NOT NULL,       -- 'business' | 'person'
      subject_id TEXT NOT NULL,
      event_type TEXT NOT NULL,         -- e.g. 'verification.kra_pin', 'score.updated'
      event_data TEXT NOT NULL,         -- JSON payload
      prev_hash TEXT NOT NULL,
      entry_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_ledger_subject ON ledger (subject_type, subject_id, created_at);

    -- Consent: who is allowed to view a subject's trust record, and why.
    CREATE TABLE IF NOT EXISTS consents (
      id TEXT PRIMARY KEY,
      subject_type TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      grantee TEXT NOT NULL,            -- platform/partner name or API client id
      purpose TEXT NOT NULL,
      scope TEXT NOT NULL,              -- JSON array of fields e.g. ["trust_score","verification_history"]
      status TEXT DEFAULT 'active',     -- active | revoked
      granted_at TEXT NOT NULL,
      revoked_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_consents_subject ON consents (subject_type, subject_id);

    -- === Between-phases hardening: real API client/key auth ===
    CREATE TABLE IF NOT EXISTS api_clients (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      api_key_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    -- === Phase 2: Data Infrastructure ===

    -- A connected data source (M-Pesa, bank, POS, ...) for a business.
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      business_id TEXT NOT NULL,
      provider TEXT NOT NULL,             -- 'mpesa' | 'bank' | 'pos'
      account_identifier TEXT NOT NULL,   -- masked/display identifier only
      status TEXT DEFAULT 'connected',    -- connected | disconnected
      connected_at TEXT NOT NULL,
      disconnected_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_accounts_business ON accounts (business_id);

    -- Canonical transaction shape. Every provider's raw payload gets mapped
    -- into this schema by the Normalization Service before storage.
    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      business_id TEXT NOT NULL,
      external_id TEXT NOT NULL,          -- provider's own transaction id, for dedup
      amount REAL NOT NULL,
      currency TEXT DEFAULT 'KES',
      type TEXT NOT NULL,                 -- 'credit' | 'debit'
      counterparty TEXT,
      category TEXT,
      status TEXT NOT NULL,               -- normalized: 'completed' | 'failed' | 'pending'
      source_provider TEXT NOT NULL,
      raw_status TEXT,                    -- original provider status string, kept for audit
      occurred_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (account_id, external_id)
    );

    CREATE INDEX IF NOT EXISTS idx_transactions_business ON transactions (business_id, occurred_at);

    CREATE TABLE IF NOT EXISTS webhook_subscriptions (
      id TEXT PRIMARY KEY,
      client_name TEXT NOT NULL,
      event_pattern TEXT NOT NULL,        -- exact event type, or 'event.*' prefix match
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

    -- === Phase 3: Business Operations ===
    CREATE TABLE IF NOT EXISTS invoices (
      id TEXT PRIMARY KEY,
      business_id TEXT NOT NULL,
      customer_reference TEXT NOT NULL,
      amount REAL NOT NULL,
      currency TEXT DEFAULT 'KES',
      issue_date TEXT NOT NULL,
      due_date TEXT,
      status TEXT DEFAULT 'unpaid',       -- unpaid | paid | overdue
      matched_transaction_id TEXT,
      created_at TEXT NOT NULL,
      paid_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_invoices_business ON invoices (business_id, status);
  `);

  // Lightweight migration guard: adds columns to tables that may already
  // exist from an earlier version of the schema, without needing a full
  // migration framework at this stage. Safe to run on every boot.
  const transactionCols = db.prepare(`PRAGMA table_info(transactions)`).all() as { name: string }[];
  if (!transactionCols.some((c) => c.name === "matched_invoice_id")) {
    db.exec(`ALTER TABLE transactions ADD COLUMN matched_invoice_id TEXT`);
  }

  const webhookSubCols = db.prepare(`PRAGMA table_info(webhook_subscriptions)`).all() as { name: string }[];
  if (!webhookSubCols.some((c) => c.name === "secret")) {
    db.exec(`ALTER TABLE webhook_subscriptions ADD COLUMN secret TEXT`);
  }
}