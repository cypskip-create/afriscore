import { Router, Request } from "express";
import { z } from "zod";
import { connectAccount, listAccountsForBusiness } from "../services/accountService";
import { syncAccountTransactions, listTransactionsForBusiness } from "../services/transactionService";
import { computeFinancialProfile } from "../services/analyticsService";
import { isConsentActive } from "../services/consentService";
import { requireApiKey, AuthedRequest } from "../middleware/apiKeyAuth";

type BizParams = { id: string; accountId: string };
type BizRequest = Request<BizParams>;

const router = Router({ mergeParams: true });

const connectSchema = z.object({
  provider: z.enum(["mpesa", "bank"]),
  account_identifier: z.string().min(3),
});

// POST /v1/businesses/:id/accounts/connect
router.post("/accounts/connect", async (req: BizRequest, res) => {
  const parsed = connectSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_input", details: parsed.error.flatten() });

  try {
    const account = await connectAccount(req.params.id, parsed.data.provider, parsed.data.account_identifier);
    res.status(201).json(account);
  } catch (e: any) {
    if (e.message === "business_not_found") return res.status(404).json({ error: "not_found" });
    throw e;
  }
});

// GET /v1/businesses/:id/accounts
router.get("/accounts", (req: BizRequest, res) => {
  res.json(listAccountsForBusiness(req.params.id));
});

// POST /v1/businesses/:businessId/accounts/:accountId/sync — pulls + normalizes + stores
router.post("/accounts/:accountId/sync", async (req: BizRequest, res) => {
  try {
    const result = await syncAccountTransactions(req.params.accountId);
    res.json(result);
  } catch (e: any) {
    if (e.message === "account_not_found") return res.status(404).json({ error: "not_found" });
    throw e;
  }
});

// GET /v1/businesses/:id/transactions — raw ledger of normalized transactions
router.get("/transactions", (req: BizRequest, res) => {
  res.json(listTransactionsForBusiness(req.params.id));
});

// GET /v1/businesses/:id/financial-profile — the flagship API from the spec.
// Same consent gate as trust-record: a platform needs an active grant to see it.
router.get("/financial-profile", requireApiKey, (req: AuthedRequest & BizRequest, res) => {
  if (!isConsentActive("business", req.params.id, req.client!.name)) {
    return res.status(403).json({ error: "consent_required", detail: "No active consent for this grantee" });
  }
  res.json(computeFinancialProfile(req.params.id));
});

export default router;