import crypto from "crypto";
import { v4 as uuid } from "uuid";
import { db } from "../db";

const GENESIS_HASH = "0".repeat(64);

interface LedgerEntry {
  id: string;
  subject_type: string;
  subject_id: string;
  event_type: string;
  event_data: string;
  prev_hash: string;
  entry_hash: string;
  created_at: string;
}

function hashEntry(prevHash: string, subjectType: string, subjectId: string, eventType: string, eventData: string, createdAt: string): string {
  const payload = `${prevHash}|${subjectType}|${subjectId}|${eventType}|${eventData}|${createdAt}`;
  return crypto.createHash("sha256").update(payload).digest("hex");
}

function getLastEntry(subjectType: string, subjectId: string): LedgerEntry | undefined {
  return db
    .prepare(
      `SELECT * FROM ledger WHERE subject_type = ? AND subject_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`
    )
    .get(subjectType, subjectId) as LedgerEntry | undefined;
}

/** Append a new tamper-evident event to a subject's trust ledger. */
export function appendEvent(subjectType: "business" | "person", subjectId: string, eventType: string, eventData: object): LedgerEntry {
  const prev = getLastEntry(subjectType, subjectId);
  const prevHash = prev ? prev.entry_hash : GENESIS_HASH;
  const createdAt = new Date().toISOString();
  const dataStr = JSON.stringify(eventData);
  const entryHash = hashEntry(prevHash, subjectType, subjectId, eventType, dataStr, createdAt);

  const entry: LedgerEntry = {
    id: uuid(),
    subject_type: subjectType,
    subject_id: subjectId,
    event_type: eventType,
    event_data: dataStr,
    prev_hash: prevHash,
    entry_hash: entryHash,
    created_at: createdAt,
  };

  db.prepare(
    `INSERT INTO ledger (id, subject_type, subject_id, event_type, event_data, prev_hash, entry_hash, created_at)
     VALUES (@id, @subject_type, @subject_id, @event_type, @event_data, @prev_hash, @entry_hash, @created_at)`
  ).run(entry);

  return entry;
}

export function getLedger(subjectType: "business" | "person", subjectId: string): LedgerEntry[] {
  return db
    .prepare(`SELECT * FROM ledger WHERE subject_type = ? AND subject_id = ? ORDER BY created_at ASC, rowid ASC`)
    .all(subjectType, subjectId) as LedgerEntry[];
}

/** Re-walks the chain and confirms no entry has been altered or reordered. */
export function verifyChainIntegrity(subjectType: "business" | "person", subjectId: string): { valid: boolean; brokenAt?: string; entryCount: number } {
  const entries = getLedger(subjectType, subjectId);
  let expectedPrev = GENESIS_HASH;

  for (const entry of entries) {
    if (entry.prev_hash !== expectedPrev) {
      return { valid: false, brokenAt: entry.id, entryCount: entries.length };
    }
    const recomputed = hashEntry(entry.prev_hash, entry.subject_type, entry.subject_id, entry.event_type, entry.event_data, entry.created_at);
    if (recomputed !== entry.entry_hash) {
      return { valid: false, brokenAt: entry.id, entryCount: entries.length };
    }
    expectedPrev = entry.entry_hash;
  }

  return { valid: true, entryCount: entries.length };
}