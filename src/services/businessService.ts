import { v4 as uuid } from "uuid";
import { dbGet, dbAll, dbRun } from "../db";
import { appendEvent, getLedger, verifyChainIntegrity } from "./ledgerService";
import { computeTrustScore } from "./scoreService";

export interface Business {
  id: string;
  legal_name: string;
  trading_name?: string;
  registration_number?: string;
  kra_pin?: string;
  jurisdiction: string;
  industry?: string;
  status: string;
  trust_score: number;
  is_sandbox: boolean;
  created_at: string;
  updated_at: string;
}

export async function createBusiness(input: {
  legal_name: string;
  trading_name?: string;
  registration_number?: string;
  kra_pin?: string;
  industry?: string;
  is_sandbox?: boolean;
}): Promise<Business> {
  const now = new Date().toISOString();
  const business = {
    id: uuid(),
    legal_name: input.legal_name,
    trading_name: input.trading_name,
    registration_number: input.registration_number,
    kra_pin: input.kra_pin,
    jurisdiction: "KE",
    industry: input.industry,
    status: "pending_verification",
    trust_score: 0,
    is_sandbox: input.is_sandbox ? 1 : 0,
    created_at: now,
    updated_at: now,
  };

  await dbRun(
    `INSERT INTO businesses (id, legal_name, trading_name, registration_number, kra_pin, jurisdiction, industry, status, trust_score, is_sandbox, created_at, updated_at)
     VALUES (@id, @legal_name, @trading_name, @registration_number, @kra_pin, @jurisdiction, @industry, @status, @trust_score, @is_sandbox, @created_at, @updated_at)`,
    business
  );

  await appendEvent("business", business.id, "business.created", {
    legal_name: business.legal_name,
    registration_number: business.registration_number,
    is_sandbox: !!business.is_sandbox,
  });

  return { ...business, is_sandbox: !!business.is_sandbox };
}

export async function getBusiness(id: string): Promise<Business | undefined> {
  const row = await dbGet<any>(`SELECT * FROM businesses WHERE id = ?`, [id]);
  if (!row) return undefined;
  return { ...row, is_sandbox: !!row.is_sandbox };
}

/**
 * Placeholder verification checks. Phase 1 simulates what would
 * eventually be real calls to KRA / eCitizen / Business Registration
 * Service. Each check independently appends a tamper-evident ledger
 * entry so partial verification progress is always auditable.
 */
export async function runVerificationChecks(businessId: string): Promise<{ checks: Record<string, boolean>; business: Business }> {
  const business = await getBusiness(businessId);
  if (!business) throw new Error("business_not_found");

  const checks = {
    registration_number_present: !!business.registration_number,
    kra_pin_present: !!business.kra_pin,
    legal_name_present: !!business.legal_name,
  };

  await appendEvent("business", businessId, "verification.checks_run", { checks });

  const passed = Object.values(checks).every(Boolean);
  const newStatus = passed ? "verified" : "pending_verification";

  if (newStatus !== business.status) {
    await dbRun(`UPDATE businesses SET status = ?, updated_at = ? WHERE id = ?`, [
      newStatus,
      new Date().toISOString(),
      businessId,
    ]);
    await appendEvent("business", businessId, "verification.status_changed", { from: business.status, to: newStatus });
  }

  const score = await computeTrustScore(businessId);
  await dbRun(`UPDATE businesses SET trust_score = ?, updated_at = ? WHERE id = ?`, [
    score,
    new Date().toISOString(),
    businessId,
  ]);
  await appendEvent("business", businessId, "score.updated", { trust_score: score });

  return { checks, business: (await getBusiness(businessId))! };
}

export async function listSandboxBusinesses(): Promise<Business[]> {
  const rows = await dbAll<any>(`SELECT * FROM businesses WHERE is_sandbox = ? ORDER BY created_at DESC`, [1]);
  return rows.map((r) => ({ ...r, is_sandbox: !!r.is_sandbox }));
}

export async function getTrustRecord(businessId: string) {
  const business = await getBusiness(businessId);
  if (!business) return undefined;

  return {
    business,
    verification_history: await getLedger("business", businessId),
    integrity: await verifyChainIntegrity("business", businessId),
  };
}