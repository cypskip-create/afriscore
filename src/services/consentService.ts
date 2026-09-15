import { v4 as uuid } from "uuid";
import { dbGet, dbAll, dbRun } from "../db";
import { appendEvent } from "./ledgerService";

export interface Consent {
  id: string;
  subject_type: string;
  subject_id: string;
  grantee: string;
  purpose: string;
  scope: string;
  status: string;
  granted_at: string;
  revoked_at?: string;
}

export async function grantConsent(input: {
  subject_type: "business" | "person";
  subject_id: string;
  grantee: string;
  purpose: string;
  scope: string[];
}): Promise<Consent> {
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

  await dbRun(
    `INSERT INTO consents (id, subject_type, subject_id, grantee, purpose, scope, status, granted_at)
     VALUES (@id, @subject_type, @subject_id, @grantee, @purpose, @scope, @status, @granted_at)`,
    consent
  );

  await appendEvent(input.subject_type, input.subject_id, "consent.granted", {
    consent_id: consent.id,
    grantee: input.grantee,
    purpose: input.purpose,
    scope: input.scope,
  });

  return consent;
}

export async function revokeConsent(consentId: string): Promise<Consent | undefined> {
  const consent = await dbGet<Consent>(`SELECT * FROM consents WHERE id = ?`, [consentId]);
  if (!consent) return undefined;

  const now = new Date().toISOString();
  await dbRun(`UPDATE consents SET status = 'revoked', revoked_at = ? WHERE id = ?`, [now, consentId]);

  await appendEvent(consent.subject_type as "business" | "person", consent.subject_id, "consent.revoked", {
    consent_id: consent.id,
    grantee: consent.grantee,
  });

  return { ...consent, status: "revoked", revoked_at: now };
}

export async function listConsents(subjectType: string, subjectId: string): Promise<Consent[]> {
  return dbAll<Consent>(
    `SELECT * FROM consents WHERE subject_type = ? AND subject_id = ? ORDER BY granted_at DESC`,
    [subjectType, subjectId]
  );
}

export async function isConsentActive(subjectType: string, subjectId: string, grantee: string): Promise<boolean> {
  const row = await dbGet(
    `SELECT * FROM consents WHERE subject_type = ? AND subject_id = ? AND grantee = ? AND status = 'active' ORDER BY granted_at DESC LIMIT 1`,
    [subjectType, subjectId, grantee]
  );
  return !!row;
}