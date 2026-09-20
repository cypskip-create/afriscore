import { test, describe, before, after } from "node:test";
import assert from "node:assert";
import type { Server } from "http";
import { configureTestEnv, truncateAll, removeSqliteFile } from "./helpers";

// Must run before any module that loads the DB adapter.
const { isPg, sqlitePath } = configureTestEnv("api");

import { migrate, dbRun } from "../db";
import { createApp } from "../app";

let server: Server;
let baseUrl: string;

// Silence per-request logging so test output stays readable.
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
    /* some responses may be empty */
  }
  return { status: res.status, body: json };
}

describe("API routes", () => {
  before(async () => {
    // Truncate rather than delete the file: the adapter opened a handle at
    // import time, and removing it mid-run causes SQLITE_IOERR_FSTAT.
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

  test("health endpoint reports engine", async () => {
    const res = await api("GET", "/v1/health");
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, "ok");
    assert.strictEqual(res.body.db_engine, isPg ? "postgres" : "sqlite");
  });

  test("unknown route returns a structured 404", async () => {
    const res = await api("GET", "/v1/does-not-exist");
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.body.error, "not_found");
  });

  test("business creation validates input", async () => {
    const res = await api("POST", "/v1/businesses", { body: { legal_name: "X" } }); // too short
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error, "invalid_input");
  });

  test("business lifecycle: create, fetch, verify", async () => {
    const created = await api("POST", "/v1/businesses", {
      body: { legal_name: "Test Traders Ltd", registration_number: "R1", kra_pin: "P1" },
    });
    assert.strictEqual(created.status, 201);
    assert.strictEqual(created.body.status, "pending_verification");

    const fetched = await api("GET", `/v1/businesses/${created.body.id}`);
    assert.strictEqual(fetched.status, 200);

    const verified = await api("POST", `/v1/businesses/${created.body.id}/verify`);
    assert.strictEqual(verified.status, 200);
    assert.strictEqual(verified.body.business.status, "verified");
    assert.ok(verified.body.business.trust_score > 0);
  });

  test("fetching a nonexistent business returns 404", async () => {
    const res = await api("GET", "/v1/businesses/00000000-0000-0000-0000-000000000000");
    assert.strictEqual(res.status, 404);
  });

  // --- The security-critical cases ---

  test("trust-record REJECTS a request with no API key", async () => {
    const biz = await api("POST", "/v1/businesses", { body: { legal_name: "Gated Ltd" } });
    const res = await api("GET", `/v1/businesses/${biz.body.id}/trust-record`);
    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.body.error, "missing_api_key");
  });

  test("trust-record REJECTS a forged API key", async () => {
    const biz = await api("POST", "/v1/businesses", { body: { legal_name: "Gated Two Ltd" } });
    const res = await api("GET", `/v1/businesses/${biz.body.id}/trust-record`, { apiKey: "ak_totally_made_up" });
    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.body.error, "invalid_api_key");
  });

  test("trust-record REJECTS a valid key WITHOUT a consent grant", async () => {
    const client = await api("POST", "/v1/clients", { body: { name: "no-consent-client" } });
    const biz = await api("POST", "/v1/businesses", { body: { legal_name: "Unconsented Ltd" } });

    const res = await api("GET", `/v1/businesses/${biz.body.id}/trust-record`, { apiKey: client.body.api_key });
    assert.strictEqual(res.status, 403, "a valid key alone must not grant access");
    assert.strictEqual(res.body.error, "consent_required");
  });

  test("trust-record ALLOWS a valid key WITH an active consent grant", async () => {
    const client = await api("POST", "/v1/clients", { body: { name: "consented-client" } });
    const biz = await api("POST", "/v1/businesses", {
      body: { legal_name: "Consented Ltd", registration_number: "R2", kra_pin: "P2" },
    });
    await api("POST", `/v1/businesses/${biz.body.id}/verify`);
    await api("POST", "/v1/consents", {
      body: {
        subject_type: "business",
        subject_id: biz.body.id,
        grantee: "consented-client",
        purpose: "underwriting",
        scope: ["trust_score"],
      },
    });

    const res = await api("GET", `/v1/businesses/${biz.body.id}/trust-record`, { apiKey: client.body.api_key });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.integrity.valid, true);
    assert.ok(res.body.verification_history.length > 0);
  });

  test("REVOKING consent immediately cuts off access", async () => {
    const client = await api("POST", "/v1/clients", { body: { name: "revoked-client" } });
    const biz = await api("POST", "/v1/businesses", { body: { legal_name: "Revoked Ltd" } });
    const consent = await api("POST", "/v1/consents", {
      body: {
        subject_type: "business",
        subject_id: biz.body.id,
        grantee: "revoked-client",
        purpose: "underwriting",
        scope: ["trust_score"],
      },
    });

    const before = await api("GET", `/v1/businesses/${biz.body.id}/trust-record`, { apiKey: client.body.api_key });
    assert.strictEqual(before.status, 200, "should have access before revocation");

    const revoked = await api("DELETE", `/v1/consents/${consent.body.id}`);
    assert.strictEqual(revoked.status, 200);

    const after = await api("GET", `/v1/businesses/${biz.body.id}/trust-record`, { apiKey: client.body.api_key });
    assert.strictEqual(after.status, 403, "access must be cut off immediately after revocation");
  });

  test("one client's consent does NOT grant access to a different client", async () => {
    const clientA = await api("POST", "/v1/clients", { body: { name: "client-a" } });
    const clientB = await api("POST", "/v1/clients", { body: { name: "client-b" } });
    const biz = await api("POST", "/v1/businesses", { body: { legal_name: "Scoped Ltd" } });

    await api("POST", "/v1/consents", {
      body: {
        subject_type: "business",
        subject_id: biz.body.id,
        grantee: "client-a",
        purpose: "underwriting",
        scope: ["trust_score"],
      },
    });

    const asA = await api("GET", `/v1/businesses/${biz.body.id}/trust-record`, { apiKey: clientA.body.api_key });
    const asB = await api("GET", `/v1/businesses/${biz.body.id}/trust-record`, { apiKey: clientB.body.api_key });

    assert.strictEqual(asA.status, 200);
    assert.strictEqual(asB.status, 403, "consent is per-grantee, not global");
  });

  test("financial-profile and insights enforce the same consent gate", async () => {
    const client = await api("POST", "/v1/clients", { body: { name: "gate-check-client" } });
    const biz = await api("POST", "/v1/businesses", { body: { legal_name: "Gate Check Ltd" } });

    for (const suffix of ["financial-profile", "insights"]) {
      const res = await api("GET", `/v1/businesses/${biz.body.id}/${suffix}`, { apiKey: client.body.api_key });
      assert.strictEqual(res.status, 403, `${suffix} must require consent`);
    }
  });

  test("ask endpoint enforces consent, then answers from real data", async () => {
    const client = await api("POST", "/v1/clients", { body: { name: "ask-client" } });
    const biz = await api("POST", "/v1/businesses", {
      body: { legal_name: "Ask Ltd", registration_number: "R3", kra_pin: "P3" },
    });
    await api("POST", `/v1/businesses/${biz.body.id}/verify`);

    const blocked = await api("POST", `/v1/businesses/${biz.body.id}/ask`, {
      apiKey: client.body.api_key,
      body: { question: "what is our trust score?" },
    });
    assert.strictEqual(blocked.status, 403);

    await api("POST", "/v1/consents", {
      body: {
        subject_type: "business",
        subject_id: biz.body.id,
        grantee: "ask-client",
        purpose: "analysis",
        scope: ["all"],
      },
    });

    const allowed = await api("POST", `/v1/businesses/${biz.body.id}/ask`, {
      apiKey: client.body.api_key,
      body: { question: "what is our trust score?" },
    });
    assert.strictEqual(allowed.status, 200);
    assert.strictEqual(allowed.body.matched_intent, "trust_score");
    assert.ok(allowed.body.answer.includes("Ask Ltd"));
  });

  test("ask declines an unrecognized question instead of guessing", async () => {
    const client = await api("POST", "/v1/clients", { body: { name: "ask-unknown-client" } });
    const biz = await api("POST", "/v1/businesses", { body: { legal_name: "Unknown Q Ltd" } });
    await api("POST", "/v1/consents", {
      body: {
        subject_type: "business",
        subject_id: biz.body.id,
        grantee: "ask-unknown-client",
        purpose: "analysis",
        scope: ["all"],
      },
    });

    const res = await api("POST", `/v1/businesses/${biz.body.id}/ask`, {
      apiKey: client.body.api_key,
      body: { question: "what is the weather in Nairobi" },
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.matched_intent, null);
    assert.strictEqual(res.body.data, null, "must not fabricate data for an unmatched question");
  });

  test("ledger integrity endpoint is public and reports a valid chain", async () => {
    const biz = await api("POST", "/v1/businesses", {
      body: { legal_name: "Public Ledger Ltd", registration_number: "R4", kra_pin: "P4" },
    });
    await api("POST", `/v1/businesses/${biz.body.id}/verify`);

    const res = await api("GET", `/v1/businesses/${biz.body.id}/ledger/verify`);
    assert.strictEqual(res.status, 200, "integrity proof needs no auth");
    assert.strictEqual(res.body.valid, true);
  });

  test("API keys are never returned again after creation", async () => {
    await api("POST", "/v1/clients", { body: { name: "secret-client" } });
    const list = await api("GET", "/v1/clients");
    assert.strictEqual(list.status, 200);
    for (const c of list.body) {
      assert.strictEqual(c.api_key, undefined, "raw key must never be listed");
      assert.strictEqual(c.api_key_hash, undefined, "key hash must never be exposed");
    }
  });

  test("duplicate national ID is rejected at the HTTP layer", async () => {
    const p1 = await api("POST", "/v1/persons", { body: { full_name: "Real Person", national_id: "88887777" } });
    const v1 = await api("POST", `/v1/persons/${p1.body.id}/verify`);
    assert.strictEqual(v1.body.person.status, "verified");

    const p2 = await api("POST", "/v1/persons", { body: { full_name: "Impostor", national_id: "88887777" } });
    const v2 = await api("POST", `/v1/persons/${p2.body.id}/verify`);
    assert.strictEqual(v2.body.duplicate, true);
    assert.strictEqual(v2.body.person.status, "pending_verification", "duplicate must not verify");
  });

  test("raw national ID is never stored or returned", async () => {
    const res = await api("POST", "/v1/persons", { body: { full_name: "Privacy Test", national_id: "12129999" } });
    assert.strictEqual(res.status, 201);
    const serialized = JSON.stringify(res.body);
    assert.ok(!serialized.includes("12129999"), "raw national ID must never appear in a response");
    assert.ok(res.body.national_id_hash.length === 64);
  });

  test("webhook subscription returns a secret once, never on listing", async () => {
    const client = await api("POST", "/v1/clients", { body: { name: "webhook-client" } });
    const sub = await api("POST", "/v1/webhooks", {
      apiKey: client.body.api_key,
      body: { event_pattern: "transaction.*", target_url: "https://example.com/hook" },
    });
    assert.strictEqual(sub.status, 201);
    assert.ok(sub.body.secret.startsWith("whsec_"));

    const list = await api("GET", "/v1/webhooks", { apiKey: client.body.api_key });
    assert.strictEqual(list.status, 200);
    for (const s of list.body) {
      assert.strictEqual(s.secret, undefined, "secret must not be re-exposed on listing");
    }
  });

  test("full data pipeline: connect, sync, normalize, reconcile", async () => {
    const client = await api("POST", "/v1/clients", { body: { name: "pipeline-client" } });
    const biz = await api("POST", "/v1/businesses", {
      body: { legal_name: "Pipeline Ltd", registration_number: "R5", kra_pin: "P5" },
    });
    await api("POST", `/v1/businesses/${biz.body.id}/verify`);
    await api("POST", "/v1/consents", {
      body: {
        subject_type: "business",
        subject_id: biz.body.id,
        grantee: "pipeline-client",
        purpose: "analysis",
        scope: ["all"],
      },
    });

    const acc = await api("POST", `/v1/businesses/${biz.body.id}/accounts/connect`, {
      body: { provider: "mpesa", account_identifier: "254700111222" },
    });
    assert.strictEqual(acc.status, 201);

    const sync = await api("POST", `/v1/businesses/${biz.body.id}/accounts/${acc.body.id}/sync`);
    assert.ok(sync.body.synced > 0, "should ingest transactions");

    // Re-syncing must not duplicate.
    const resync = await api("POST", `/v1/businesses/${biz.body.id}/accounts/${acc.body.id}/sync`);
    assert.strictEqual(resync.body.synced, 0);
    assert.ok(resync.body.skipped_duplicates > 0, "re-sync must dedupe");

    const txns = await api("GET", `/v1/businesses/${biz.body.id}/transactions`);
    const credit = txns.body.find((t: any) => t.type === "credit" && t.status === "completed");
    assert.ok(credit, "should have a normalized completed credit");

    // Invoice 20 KES above the payment -> must still match within tolerance.
    await api("POST", `/v1/businesses/${biz.body.id}/invoices`, {
      body: { customer_reference: "Tolerance Customer", amount: Number((credit.amount + 20).toFixed(2)) },
    });

    const recon = await api("POST", `/v1/businesses/${biz.body.id}/reconcile`);
    assert.strictEqual(recon.body.matched.length, 1);
    assert.strictEqual(recon.body.matched[0].match_type, "tolerance");

    const profile = await api("GET", `/v1/businesses/${biz.body.id}/financial-profile`, {
      apiKey: client.body.api_key,
    });
    assert.strictEqual(profile.status, 200);
    assert.ok(profile.body.total_revenue > 0);
  });
});