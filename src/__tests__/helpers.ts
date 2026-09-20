import fs from "fs";
import path from "path";

/**
 * Test environment setup. Must be imported BEFORE any module that loads
 * the DB adapter, since the adapter binds its engine at import time.
 *
 * Engine is chosen by TEST_DATABASE_URL:
 *   unset -> SQLite, using a per-suite throwaway file
 *   set   -> PostgreSQL, using a per-suite schema so suites can't collide
 *
 * `npm test` runs SQLite; `npm run test:pg` runs the same suites against
 * a real Postgres instance. Both must pass before a change ships.
 */
export function configureTestEnv(suiteName: string): { isPg: boolean; sqlitePath: string } {
  const pgUrl = process.env.TEST_DATABASE_URL;

  if (pgUrl) {
    process.env.DATABASE_URL = pgUrl;
    return { isPg: true, sqlitePath: "" };
  }

  delete process.env.DATABASE_URL;
  const sqlitePath = path.join(__dirname, `../../test-${suiteName}.db`);
  process.env.DB_PATH = sqlitePath;
  return { isPg: false, sqlitePath };
}

/**
 * Removes all rows so a suite starts from a known state. Used instead of
 * deleting the SQLite file, which would invalidate the adapter's already
 * open handle (SQLITE_IOERR_FSTAT).
 */
export async function truncateAll(dbRun: (sql: string, params?: any[]) => Promise<any>) {
  const tables = [
    "ledger",
    "consents",
    "transactions",
    "accounts",
    "invoices",
    "webhook_events",
    "webhook_subscriptions",
    "api_clients",
    "businesses",
    "persons",
  ];
  for (const t of tables) {
    await dbRun(`DELETE FROM ${t}`);
  }
}

export function removeSqliteFile(sqlitePath: string) {
  if (!sqlitePath) return;
  for (const suffix of ["", "-shm", "-wal"]) {
    const p = sqlitePath + suffix;
    if (fs.existsSync(p)) {
      try {
        fs.unlinkSync(p);
      } catch {
        /* best effort — the handle may still be open on some platforms */
      }
    }
  }
}