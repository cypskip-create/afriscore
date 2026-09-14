import { v4 as uuid } from "uuid";
import { db } from "../db";
import { appendEvent } from "./ledgerService";

export interface Consent {
  id: string;
  subject_type: string;
  subject_id: string;
  grantee: string;
  purpose: string;
  scope: string; // JSON array
  status: string;
  granted_at: string;
  revoked_at?: string;
}

export function grantConsent(input: {
  subject_type: "business" | "person";
  subject_id: string;
  grantee: string;
  purpose: string;
  scope: string[];
}): Consent {
  const now = new Date().toISOString();
  const consent: Consent = {
    id: uuid(),
    subject_type: input.subject_type,
    subject_id: input.subject_id,
    grantee: input.grantee,
    purpose: input.purpose,
    scope: JSON.stringify(input.scope),
    status: "active",
    granted_at: now,
  };

  db.prepare(
    `INSERT INTO consents (id, subject_type, subject_id, grantee, purpose, scope, status, granted_at)
     VALUES (@id, @subject_type, @subject_id, @grantee, @purpose, @scope, @status, @granted_at)`
  ).run(consent);

  appendEvent(input.subject_type, input.subject_id, "consent.granted", {
    consent_id: consent.id,
    grantee: input.grantee,
    purpose: input.purpose,
    scope: input.scope,
  });

  return consent;
}

export function revokeConsent(consentId: string): Consent | undefined {
  const consent = db.prepare(`SELECT * FROM consents WHERE id = ?`).get(consentId) as Consent | undefined;
  if (!consent) return undefined;

  const now = new Date().toISOString();
  db.prepare(`UPDATE consents SET status = 'revoked', revoked_at = ? WHERE id = ?`).run(now, consentId);

  appendEvent(consent.subject_type as "business" | "person", consent.subject_id, "consent.revoked", {
    consent_id: consent.id,
    grantee: consent.grantee,
  });

  return { ...consent, status: "revoked", revoked_at: now };
}

export function listConsents(subjectType: string, subjectId: string): Consent[] {
  return db
    .prepare(`SELECT * FROM consents WHERE subject_type = ? AND subject_id = ? ORDER BY granted_at DESC`)
    .all(subjectType, subjectId) as Consent[];
}

export function isConsentActive(subjectType: string, subjectId: string, grantee: string): boolean {
  const row = db
    .prepare(
      `SELECT * FROM consents WHERE subject_type = ? AND subject_id = ? AND grantee = ? AND status = 'active' ORDER BY granted_at DESC LIMIT 1`
    )
    .get(subjectType, subjectId, grantee);
  return !!row;
}