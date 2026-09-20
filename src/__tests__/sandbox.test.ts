import { test, describe, before, after } from "node:test";
import assert from "node:assert";
import type { Server } from "http";
import { configureTestEnv, truncateAll, removeSqliteFile } from "./helpers";

const { isPg, sqlitePath } = configureTestEnv("sandbox");

import { migrate, dbRun } from "../db";
import { createApp } from "../app";

let server: Server;
let baseUrl: string;
const originalLog = console.log;

async function api(method: string, urlPath: string, opts: { body?: unknown; apiKey?: string } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.apiKey) headers["x-api-key"] = opts.apiKey;
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* empty body is fine */
  }
  return { status: res.status, body: json };
}

describe("sandbox environment", () => {
  before(async () => {
    await migrate();
    await truncateAll(dbRun);
    console.log = () => {};
    const app = createApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    console.log = originalLog;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    removeSqliteFile(sqlitePath);
  });

  test("sandbox business is flagged and listed separately from live businesses", async () => {
    const sandboxBiz = await api("POST", "/v1/sandbox/businesses", { body: { legal_name: "Sandbox Traders" } });
    assert.strictEqual(sandboxBiz.status, 201);
    assert.strictEqual(sandboxBiz.body.is_sandbox, true);

    const liveBiz = await api("POST", "/v1/businesses", { body: { legal_name: "Live Traders" } });
    assert.strictEqual(liveBiz.body.is_sandbox, false);

    const listed = await api("GET", "/v1/sandbox/businesses");
    const ids = listed.body.map((b: any) => b.id);
    assert.ok(ids.includes(sandboxBiz.body.id), "sandbox business should be listed");
    assert.ok(!ids.includes(liveBiz.body.id), "live business must not appear in sandbox listing");
  });

  test("sandbox person is flagged is_sandbox", async () => {
    const res = await api("POST", "/v1/sandbox/persons", { body: { full_name: "Sandbox Person" } });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.is_sandbox, true);

    const listed = await api("GET", "/v1/sandbox/persons");
    assert.ok(listed.body.some((p: any) => p.id === res.body.id));
  });

  test("sandbox connector: success scenario produces only completed transactions", async () => {
    const biz = await api("POST", "/v1/sandbox/businesses", { body: { legal_name: "Success Scenario Ltd" } });
    const acc = await api("POST", `/v1/businesses/${biz.body.id}/accounts/connect`, {
      body: { provider: "sandbox", account_identifier: "SBX-1", scenario: "success" },
    });
    assert.strictEqual(acc.status, 201);

    await api("POST", `/v1/businesses/${biz.body.id}/accounts/${acc.body.id}/sync`);
    const txns = await api("GET", `/v1/businesses/${biz.body.id}/transactions`);
    assert.ok(txns.body.length > 0);
    assert.ok(txns.body.every((t: any) => t.status === "completed"), "every transaction should complete in the success scenario");
  });

  test("sandbox connector: failure scenario produces only failed transactions", async () => {
    const biz = await api("POST", "/v1/sandbox/businesses", { body: { legal_name: "Failure Scenario Ltd" } });
    const acc = await api("POST", `/v1/businesses/${biz.body.id}/accounts/connect`, {
      body: { provider: "sandbox", account_identifier: "SBX-2", scenario: "failure" },
    });

    await api("POST", `/v1/businesses/${biz.body.id}/accounts/${acc.body.id}/sync`);
    const txns = await api("GET", `/v1/businesses/${biz.body.id}/transactions`);
    assert.ok(txns.body.length > 0);
    assert.ok(txns.body.every((t: any) => t.status === "failed"), "every transaction should fail in the failure scenario");
  });

  test("sandbox connector: duplicate scenario is caught by real dedup logic", async () => {
    const biz = await api("POST", "/v1/sandbox/businesses", { body: { legal_name: "Duplicate Scenario Ltd" } });
    const acc = await api("POST", `/v1/businesses/${biz.body.id}/accounts/connect`, {
      body: { provider: "sandbox", account_identifier: "SBX-3", scenario: "duplicate" },
    });

    const first = await api("POST", `/v1/businesses/${biz.body.id}/accounts/${acc.body.id}/sync`);
    assert.strictEqual(first.body.synced, 1);

    const second = await api("POST", `/v1/businesses/${biz.body.id}/accounts/${acc.body.id}/sync`);
    assert.strictEqual(second.body.synced, 0, "identical external_id must be deduped, not double-counted");
    assert.strictEqual(second.body.skipped_duplicates, 1);
  });

  test("disconnecting an account sets status and disconnected_at", async () => {
    const biz = await api("POST", "/v1/sandbox/businesses", { body: { legal_name: "Disconnect Test Ltd" } });
    const acc = await api("POST", `/v1/businesses/${biz.body.id}/accounts/connect`, {
      body: { provider: "sandbox", account_identifier: "SBX-4", scenario: "success" },
    });
    assert.strictEqual(acc.body.status, "connected");
    assert.ok(acc.body.disconnected_at === null || acc.body.disconnected_at === undefined, "disconnected_at should be unset before disconnecting");

    const disconnected = await api("POST", `/v1/businesses/${biz.body.id}/accounts/${acc.body.id}/disconnect`);
    assert.strictEqual(disconnected.status, 200);
    assert.strictEqual(disconnected.body.status, "disconnected");
    assert.ok(disconnected.body.disconnected_at, "disconnected_at should now be set");
  });

  test("syncing a disconnected account is rejected, not silently skipped", async () => {
    const biz = await api("POST", "/v1/sandbox/businesses", { body: { legal_name: "Sync After Disconnect Ltd" } });
    const acc = await api("POST", `/v1/businesses/${biz.body.id}/accounts/connect`, {
      body: { provider: "sandbox", account_identifier: "SBX-5", scenario: "success" },
    });
    await api("POST", `/v1/businesses/${biz.body.id}/accounts/${acc.body.id}/disconnect`);

    const syncAttempt = await api("POST", `/v1/businesses/${biz.body.id}/accounts/${acc.body.id}/sync`);
    assert.strictEqual(syncAttempt.status, 409);
    assert.strictEqual(syncAttempt.body.error, "account_disconnected");
  });

  test("webhook-test requires an API key", async () => {
    const res = await api("POST", "/v1/sandbox/webhook-test", { body: { target_url: "https://example.com/hook" } });
    assert.strictEqual(res.status, 401);
  });

  test("webhook-test against an unreachable URL reports delivered:false, not a 500", async () => {
    const client = await api("POST", "/v1/clients", { body: { name: "webhook-test-client" } });
    // Port 1 with no listener -> guaranteed connection failure.
    const res = await api("POST", "/v1/sandbox/webhook-test", {
      apiKey: client.body.api_key,
      body: { target_url: "http://127.0.0.1:1/unreachable" },
    });
    assert.strictEqual(res.status, 200, "a bad target URL is a normal test result, not a server error");
    assert.strictEqual(res.body.delivered, false);
    assert.ok(res.body.signature, "should still compute and report the signature that would have been sent");
  });
});