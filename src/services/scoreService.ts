import { getLedger } from "./ledgerService";

/**
 * Phase 1 trust score: simple and fully explainable, deliberately not
 * a black box. Weighted by verification completeness and ledger
 * longevity (time-in-system as a weak proxy for time-in-business
 * until real transaction/registration-age data is connected).
 *
 * Range: 0-100.
 */
export async function computeTrustScore(businessId: string): Promise<number> {
  const entries = await getLedger("business", businessId);

  const checkEntries = entries.filter((e) => e.event_type === "verification.checks_run");
  let verificationScore = 0;
  if (checkEntries.length > 0) {
    const latest = JSON.parse(checkEntries[checkEntries.length - 1].event_data);
    const checks: Record<string, boolean> = latest.checks || {};
    const total = Object.keys(checks).length || 1;
    const passed = Object.values(checks).filter(Boolean).length;
    verificationScore = (passed / total) * 70; // verification is 70% of score
  }

  const longevityDays = entries.length
    ? (Date.now() - new Date(entries[0].created_at).getTime()) / (1000 * 60 * 60 * 24)
    : 0;
  const longevityScore = Math.min(longevityDays / 365, 1) * 30; // up to 30 pts over a year

  return Math.round(verificationScore + longevityScore);
}