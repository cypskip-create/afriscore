import { RawMpesaTransaction, RawBankTransaction, SandboxTransaction } from "./connectorService";

export interface CanonicalTransaction {
  external_id: string;
  amount: number;
  currency: string;
  type: "credit" | "debit";
  counterparty: string | null;
  category: string | null;
  status: "completed" | "failed" | "pending";
  source_provider: string;
  raw_status: string;
  occurred_at: string;
}

/** M-Pesa's ResultDesc vocabulary -> canonical status/type. */
export function normalizeMpesaTransaction(raw: RawMpesaTransaction): CanonicalTransaction {
  const type: "credit" | "debit" = raw.ResultDesc === "DR" ? "debit" : "credit";
  const status: CanonicalTransaction["status"] = raw.ResultDesc === "FAILED" ? "failed" : "completed";

  return {
    external_id: raw.MpesaReceiptNumber,
    amount: raw.Amount,
    currency: "KES",
    type,
    counterparty: raw.MSISDN,
    category: raw.TransactionType === "CustomerPayment" ? "sales" : "payout",
    status,
    source_provider: "mpesa",
    raw_status: raw.ResultDesc,
    occurred_at: raw.TransactionDate,
  };
}

/** Sandbox transactions are already close to canonical shape — this
 *  mostly just tags the source and fills in the fields real providers
 *  would carry (currency, category) with sandbox defaults. */
export function normalizeSandboxTransaction(raw: SandboxTransaction): CanonicalTransaction {
  return {
    external_id: raw.external_id,
    amount: raw.amount,
    currency: "KES",
    type: raw.type,
    counterparty: null,
    category: raw.type === "credit" ? "sales" : "expenses",
    status: raw.status,
    source_provider: "sandbox",
    raw_status: raw.status,
    occurred_at: raw.occurred_at,
  };
}
export function normalizeBankTransaction(raw: RawBankTransaction): CanonicalTransaction {
  const type: "credit" | "debit" = raw.debitCredit === "CREDIT" ? "credit" : "debit";
  const status: CanonicalTransaction["status"] =
    raw.status === "REVERSED" ? "failed" : raw.status === "PENDING" ? "pending" : "completed";

  return {
    external_id: raw.txnRef,
    amount: raw.txnAmount,
    currency: "KES",
    type,
    counterparty: null,
    category: raw.narrative.toLowerCase().includes("supplier") ? "sales" : "expenses",
    status,
    source_provider: "bank",
    raw_status: raw.status,
    occurred_at: raw.valueDate,
  };
}