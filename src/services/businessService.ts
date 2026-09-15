import { v4 as uuid } from "uuid";
import { dbGet, dbRun } from "../db";
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
  created_at: string;
  updated_at: string;
}

export async function createBusiness(input: {
  legal_name: string;
  trading_name?: string;
  registration_number?: string;
  kra_pin?: string;
  industry?: string;
}): Promise<Business> {
  const now = new Date().toISOString();
  const business: Business = {
    id: uuid(),
    legal_name: input.legal_name,
    trading_name: input.trading_name,
    registration_number: input.registration_number,
    kra_pin: input.kra_pin,
    jurisdiction: "KE",
    industry: input.industry,
    status: "pending_verification",
    trust_score: 0,
    created_at: now,
    updated_at: now,
  };

  await dbRun(
    `INSERT INTO businesses (id, legal_name, trading_name, registration_number, kra_pin, jurisdiction, industry, status, trust_score, created_at, updated_at)
     VALUES (@id, @legal_name, @trading_name, @registration_number, @kra_pin, @jurisdiction, @industry, @status, @trust_score, @created_at, @updated_at)`,
    business
  );

  await appendEvent("business", business.id, "business.created", {
    legal_name: business.legal_name,
    registration_number: business.registration_number,
  });

  return business;
}

export async function getBusiness(id: string): Promise<Business | undefined> {
  return dbGet<Business>(`SELECT * FROM businesses WHERE id = ?`, [id]);
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

export async function getTrustRecord(businessId: string) {
  const business = await getBusiness(businessId);
  if (!business) return undefined;

  return {
    business,
    verification_history: await getLedger("business", businessId),
    integrity: await verifyChainIntegrity("business", businessId),
  };
}