import crypto from "crypto";
import { v4 as uuid } from "uuid";
import { db } from "../db";
import { appendEvent, getLedger, verifyChainIntegrity } from "./ledgerService";

export interface Person {
  id: string;
  full_name: string;
  national_id_hash?: string;
  phone_hash?: string;
  status: string;
  created_at: string;
  updated_at: string;
}

// Never store raw national ID / phone numbers — only a salted hash, so the
// record is verifiable (same input always produces the same hash, so
// duplicate-registration checks still work) without holding the raw PII.
//
// The dev fallback below is intentionally public (it's in this repo's
// history) — fine for local development, but it means anyone can
// precompute hashes for known IDs and de-anonymize this column. In
// production ID_HASH_SALT MUST be set to a real secret, or startup fails.
const DEV_SALT = "africore-dev-salt";

function getSalt(): string {
  const salt = process.env.ID_HASH_SALT;
  if (!salt) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "ID_HASH_SALT is not set. Refusing to start in production with the public dev salt — see .env.example."
      );
    }
    return DEV_SALT;
  }
  return salt;
}

function hashIdentifier(value: string): string {
  return crypto.createHash("sha256").update(`${getSalt()}:${value}`).digest("hex");
}

export function createPerson(input: { full_name: string; national_id?: string; phone?: string }): Person {
  const now = new Date().toISOString();
  const person: Person = {
    id: uuid(),
    full_name: input.full_name,
    national_id_hash: input.national_id ? hashIdentifier(input.national_id) : undefined,
    phone_hash: input.phone ? hashIdentifier(input.phone) : undefined,
    status: "pending_verification",
    created_at: now,
    updated_at: now,
  };

  db.prepare(
    `INSERT INTO persons (id, full_name, national_id_hash, phone_hash, status, created_at, updated_at)
     VALUES (@id, @full_name, @national_id_hash, @phone_hash, @status, @created_at, @updated_at)`
  ).run(person);

  // Never write raw national_id/phone into the ledger event_data — only the hash.
  appendEvent("person", person.id, "person.created", {
    full_name: person.full_name,
    national_id_hash: person.national_id_hash,
  });

  return person;
}

export function getPerson(id: string): Person | undefined {
  return db.prepare(`SELECT * FROM persons WHERE id = ?`).get(id) as Person | undefined;
}

/** Detects if this national ID hash is already registered to a different person. */
export function findDuplicateByNationalId(nationalIdHash: string, excludePersonId: string): Person | undefined {
  return db
    .prepare(`SELECT * FROM persons WHERE national_id_hash = ? AND id != ?`)
    .get(nationalIdHash, excludePersonId) as Person | undefined;
}

export function runPersonVerification(personId: string): { checks: Record<string, boolean>; duplicate: boolean; person: Person } {
  const person = getPerson(personId);
  if (!person) throw new Error("person_not_found");

  const duplicate = person.national_id_hash
    ? !!findDuplicateByNationalId(person.national_id_hash, personId)
    : false;

  const checks = {
    full_name_present: !!person.full_name,
    national_id_present: !!person.national_id_hash,
    no_duplicate_national_id: !duplicate,
  };

  appendEvent("person", personId, "verification.checks_run", { checks });

  const passed = Object.values(checks).every(Boolean);
  const newStatus = passed ? "verified" : "pending_verification";

  if (newStatus !== person.status) {
    db.prepare(`UPDATE persons SET status = ?, updated_at = ? WHERE id = ?`).run(
      newStatus,
      new Date().toISOString(),
      personId
    );
    appendEvent("person", personId, "verification.status_changed", { from: person.status, to: newStatus });
  }

  return { checks, duplicate, person: getPerson(personId)! };
}

export function getPersonTrustRecord(personId: string) {
  const person = getPerson(personId);
  if (!person) return undefined;

  return {
    person,
    verification_history: getLedger("person", personId),
    integrity: verifyChainIntegrity("person", personId),
  };
}