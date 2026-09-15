import Database from "better-sqlite3";
import path from "path";
import { Pool } from "pg";

/**
 * Dual-engine adapter. Every service in this codebase calls dbGet/dbAll/
 * dbRun/dbExec instead of touching a driver directly, so swapping engines
 * never requires touching business logic — just this file and DATABASE_URL.
 *
 * - No DATABASE_URL set -> SQLite (better-sqlite3), synchronous under the
 *   hood but wrapped to return Promises so callers are engine-agnostic.
 * - DATABASE_URL set -> PostgreSQL (pg), genuinely async.
 *
 * SQL is written with SQLite-style placeholders (`?` positional, or
 * `@name` named) in every service file. This adapter translates them to
 * Postgres's `$1, $2, ...` style transparently, so the same query strings
 * work unmodified against either engine.
 */

export const isPostgres = !!process.env.DATABASE_URL;

let sqliteDb: Database.Database | null = null;
let pgPool: Pool | null = null;

if (isPostgres) {
  pgPool = new Pool({ connectionString: process.env.DATABASE_URL });
} else {
  const DB_PATH = process.env.DB_PATH || path.join(__dirname, "../../africore.db");
  sqliteDb = new Database(DB_PATH);
  sqliteDb.pragma("journal_mode = WAL");
}

/** Exposed only for the SQLite-specific migration guard in db/index.ts
 *  (PRAGMA table_info has no portable equivalent worth abstracting). */
export const rawSqliteDb = sqliteDb;

function positionalToDollar(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

function namedToDollar(sql: string, params: Record<string, any>): { sql: string; values: any[] } {
  const order: string[] = [];
  const converted = sql.replace(/@(\w+)/g, (_match, name: string) => {
    order.push(name);
    return `$${order.length}`;
  });
  return { sql: converted, values: order.map((name) => params[name]) };
}

type Params = any[] | Record<string, any>;

export async function dbGet<T = any>(sql: string, params: Params = []): Promise<T | undefined> {
  if (!isPostgres) {
    const stmt = sqliteDb!.prepare(sql);
    return (Array.isArray(params) ? stmt.get(...params) : stmt.get(params)) as T | undefined;
  }
  if (Array.isArray(params)) {
    const res = await pgPool!.query(positionalToDollar(sql), params);
    return res.rows[0];
  }
  const { sql: psql, values } = namedToDollar(sql, params);
  const res = await pgPool!.query(psql, values);
  return res.rows[0];
}

export async function dbAll<T = any>(sql: string, params: Params = []): Promise<T[]> {
  if (!isPostgres) {
    const stmt = sqliteDb!.prepare(sql);
    return (Array.isArray(params) ? stmt.all(...params) : stmt.all(params)) as T[];
  }
  if (Array.isArray(params)) {
    const res = await pgPool!.query(positionalToDollar(sql), params);
    return res.rows;
  }
  const { sql: psql, values } = namedToDollar(sql, params);
  const res = await pgPool!.query(psql, values);
  return res.rows;
}

export async function dbRun(sql: string, params: Params = []): Promise<{ changes: number }> {
  if (!isPostgres) {
    const stmt = sqliteDb!.prepare(sql);
    const info = Array.isArray(params) ? stmt.run(...params) : stmt.run(params);
    return { changes: info.changes };
  }
  if (Array.isArray(params)) {
    const res = await pgPool!.query(positionalToDollar(sql), params);
    return { changes: res.rowCount || 0 };
  }
  const { sql: psql, values } = namedToDollar(sql, params);
  const res = await pgPool!.query(psql, values);
  return { changes: res.rowCount || 0 };
}

/** Raw DDL execution, no parameters — used for schema migration only. */
export async function dbExec(sql: string): Promise<void> {
  if (!isPostgres) {
    sqliteDb!.exec(sql);
    return;
  }
  await pgPool!.query(sql);
}