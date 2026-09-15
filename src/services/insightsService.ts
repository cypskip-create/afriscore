import { dbAll } from "../db";
import { Invoice } from "./invoiceService";
import { Transaction } from "./transactionService";

/**
 * Business Intelligence layer (spec section 19). Built on real
 * structured data with clearly defined, auditable methodologies — no
 * AI model involved. This is the data layer an AI agent would
 * eventually query; the answers stay grounded in this code.
 */

export interface OverdueInvoice extends Invoice {
  days_overdue: number;
}

/** "Which invoices are overdue?" */
export async function getOverdueInvoices(businessId: string): Promise<OverdueInvoice[]> {
  const now = Date.now();
  const invoices = await dbAll<Invoice>(
    `SELECT * FROM invoices WHERE business_id = ? AND status = 'unpaid' AND due_date IS NOT NULL`,
    [businessId]
  );

  return invoices
    .filter((inv) => new Date(inv.due_date!).getTime() < now)
    .map((inv) => ({
      ...inv,
      days_overdue: Math.floor((now - new Date(inv.due_date!).getTime()) / (1000 * 60 * 60 * 24)),
    }))
    .sort((a, b) => b.days_overdue - a.days_overdue);
}

export interface CashFlowForecast {
  method: string;
  daily_net_cash_flow_avg: number;
  forecast_next_30d: number;
  based_on_days: number;
  confidence: "low" | "medium" | "high";
}

/** "Prepare a cash-flow forecast." Simple linear projection from recent
 *  history. Confidence is reported honestly rather than hidden behind a
 *  single number. */
export async function getCashFlowForecast(businessId: string): Promise<CashFlowForecast> {
  const txns = await dbAll<Transaction>(
    `SELECT * FROM transactions WHERE business_id = ? AND status = 'completed' ORDER BY occurred_at ASC`,
    [businessId]
  );

  if (txns.length === 0) {
    return {
      method: "insufficient_data",
      daily_net_cash_flow_avg: 0,
      forecast_next_30d: 0,
      based_on_days: 0,
      confidence: "low",
    };
  }

  const earliest = new Date(txns[0].occurred_at).getTime();
  const latest = new Date(txns[txns.length - 1].occurred_at).getTime();
  const spanDays = Math.max(1, Math.round((latest - earliest) / (1000 * 60 * 60 * 24)));

  const net = txns.reduce((sum, t) => sum + (t.type === "credit" ? t.amount : -t.amount), 0);
  const dailyAvg = net / spanDays;

  return {
    method: "linear_projection_from_history",
    daily_net_cash_flow_avg: Math.round(dailyAvg * 100) / 100,
    forecast_next_30d: Math.round(dailyAvg * 30 * 100) / 100,
    based_on_days: spanDays,
    confidence: spanDays >= 60 ? "high" : spanDays >= 14 ? "medium" : "low",
  };
}

export interface UnusualTransaction extends Transaction {
  deviation_from_mean: number;
}

/** "Show me unusual transactions." Flags transactions more than 2
 *  standard deviations from the business's own mean transaction size. */
export async function getUnusualTransactions(businessId: string): Promise<UnusualTransaction[]> {
  const txns = await dbAll<Transaction>(`SELECT * FROM transactions WHERE business_id = ? AND status = 'completed'`, [businessId]);

  if (txns.length < 5) return [];

  const amounts = txns.map((t) => t.amount);
  const mean = amounts.reduce((a, b) => a + b, 0) / amounts.length;
  const variance = amounts.reduce((sum, a) => sum + (a - mean) ** 2, 0) / amounts.length;
  const stddev = Math.sqrt(variance);

  if (stddev === 0) return [];

  return txns
    .map((t) => ({ ...t, deviation_from_mean: Math.round(((t.amount - mean) / stddev) * 100) / 100 }))
    .filter((t) => Math.abs(t.deviation_from_mean) > 2)
    .sort((a, b) => Math.abs(b.deviation_from_mean) - Math.abs(a.deviation_from_mean));
}

export interface CustomerConcentration {
  customer_reference: string;
  total_invoiced: number;
  invoice_count: number;
  share_of_total_pct: number;
}

/** "How dependent are we on our largest customer?" */
export async function getCustomerConcentration(businessId: string): Promise<CustomerConcentration[]> {
  const invoices = await dbAll<Invoice>(`SELECT * FROM invoices WHERE business_id = ? AND status = 'paid'`, [businessId]);

  if (invoices.length === 0) return [];

  const totalRevenue = invoices.reduce((sum, i) => sum + i.amount, 0);
  const byCustomer = new Map<string, { total: number; count: number }>();

  for (const inv of invoices) {
    const entry = byCustomer.get(inv.customer_reference) || { total: 0, count: 0 };
    entry.total += inv.amount;
    entry.count += 1;
    byCustomer.set(inv.customer_reference, entry);
  }

  return Array.from(byCustomer.entries())
    .map(([customer_reference, { total, count }]) => ({
      customer_reference,
      total_invoiced: Math.round(total * 100) / 100,
      invoice_count: count,
      share_of_total_pct: Math.round((total / totalRevenue) * 1000) / 10,
    }))
    .sort((a, b) => b.total_invoiced - a.total_invoiced);
}