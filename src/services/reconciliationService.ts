import { dbGet, dbRun } from "../db";
import { listInvoicesForBusiness, markInvoicePaid } from "./invoiceService";
import { Transaction } from "./transactionService";
import { appendEvent } from "./ledgerService";
import { emitEvent } from "./webhookService";

export interface ReconciliationResult {
  matched: { invoice_id: string; transaction_id: string; amount: number }[];
  unmatched_invoices: string[];
}

/**
 * Matches each unpaid invoice to an unmatched, completed, credit
 * transaction with the same amount for the same business. This is the
 * "removes manual reconciliation" feature from the spec (section 18).
 *
 * Matching strategy is deliberately simple and explainable for Phase 3:
 * exact amount match, oldest unmatched transaction first.
 */
export async function reconcileBusiness(businessId: string): Promise<ReconciliationResult> {
  const unpaidInvoices = await listInvoicesForBusiness(businessId, "unpaid");
  const matched: ReconciliationResult["matched"] = [];
  const unmatchedInvoices: string[] = [];

  for (const invoice of unpaidInvoices) {
    const txn = await dbGet<Transaction>(
      `SELECT * FROM transactions
       WHERE business_id = ? AND type = 'credit' AND status = 'completed' AND matched_invoice_id IS NULL AND amount = ?
       ORDER BY occurred_at ASC LIMIT 1`,
      [businessId, invoice.amount]
    );

    if (!txn) {
      unmatchedInvoices.push(invoice.id);
      continue;
    }

    await dbRun(`UPDATE transactions SET matched_invoice_id = ? WHERE id = ?`, [invoice.id, txn.id]);
    await markInvoicePaid(invoice.id, txn.id);

    await appendEvent("business", businessId, "invoice.paid", {
      invoice_id: invoice.id,
      transaction_id: txn.id,
      amount: invoice.amount,
    });
    await emitEvent("invoice.paid", { invoice_id: invoice.id, business_id: businessId, transaction_id: txn.id, amount: invoice.amount });

    matched.push({ invoice_id: invoice.id, transaction_id: txn.id, amount: invoice.amount });
  }

  return { matched, unmatched_invoices: unmatchedInvoices };
}