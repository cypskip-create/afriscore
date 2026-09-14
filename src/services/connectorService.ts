import crypto from "crypto";

/**
 * Connector Service. Phase 2 uses simulated data, per the "use synthetic
 * data initially" MVP principle — no real M-Pesa/bank credentials exist
 * yet. Each mock connector deliberately returns a DIFFERENT raw shape
 * (M-Pesa vs bank use different field names and status vocab) so the
 * Normalization Service downstream has real work to do, matching the
 * doc's canonical example: "CR" / "CREDIT" / "CREDIT_TRANSACTION" -> one
 * canonical type.
 *
 * Swap `fetchMpesaTransactions` / `fetchBankTransactions` for real API
 * calls later — nothing downstream needs to change, since both already
 * return provider-tagged raw payloads that flow into the same
 * normalization step.
 */

export interface RawMpesaTransaction {
  MpesaReceiptNumber: string;
  TransactionType: "CustomerPayment" | "B2CPayment";
  Amount: number;
  MSISDN: string; // counterparty phone
  TransactionDate: string; // ISO
  ResultDesc: "CR" | "DR" | "FAILED";
}

export interface RawBankTransaction {
  txnRef: string;
  narrative: string;
  debitCredit: "CREDIT" | "DEBIT";
  txnAmount: number;
  valueDate: string;
  status: "COMPLETED" | "PENDING" | "REVERSED";
}

function seedRandom(seed: string): () => number {
  let h = crypto.createHash("sha256").update(seed).digest();
  let i = 0;
  return () => {
    const byte = h[i % h.length];
    i++;
    return byte / 255;
  };
}

export function fetchMpesaTransactions(accountIdentifier: string, count = 5): RawMpesaTransaction[] {
  const rand = seedRandom(accountIdentifier + "mpesa");
  const out: RawMpesaTransaction[] = [];
  for (let n = 0; n < count; n++) {
    const r = rand();
    out.push({
      MpesaReceiptNumber: `Q${Math.floor(r * 1e9)}`,
      TransactionType: r > 0.5 ? "CustomerPayment" : "B2CPayment",
      Amount: Math.round((r * 20000 + 200) * 100) / 100,
      MSISDN: `2547${Math.floor(r * 1e8)}`.slice(0, 12),
      TransactionDate: new Date(Date.now() - n * 86400000).toISOString(),
      ResultDesc: r > 0.9 ? "FAILED" : r > 0.5 ? "CR" : "DR",
    });
  }
  return out;
}

export function fetchBankTransactions(accountIdentifier: string, count = 5): RawBankTransaction[] {
  const rand = seedRandom(accountIdentifier + "bank");
  const out: RawBankTransaction[] = [];
  for (let n = 0; n < count; n++) {
    const r = rand();
    out.push({
      txnRef: `BNK${Math.floor(r * 1e10)}`,
      narrative: r > 0.5 ? "Supplier payment received" : "Inventory purchase",
      debitCredit: r > 0.5 ? "CREDIT" : "DEBIT",
      txnAmount: Math.round((r * 50000 + 1000) * 100) / 100,
      valueDate: new Date(Date.now() - n * 86400000).toISOString(),
      status: r > 0.92 ? "REVERSED" : "COMPLETED",
    });
  }
  return out;
}