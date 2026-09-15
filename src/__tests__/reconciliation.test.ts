import { test, describe } from "node:test";
import assert from "node:assert";
import { findMatch } from "../services/reconciliationService";
import { Invoice } from "../services/invoiceService";
import { Transaction } from "../services/transactionService";

function invoice(amount: number): Invoice {
  return {
    id: "inv-1",
    business_id: "biz-1",
    customer_reference: "Test Customer",
    amount,
    currency: "KES",
    issue_date: new Date().toISOString(),
    status: "unpaid",
    created_at: new Date().toISOString(),
  };
}

function txn(id: string, amount: number): Transaction {
  return {
    id,
    account_id: "acc-1",
    business_id: "biz-1",
    external_id: `ext-${id}`,
    amount,
    currency: "KES",
    type: "credit",
    counterparty: null,
    category: "sales",
    status: "completed",
    source_provider: "mpesa",
    raw_status: "CR",
    occurred_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
  };
}

describe("reconciliation matching", () => {
  test("exact match wins with full confidence", () => {
    const m = findMatch(invoice(5000), [txn("a", 4900), txn("b", 5000)]);
    assert.strictEqual(m?.match_type, "exact");
    assert.strictEqual(m?.confidence, 1);
    assert.deepStrictEqual(m?.transaction_ids, ["b"]);
  });

  test("tolerance match absorbs a small M-Pesa fee shortfall", () => {
    // 5000 invoice, 4970 received: 30 KES short, within 2% (100 cap)
    const m = findMatch(invoice(5000), [txn("a", 4970)]);
    assert.strictEqual(m?.match_type, "tolerance");
    assert.strictEqual(m?.paid_amount, 4970);
    assert.ok(m?.note?.includes("Short by 30.00"));
  });

  test("tolerance is capped in absolute terms on large invoices", () => {
    // 2% of 100000 would be 2000, but the cap is 100 — so 500 short must NOT match
    const m = findMatch(invoice(100000), [txn("a", 99500)]);
    assert.strictEqual(m, null);
  });

  test("tolerance picks the closest candidate when several qualify", () => {
    const m = findMatch(invoice(5000), [txn("far", 4920), txn("near", 4995)]);
    assert.deepStrictEqual(m?.transaction_ids, ["near"]);
  });

  test("partial match combines installment payments", () => {
    const m = findMatch(invoice(10000), [txn("a", 6000), txn("b", 4000)]);
    assert.strictEqual(m?.match_type, "partial");
    assert.strictEqual(m?.paid_amount, 10000);
    assert.strictEqual(m?.transaction_ids.length, 2);
  });

  test("partial match works across three payments", () => {
    const m = findMatch(invoice(9000), [txn("a", 3000), txn("b", 2000), txn("c", 4000)]);
    assert.strictEqual(m?.match_type, "partial");
    assert.strictEqual(m?.transaction_ids.length, 3);
  });

  test("returns null when nothing plausibly matches", () => {
    const m = findMatch(invoice(50000), [txn("a", 100), txn("b", 250)]);
    assert.strictEqual(m, null);
  });

  test("does not match an overpayment beyond tolerance", () => {
    const m = findMatch(invoice(1000), [txn("a", 5000)]);
    assert.strictEqual(m, null);
  });

  test("empty candidate list returns null rather than throwing", () => {
    assert.strictEqual(findMatch(invoice(1000), []), null);
  });

  test("exact match is preferred over a partial combination", () => {
    // 3000 exactly available, but 1000+2000 also sums to 3000
    const m = findMatch(invoice(3000), [txn("a", 1000), txn("b", 2000), txn("exact", 3000)]);
    assert.strictEqual(m?.match_type, "exact");
    assert.deepStrictEqual(m?.transaction_ids, ["exact"]);
  });
});