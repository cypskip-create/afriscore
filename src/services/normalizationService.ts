import { RawMpesaTransaction, RawBankTransaction } from "./connectorService";

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

/** Bank's CREDIT/DEBIT + COMPLETED/PENDING/REVERSED vocabulary -> canonical. */
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