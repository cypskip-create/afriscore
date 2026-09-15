import { v4 as uuid } from "uuid";
import { dbAll, dbRun, isPostgres } from "../db";
import { getAccount } from "./accountService";
import { fetchMpesaTransactions, fetchBankTransactions } from "./connectorService";
import { normalizeMpesaTransaction, normalizeBankTransaction, CanonicalTransaction } from "./normalizationService";
import { emitEvent } from "./webhookService";

export interface Transaction extends CanonicalTransaction {
  id: string;
  account_id: string;
  business_id: string;
  created_at: string;
}

// SQLite's "INSERT OR IGNORE" and Postgres's "ON CONFLICT ... DO NOTHING"
// both achieve the same dedup-on-(account_id, external_id) behavior but
// use different syntax, so this is the one query in the codebase that
// genuinely needs an engine branch rather than portable SQL.
const INSERT_SQL = isPostgres
  ? `INSERT INTO transactions
     (id, account_id, business_id, external_id, amount, currency, type, counterparty, category, status, source_provider, raw_status, occurred_at, created_at)
     VALUES (@id, @account_id, @business_id, @external_id, @amount, @currency, @type, @counterparty, @category, @status, @source_provider, @raw_status, @occurred_at, @created_at)
     ON CONFLICT (account_id, external_id) DO NOTHING`
  : `INSERT OR IGNORE INTO transactions
     (id, account_id, business_id, external_id, amount, currency, type, counterparty, category, status, source_provider, raw_status, occurred_at, created_at)
     VALUES (@id, @account_id, @business_id, @external_id, @amount, @currency, @type, @counterparty, @category, @status, @source_provider, @raw_status, @occurred_at, @created_at)`;

/**
 * Pulls raw transactions from the account's provider, normalizes them into
 * the canonical schema, and stores new ones (deduped on account+external_id
 * so re-syncing is safe). Fires a transaction.created webhook per new row.
 */
export async function syncAccountTransactions(accountId: string): Promise<{ synced: number; skipped_duplicates: number; transactions: Transaction[] }> {
  const account = await getAccount(accountId);
  if (!account) throw new Error("account_not_found");

  const raw =
    account.provider === "mpesa"
      ? fetchMpesaTransactions(account.account_identifier).map(normalizeMpesaTransaction)
      : fetchBankTransactions(account.account_identifier).map(normalizeBankTransaction);

  let synced = 0;
  let skipped = 0;
  const inserted: Transaction[] = [];

  for (const canonical of raw) {
    const row = {
      id: uuid(),
      account_id: accountId,
      business_id: account.business_id,
      created_at: new Date().toISOString(),
      ...canonical,
    };
    const result = await dbRun(INSERT_SQL, row);
    if (result.changes > 0) {
      synced++;
      inserted.push(row as Transaction);
      await emitEvent("transaction.created", { transaction_id: row.id, business_id: account.business_id, amount: row.amount, type: row.type });
    } else {
      skipped++;
    }
  }

  return { synced, skipped_duplicates: skipped, transactions: inserted };
}

export async function listTransactionsForBusiness(businessId: string, limit = 100): Promise<Transaction[]> {
  return dbAll<Transaction>(
    `SELECT * FROM transactions WHERE business_id = ? ORDER BY occurred_at DESC LIMIT ?`,
    [businessId, limit]
  );
}