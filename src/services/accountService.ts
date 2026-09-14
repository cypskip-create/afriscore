import { v4 as uuid } from "uuid";
import { db } from "../db";
import { getBusiness } from "./businessService";
import { appendEvent } from "./ledgerService";
import { emitEvent } from "./webhookService";

export interface Account {
  id: string;
  business_id: string;
  provider: string;
  account_identifier: string;
  status: string;
  connected_at: string;
  disconnected_at?: string;
}

export async function connectAccount(businessId: string, provider: "mpesa" | "bank", accountIdentifier: string): Promise<Account> {
  const business = getBusiness(businessId);
  if (!business) throw new Error("business_not_found");

  const account: Account = {
    id: uuid(),
    business_id: businessId,
    provider,
    account_identifier: accountIdentifier,
    status: "connected",
    connected_at: new Date().toISOString(),
  };

  db.prepare(
    `INSERT INTO accounts (id, business_id, provider, account_identifier, status, connected_at)
     VALUES (@id, @business_id, @provider, @account_identifier, @status, @connected_at)`
  ).run(account);

  // Every account connection is also a trust-ledger event — a lender viewing
  // this business's trust record can see which data sources feed its profile.
  appendEvent("business", businessId, "account.connected", { account_id: account.id, provider });
  await emitEvent("account.connected", { account_id: account.id, business_id: businessId, provider });

  return account;
}

export function getAccount(id: string): Account | undefined {
  return db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(id) as Account | undefined;
}

export function listAccountsForBusiness(businessId: string): Account[] {
  return db.prepare(`SELECT * FROM accounts WHERE business_id = ? ORDER BY connected_at DESC`).all(businessId) as Account[];
}