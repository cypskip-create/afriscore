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
  `);
}