import { dbAll, dbRun } from "../db";
import { Invoice, listInvoicesForBusiness, markInvoicePaid } from "./invoiceService";
import { Transaction } from "./transactionService";
import { appendEvent } from "./ledgerService";
import { emitEvent } from "./webhookService";

export type MatchType = "exact" | "tolerance" | "partial";

export interface Match {
  invoice_id: string;
  transaction_ids: string[];
  invoice_amount: number;
  paid_amount: number;
  match_type: MatchType;
  confidence: number; // 0-1
  note?: string;
}

export interface ReconciliationResult {
  matched: Match[];
  unmatched_invoices: { invoice_id: string; amount: number; reason: string }[];
}

/**
 * Tolerance for "close enough" matching. Real Kenyan payments rarely
 * land on the exact invoiced figure — M-Pesa transaction charges,
 * bank fees, and rounding all shave a little off. A payment within
 * 2% (capped at KES 100) of the invoice is treated as settling it,
 * with the shortfall recorded on the ledger rather than silently
 * ignored.
 */
const TOLERANCE_PCT = 0.02;
const TOLERANCE_MAX_KES = 100;

function toleranceFor(amount: number): number {
  return Math.min(amount * TOLERANCE_PCT, TOLERANCE_MAX_KES);
}

/**
 * Reconciliation engine (spec section 18). Runs three strategies per
 * invoice, in descending order of confidence:
 *
 *   1. exact     — one transaction matching the invoice to the cent
 *   2. tolerance — one transaction within the fee/rounding tolerance
 *   3. partial   — several transactions summing to the invoice
 *                  (within tolerance), i.e. an installment payment
 *
 * Only completed credit transactions not already matched to another
 * invoice are eligible, so a single payment can never settle two
 * invoices. Every match records its type and a confidence score so a
 * reviewing human can audit the low-confidence ones rather than
 * trusting the engine blindly.
 */
export async function reconcileBusiness(businessId: string): Promise<ReconciliationResult> {
  const unpaidInvoices = await listInvoicesForBusiness(businessId, "unpaid");
  const matched: Match[] = [];
  const unmatched: ReconciliationResult["unmatched_invoices"] = [];

  // Track within this run so two invoices can't claim the same payment.
  const claimed = new Set<string>();

  for (const invoice of unpaidInvoices) {
    const candidates = (
      await dbAll<Transaction>(
        `SELECT * FROM transactions
         WHERE business_id = ? AND type = 'credit' AND status = 'completed' AND matched_invoice_id IS NULL
         ORDER BY occurred_at ASC`,
        [businessId]
      )
    ).filter((t) => !claimed.has(t.id));

    const match = findMatch(invoice, candidates);

    if (!match) {
      unmatched.push({
        invoice_id: invoice.id,
        amount: invoice.amount,
        reason: candidates.length === 0 ? "no_unmatched_payments_available" : "no_payment_combination_matched",
      });
      continue;
    }

    for (const txnId of match.transaction_ids) {
      await dbRun(`UPDATE transactions SET matched_invoice_id = ? WHERE id = ?`, [invoice.id, txnId]);
      claimed.add(txnId);
    }
    await markInvoicePaid(invoice.id, match.transaction_ids[0]);

    await appendEvent("business", businessId, "invoice.paid", {
      invoice_id: invoice.id,
      transaction_ids: match.transaction_ids,
      invoice_amount: match.invoice_amount,
      paid_amount: match.paid_amount,
      match_type: match.match_type,
      confidence: match.confidence,
    });
    await emitEvent("invoice.paid", {
      invoice_id: invoice.id,
      business_id: businessId,
      transaction_ids: match.transaction_ids,
      paid_amount: match.paid_amount,
      match_type: match.match_type,
    });

    matched.push(match);
  }

  return { matched, unmatched_invoices: unmatched };
}

/** Pure matching logic — no DB access, so it's directly unit-testable. */
export function findMatch(invoice: Invoice, candidates: Transaction[]): Match | null {
  const tolerance = toleranceFor(invoice.amount);

  // 1. Exact single-transaction match.
  const exact = candidates.find((t) => t.amount === invoice.amount);
  if (exact) {
    return {
      invoice_id: invoice.id,
      transaction_ids: [exact.id],
      invoice_amount: invoice.amount,
      paid_amount: exact.amount,
      match_type: "exact",
      confidence: 1,
    };
  }

  // 2. Single transaction within tolerance (fees/rounding).
  const within = candidates
    .filter((t) => Math.abs(t.amount - invoice.amount) <= tolerance)
    .sort((a, b) => Math.abs(a.amount - invoice.amount) - Math.abs(b.amount - invoice.amount))[0];

  if (within) {
    const diff = invoice.amount - within.amount;
    return {
      invoice_id: invoice.id,
      transaction_ids: [within.id],
      invoice_amount: invoice.amount,
      paid_amount: within.amount,
      match_type: "tolerance",
      confidence: 0.9,
      note:
        diff > 0
          ? `Short by ${diff.toFixed(2)} KES — likely transaction fees or rounding.`
          : `Over by ${Math.abs(diff).toFixed(2)} KES.`,
    };
  }

  // 3. Several transactions summing to the invoice (installments).
  const combo = findCombination(candidates, invoice.amount, tolerance);
  if (combo) {
    const paid = combo.reduce((s, t) => s + t.amount, 0);
    return {
      invoice_id: invoice.id,
      transaction_ids: combo.map((t) => t.id),
      invoice_amount: invoice.amount,
      paid_amount: Math.round(paid * 100) / 100,
      match_type: "partial",
      confidence: 0.75,
      note: `Settled by ${combo.length} separate payments.`,
    };
  }

  return null;
}

/**
 * Finds a subset of transactions summing to the target within
 * tolerance. Capped at combinations of 4 and at 40 candidates —
 * subset-sum is exponential, and an unbounded search would stall the
 * whole request on a business with a busy till. Prefers the fewest
 * transactions, then the closest sum.
 */
function findCombination(candidates: Transaction[], target: number, tolerance: number): Transaction[] | null {
  const pool = candidates.slice(0, 40);
  const maxCombo = 4;

  for (let size = 2; size <= maxCombo; size++) {
    const found = searchCombination(pool, target, tolerance, size, 0, []);
    if (found) return found;
  }
  return null;
}

function searchCombination(
  pool: Transaction[],
  target: number,
  tolerance: number,
  size: number,
  start: number,
  acc: Transaction[]
): Transaction[] | null {
  if (acc.length === size) {
    const sum = acc.reduce((s, t) => s + t.amount, 0);
    return Math.abs(sum - target) <= tolerance ? [...acc] : null;
  }

  for (let i = start; i < pool.length; i++) {
    const partialSum = acc.reduce((s, t) => s + t.amount, 0) + pool[i].amount;
    // Prune: already overshot beyond what tolerance allows.
    if (partialSum - target > tolerance) continue;

    acc.push(pool[i]);
    const result = searchCombination(pool, target, tolerance, size, i + 1, acc);
    acc.pop();
    if (result) return result;
  }

  return null;
}