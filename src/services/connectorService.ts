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

export type SandboxScenario = "success" | "failure" | "duplicate" | "mixed";

export interface SandboxTransaction {
  external_id: string;
  amount: number;
  type: "credit" | "debit";
  status: "completed" | "failed" | "pending";
  occurred_at: string;
}

/**
 * Sandbox connector (spec section 33): deterministic, developer-chosen
 * outcomes instead of the pseudo-random mix the mpesa/bank connectors
 * produce. A developer picks the scenario when connecting a sandbox
 * account, so they can reliably test how their integration handles
 * each case rather than waiting for a random seed to happen to produce it.
 *
 *   success   — every transaction completes normally
 *   failure   — every transaction fails, to test failure handling
 *   duplicate — the exact same external_id every sync, to test that
 *               re-syncing doesn't double-count (the real dedup logic
 *               runs on this exactly as it would on live data)
 *   mixed     — same behavior as the live mpesa/bank connectors, for
 *               developers who want realistic variety in sandbox
 */
export function fetchSandboxTransactions(accountIdentifier: string, scenario: SandboxScenario, count = 5): SandboxTransaction[] {
  const now = Date.now();

  if (scenario === "duplicate") {
    // Same external_id every call, on purpose — the point is to
    // exercise the dedup path, not to generate variety.
    return [
      { external_id: `SBX-DUP-${accountIdentifier}`, amount: 1000, type: "credit", status: "completed", occurred_at: new Date(now).toISOString() },
    ];
  }

  const out: SandboxTransaction[] = [];
  for (let n = 0; n < count; n++) {
    const status: SandboxTransaction["status"] =
      scenario === "success" ? "completed" : scenario === "failure" ? "failed" : n % 4 === 0 ? "failed" : "completed";

    out.push({
      external_id: `SBX-${accountIdentifier}-${n}`,
      amount: Math.round((500 + n * 137.5) * 100) / 100,
      type: n % 3 === 0 ? "debit" : "credit",
      status,
      occurred_at: new Date(now - n * 86400000).toISOString(),
    });
  }
  return out;
}