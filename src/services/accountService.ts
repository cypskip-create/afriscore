import { v4 as uuid } from "uuid";
import { dbGet, dbAll, dbRun } from "../db";
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
  const business = await getBusiness(businessId);
  if (!business) throw new Error("business_not_found");

  const account: Account = {
    id: uuid(),
    business_id: businessId,
    provider,
    account_identifier: accountIdentifier,
    status: "connected",
    connected_at: new Date().toISOString(),
  };

  await dbRun(
    `INSERT INTO accounts (id, business_id, provider, account_identifier, status, connected_at)
     VALUES (@id, @business_id, @provider, @account_identifier, @status, @connected_at)`,
    account
  );

  await appendEvent("business", businessId, "account.connected", { account_id: account.id, provider });
  await emitEvent("account.connected", { account_id: account.id, business_id: businessId, provider });

  return account;
}

export async function getAccount(id: string): Promise<Account | undefined> {
  return dbGet<Account>(`SELECT * FROM accounts WHERE id = ?`, [id]);
}

export async function listAccountsForBusiness(businessId: string): Promise<Account[]> {
  return dbAll<Account>(`SELECT * FROM accounts WHERE business_id = ? ORDER BY connected_at DESC`, [businessId]);
}