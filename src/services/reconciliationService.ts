import { db } from "../db";
import { Invoice, listInvoicesForBusiness, markInvoicePaid } from "./invoiceService";
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
 * exact amount match, oldest unmatched transaction first. A production
 * version would widen this to fuzzy amount matching, counterparty name
 * matching, and partial-payment handling — noted as a next step.
 */
export async function reconcileBusiness(businessId: string): Promise<ReconciliationResult> {
  const unpaidInvoices = listInvoicesForBusiness(businessId, "unpaid");
  const matched: ReconciliationResult["matched"] = [];
  const unmatchedInvoices: string[] = [];

  const findMatchStmt = db.prepare(
    `SELECT * FROM transactions
     WHERE business_id = ? AND type = 'credit' AND status = 'completed' AND matched_invoice_id IS NULL AND amount = ?
     ORDER BY occurred_at ASC LIMIT 1`
  );

  for (const invoice of unpaidInvoices) {
    const txn = findMatchStmt.get(businessId, invoice.amount) as Transaction | undefined;

    if (!txn) {
      unmatchedInvoices.push(invoice.id);
      continue;
    }

    db.prepare(`UPDATE transactions SET matched_invoice_id = ? WHERE id = ?`).run(invoice.id, txn.id);
    markInvoicePaid(invoice.id, txn.id);

    appendEvent("business", businessId, "invoice.paid", {
      invoice_id: invoice.id,
      transaction_id: txn.id,
      amount: invoice.amount,
    });
    await emitEvent("invoice.paid", { invoice_id: invoice.id, business_id: businessId, transaction_id: txn.id, amount: invoice.amount });

    matched.push({ invoice_id: invoice.id, transaction_id: txn.id, amount: invoice.amount });
  }

  return { matched, unmatched_invoices: unmatchedInvoices };
}