import { test, describe, before, after } from "node:test";
import assert from "node:assert";
import { configureTestEnv, truncateAll, removeSqliteFile } from "./helpers";

// Must run before any module that loads the DB adapter.
const { sqlitePath } = configureTestEnv("ledger");

import { migrate, dbRun } from "../db";
import { appendEvent, getLedger, verifyChainIntegrity } from "../services/ledgerService";

describe("hash-chained ledger", () => {
  before(async () => {
    await migrate();
    await truncateAll(dbRun);
  });

  after(() => {
    removeSqliteFile(sqlitePath);
  });

  test("first entry chains from the genesis hash", async () => {
    const entry = await appendEvent("business", "biz-genesis", "business.created", { name: "Test" });
    assert.strictEqual(entry.prev_hash, "0".repeat(64));
    assert.strictEqual(entry.entry_hash.length, 64);
  });

  test("each subsequent entry chains from the previous entry's hash", async () => {
    const a = await appendEvent("business", "biz-chain", "business.created", { step: 1 });
    const b = await appendEvent("business", "biz-chain", "verification.checks_run", { step: 2 });
    const c = await appendEvent("business", "biz-chain", "score.updated", { step: 3 });

    assert.strictEqual(b.prev_hash, a.entry_hash);
    assert.strictEqual(c.prev_hash, b.entry_hash);
  });

  test("an untampered chain verifies as valid", async () => {
    await appendEvent("business", "biz-valid", "business.created", { x: 1 });
    await appendEvent("business", "biz-valid", "verification.checks_run", { x: 2 });

    const result = await verifyChainIntegrity("business", "biz-valid");
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.entryCount, 2);
  });

  test("chains for different subjects are independent", async () => {
    await appendEvent("business", "biz-iso-1", "business.created", {});
    await appendEvent("business", "biz-iso-2", "business.created", {});

    const one = await verifyChainIntegrity("business", "biz-iso-1");
    const two = await verifyChainIntegrity("business", "biz-iso-2");
    assert.strictEqual(one.entryCount, 1);
    assert.strictEqual(two.entryCount, 1);
    assert.strictEqual(one.valid && two.valid, true);
  });

  test("TAMPER DETECTION: editing stored event data breaks the chain", async () => {
    await appendEvent("business", "biz-tamper", "business.created", { legal_name: "Honest Traders" });
    await appendEvent("business", "biz-tamper", "score.updated", { trust_score: 40 });

    const before = await verifyChainIntegrity("business", "biz-tamper");
    assert.strictEqual(before.valid, true);

    // Simulate an attacker with direct DB write access inflating a trust
    // score after the fact — exactly the scenario the ledger exists to catch.
    const entries = await getLedger("business", "biz-tamper");
    const target = entries.find((e) => e.event_type === "score.updated")!;
    await dbRun(`UPDATE ledger SET event_data = ? WHERE id = ?`, [
      JSON.stringify({ trust_score: 99 }),
      target.id,
    ]);

    const after = await verifyChainIntegrity("business", "biz-tamper");
    assert.strictEqual(after.valid, false, "tampered chain must NOT verify");
    assert.strictEqual(after.brokenAt, target.id, "should identify which entry was altered");
  });

  test("TAMPER DETECTION: deleting a middle entry breaks the chain", async () => {
    await appendEvent("business", "biz-del", "business.created", { step: 1 });
    await appendEvent("business", "biz-del", "verification.checks_run", { step: 2 });
    await appendEvent("business", "biz-del", "score.updated", { step: 3 });

    const entries = await getLedger("business", "biz-del");
    const middle = entries[1];
    await dbRun(`DELETE FROM ledger WHERE id = ?`, [middle.id]);

    const result = await verifyChainIntegrity("business", "biz-del");
    assert.strictEqual(result.valid, false, "chain with a removed entry must NOT verify");
  });
});