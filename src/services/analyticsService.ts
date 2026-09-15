import { dbAll } from "../db";
import { Transaction } from "./transactionService";

export interface FinancialProfile {
  business_id: string;
  currency: string;
  total_revenue: number;
  total_expenses: number;
  net_cash_flow: number;
  transaction_count: number;
  average_transaction_size: number;
  failed_transaction_count: number;
  revenue_last_30d: number;
  revenue_prior_30d: number;
  revenue_growth_pct: number | null;
  computed_at: string;
}

/**
 * Deliberately simple, fully explainable metrics (per the doc's principle:
 * "every metric should have a clearly defined methodology"). Revenue =
 * completed credits, expenses = completed debits. No AI black box here —
 * that belongs in a later AI Service layered on top of this data.
 */
export async function computeFinancialProfile(businessId: string): Promise<FinancialProfile> {
  const txns = await dbAll<Transaction>(`SELECT * FROM transactions WHERE business_id = ?`, [businessId]);

  const completed = txns.filter((t) => t.status === "completed");
  const revenue = completed.filter((t) => t.type === "credit").reduce((sum, t) => sum + t.amount, 0);
  const expenses = completed.filter((t) => t.type === "debit").reduce((sum, t) => sum + t.amount, 0);
  const failed = txns.filter((t) => t.status === "failed").length;

  const now = Date.now();
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;

  const last30 = completed.filter((t) => t.type === "credit" && now - new Date(t.occurred_at).getTime() <= thirtyDaysMs);
  const prior30 = completed.filter(
    (t) =>
      t.type === "credit" &&
      now - new Date(t.occurred_at).getTime() > thirtyDaysMs &&
      now - new Date(t.occurred_at).getTime() <= thirtyDaysMs * 2
  );

  const revenueLast30 = last30.reduce((sum, t) => sum + t.amount, 0);
  const revenuePrior30 = prior30.reduce((sum, t) => sum + t.amount, 0);
  const growthPct = revenuePrior30 > 0 ? Math.round(((revenueLast30 - revenuePrior30) / revenuePrior30) * 1000) / 10 : null;

  return {
    business_id: businessId,
    currency: "KES",
    total_revenue: Math.round(revenue * 100) / 100,
    total_expenses: Math.round(expenses * 100) / 100,
    net_cash_flow: Math.round((revenue - expenses) * 100) / 100,
    transaction_count: txns.length,
    average_transaction_size: txns.length ? Math.round((revenue + expenses) / txns.length * 100) / 100 : 0,
    failed_transaction_count: failed,
    revenue_last_30d: Math.round(revenueLast30 * 100) / 100,
    revenue_prior_30d: Math.round(revenuePrior30 * 100) / 100,
    revenue_growth_pct: growthPct,
    computed_at: new Date().toISOString(),
  };
}