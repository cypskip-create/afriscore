import crypto from "crypto";
import { v4 as uuid } from "uuid";
import { db } from "../db";

export interface ApiClient {
  id: string;
  name: string;
  api_key_hash: string;
  created_at: string;
}

function hashKey(rawKey: string): string {
  return crypto.createHash("sha256").update(rawKey).digest("hex");
}

/** Creates a new API client (an "application" in AfriCore's Developer Platform sense).
 *  Returns the raw API key exactly once — only the hash is persisted, so this is
 *  the caller's only chance to see it. */
export function createApiClient(name: string): { client: Omit<ApiClient, "api_key_hash">; apiKey: string } {
  const rawKey = `ak_${crypto.randomBytes(24).toString("hex")}`;
  const client: ApiClient = {
    id: uuid(),
    name,
    api_key_hash: hashKey(rawKey),
    created_at: new Date().toISOString(),
  };

  db.prepare(
    `INSERT INTO api_clients (id, name, api_key_hash, created_at) VALUES (@id, @name, @api_key_hash, @created_at)`
  ).run(client);

  return { client: { id: client.id, name: client.name, created_at: client.created_at }, apiKey: rawKey };
}

export function verifyApiKey(rawKey: string): ApiClient | undefined {
  const hash = hashKey(rawKey);
  return db.prepare(`SELECT * FROM api_clients WHERE api_key_hash = ?`).get(hash) as ApiClient | undefined;
}

export function listApiClients(): Omit<ApiClient, "api_key_hash">[] {
  return db.prepare(`SELECT id, name, created_at FROM api_clients ORDER BY created_at DESC`).all() as Omit<
    ApiClient,
    "api_key_hash"
  >[];
}