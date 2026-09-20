import crypto from "crypto";
import { v4 as uuid } from "uuid";
import { dbGet, dbAll, dbRun } from "../db";
import { appendEvent, getLedger, verifyChainIntegrity } from "./ledgerService";

export interface Person {
  id: string;
  full_name: string;
  national_id_hash?: string;
  phone_hash?: string;
  status: string;
  is_sandbox: boolean;
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

export async function createPerson(input: { full_name: string; national_id?: string; phone?: string; is_sandbox?: boolean }): Promise<Person> {
  const now = new Date().toISOString();
  const person = {
    id: uuid(),
    full_name: input.full_name,
    national_id_hash: input.national_id ? hashIdentifier(input.national_id) : undefined,
    phone_hash: input.phone ? hashIdentifier(input.phone) : undefined,
    status: "pending_verification",
    is_sandbox: input.is_sandbox ? 1 : 0,
    created_at: now,
    updated_at: now,
  };

  await dbRun(
    `INSERT INTO persons (id, full_name, national_id_hash, phone_hash, status, is_sandbox, created_at, updated_at)
     VALUES (@id, @full_name, @national_id_hash, @phone_hash, @status, @is_sandbox, @created_at, @updated_at)`,
    person
  );

  await appendEvent("person", person.id, "person.created", {
    full_name: person.full_name,
    national_id_hash: person.national_id_hash,
    is_sandbox: !!person.is_sandbox,
  });

  return { ...person, is_sandbox: !!person.is_sandbox };
}

export async function getPerson(id: string): Promise<Person | undefined> {
  const row = await dbGet<any>(`SELECT * FROM persons WHERE id = ?`, [id]);
  if (!row) return undefined;
  return { ...row, is_sandbox: !!row.is_sandbox };
}

export async function listSandboxPersons(): Promise<Person[]> {
  const rows = await dbAll<any>(`SELECT * FROM persons WHERE is_sandbox = ? ORDER BY created_at DESC`, [1]);
  return rows.map((r) => ({ ...r, is_sandbox: !!r.is_sandbox }));
}

/** Detects if this national ID hash is already registered to a different person. */
export async function findDuplicateByNationalId(nationalIdHash: string, excludePersonId: string): Promise<Person | undefined> {
  return dbGet<Person>(`SELECT * FROM persons WHERE national_id_hash = ? AND id != ?`, [nationalIdHash, excludePersonId]);
}

export async function runPersonVerification(personId: string): Promise<{ checks: Record<string, boolean>; duplicate: boolean; person: Person }> {
  const person = await getPerson(personId);
  if (!person) throw new Error("person_not_found");

  const duplicate = person.national_id_hash
    ? !!(await findDuplicateByNationalId(person.national_id_hash, personId))
    : false;

  const checks = {
    full_name_present: !!person.full_name,
    national_id_present: !!person.national_id_hash,
    no_duplicate_national_id: !duplicate,
  };

  await appendEvent("person", personId, "verification.checks_run", { checks });

  const passed = Object.values(checks).every(Boolean);
  const newStatus = passed ? "verified" : "pending_verification";

  if (newStatus !== person.status) {
    await dbRun(`UPDATE persons SET status = ?, updated_at = ? WHERE id = ?`, [
      newStatus,
      new Date().toISOString(),
      personId,
    ]);
    await appendEvent("person", personId, "verification.status_changed", { from: person.status, to: newStatus });
  }

  return { checks, duplicate, person: (await getPerson(personId))! };
}

export async function getPersonTrustRecord(personId: string) {
  const person = await getPerson(personId);
  if (!person) return undefined;

  return {
    person,
    verification_history: await getLedger("person", personId),
    integrity: await verifyChainIntegrity("person", personId),
  };
}