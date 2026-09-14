import { v4 as uuid } from "uuid";
import { db } from "../db";
import { getBusiness } from "./businessService";
import { appendEvent } from "./ledgerService";

export interface Invoice {
  id: string;
  business_id: string;
  customer_reference: string;
  amount: number;
  currency: string;
  issue_date: string;
  due_date?: string;
  status: string; // unpaid | paid | overdue
  matched_transaction_id?: string;
  created_at: string;
  paid_at?: string;
}

export function createInvoice(input: {
  business_id: string;
  customer_reference: string;
  amount: number;
  due_date?: string;
}): Invoice {
  const business = getBusiness(input.business_id);
  if (!business) throw new Error("business_not_found");

  const now = new Date().toISOString();
  const invoice: Invoice = {
    id: uuid(),
    business_id: input.business_id,
    customer_reference: input.customer_reference,
    amount: input.amount,
    currency: "KES",
    issue_date: now,
    due_date: input.due_date,
    status: "unpaid",
    created_at: now,
  };

  db.prepare(
    `INSERT INTO invoices (id, business_id, customer_reference, amount, currency, issue_date, due_date, status, created_at)
     VALUES (@id, @business_id, @customer_reference, @amount, @currency, @issue_date, @due_date, @status, @created_at)`
  ).run(invoice);

  appendEvent("business", input.business_id, "invoice.created", {
    invoice_id: invoice.id,
    amount: invoice.amount,
    customer_reference: invoice.customer_reference,
  });

  return invoice;
}

export function getInvoice(id: string): Invoice | undefined {
  return db.prepare(`SELECT * FROM invoices WHERE id = ?`).get(id) as Invoice | undefined;
}

export function listInvoicesForBusiness(businessId: string, status?: string): Invoice[] {
  if (status) {
    return db
      .prepare(`SELECT * FROM invoices WHERE business_id = ? AND status = ? ORDER BY issue_date DESC`)
      .all(businessId, status) as Invoice[];
  }
  return db.prepare(`SELECT * FROM invoices WHERE business_id = ? ORDER BY issue_date DESC`).all(businessId) as Invoice[];
}

export function markInvoicePaid(invoiceId: string, transactionId: string): Invoice {
  const now = new Date().toISOString();
  db.prepare(`UPDATE invoices SET status = 'paid', matched_transaction_id = ?, paid_at = ? WHERE id = ?`).run(
    transactionId,
    now,
    invoiceId
  );
  return getInvoice(invoiceId)!;
}