import { test, describe } from "node:test";
import assert from "node:assert";
import { normalizeMpesaTransaction, normalizeBankTransaction } from "../services/normalizationService";

describe("normalization", () => {
  test("M-Pesa CR becomes a canonical completed credit", () => {
    const c = normalizeMpesaTransaction({
      MpesaReceiptNumber: "Q123",
      TransactionType: "CustomerPayment",
      Amount: 1500,
      MSISDN: "254712345678",
      TransactionDate: "2026-09-01T10:00:00.000Z",
      ResultDesc: "CR",
    });
    assert.strictEqual(c.type, "credit");
    assert.strictEqual(c.status, "completed");
    assert.strictEqual(c.source_provider, "mpesa");
    assert.strictEqual(c.category, "sales");
    assert.strictEqual(c.raw_status, "CR"); // original preserved for audit
  });

  test("M-Pesa DR becomes a debit", () => {
    const c = normalizeMpesaTransaction({
      MpesaReceiptNumber: "Q124",
      TransactionType: "B2CPayment",
      Amount: 900,
      MSISDN: "254712345678",
      TransactionDate: "2026-09-01T10:00:00.000Z",
      ResultDesc: "DR",
    });
    assert.strictEqual(c.type, "debit");
    assert.strictEqual(c.category, "payout");
  });

  test("M-Pesa FAILED becomes a failed status", () => {
    const c = normalizeMpesaTransaction({
      MpesaReceiptNumber: "Q125",
      TransactionType: "CustomerPayment",
      Amount: 100,
      MSISDN: "254712345678",
      TransactionDate: "2026-09-01T10:00:00.000Z",
      ResultDesc: "FAILED",
    });
    assert.strictEqual(c.status, "failed");
  });

  test("bank CREDIT/COMPLETED maps to the SAME canonical shape as M-Pesa CR", () => {
    const bank = normalizeBankTransaction({
      txnRef: "BNK1",
      narrative: "Supplier payment received",
      debitCredit: "CREDIT",
      txnAmount: 1500,
      valueDate: "2026-09-01T10:00:00.000Z",
      status: "COMPLETED",
    });
    const mpesa = normalizeMpesaTransaction({
      MpesaReceiptNumber: "Q123",
      TransactionType: "CustomerPayment",
      Amount: 1500,
      MSISDN: "254712345678",
      TransactionDate: "2026-09-01T10:00:00.000Z",
      ResultDesc: "CR",
    });
    // This is the whole point of the normalization layer: two providers
    // with totally different vocabularies produce identical canonical fields.
    assert.strictEqual(bank.type, mpesa.type);
    assert.strictEqual(bank.status, mpesa.status);
    assert.strictEqual(bank.amount, mpesa.amount);
    assert.strictEqual(bank.currency, mpesa.currency);
  });

  test("bank REVERSED maps to failed, not completed", () => {
    const c = normalizeBankTransaction({
      txnRef: "BNK2",
      narrative: "Inventory purchase",
      debitCredit: "DEBIT",
      txnAmount: 700,
      valueDate: "2026-09-01T10:00:00.000Z",
      status: "REVERSED",
    });
    assert.strictEqual(c.status, "failed");
    assert.strictEqual(c.type, "debit");
  });

  test("bank PENDING is preserved as pending", () => {
    const c = normalizeBankTransaction({
      txnRef: "BNK3",
      narrative: "Supplier payment received",
      debitCredit: "CREDIT",
      txnAmount: 700,
      valueDate: "2026-09-01T10:00:00.000Z",
      status: "PENDING",
    });
    assert.strictEqual(c.status, "pending");
  });
});