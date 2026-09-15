import { Router, Request } from "express";
import { z } from "zod";
import { connectAccount, listAccountsForBusiness } from "../services/accountService";
import { syncAccountTransactions, listTransactionsForBusiness } from "../services/transactionService";
import { computeFinancialProfile } from "../services/analyticsService";
import { isConsentActive } from "../services/consentService";
import { requireApiKey, AuthedRequest } from "../middleware/apiKeyAuth";
import { createInvoice, listInvoicesForBusiness } from "../services/invoiceService";
import { reconcileBusiness } from "../services/reconciliationService";
import { getOverdueInvoices, getCashFlowForecast, getUnusualTransactions, getCustomerConcentration } from "../services/insightsService";
import { answerQuestion } from "../services/queryService";

type BizParams = { id: string; accountId: string };
type BizRequest = Request<BizParams>;

const router = Router({ mergeParams: true });

const connectSchema = z.object({
  provider: z.enum(["mpesa", "bank"]),
  account_identifier: z.string().min(3),
});

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

router.get("/accounts", async (req: BizRequest, res) => {
  res.json(await listAccountsForBusiness(req.params.id));
});

router.post("/accounts/:accountId/sync", async (req: BizRequest, res) => {
  try {
    const result = await syncAccountTransactions(req.params.accountId);
    res.json(result);
  } catch (e: any) {
    if (e.message === "account_not_found") return res.status(404).json({ error: "not_found" });
    throw e;
  }
});

router.get("/transactions", async (req: BizRequest, res) => {
  res.json(await listTransactionsForBusiness(req.params.id));
});

router.get("/financial-profile", requireApiKey, async (req: AuthedRequest & BizRequest, res) => {
  if (!(await isConsentActive("business", req.params.id, req.client!.name))) {
    return res.status(403).json({ error: "consent_required", detail: "No active consent for this grantee" });
  }
  res.json(await computeFinancialProfile(req.params.id));
});

// === Phase 3: Business Operations ===

const invoiceSchema = z.object({
  customer_reference: z.string().min(1),
  amount: z.number().positive(),
  due_date: z.string().optional(),
});

router.post("/invoices", async (req: BizRequest, res) => {
  const parsed = invoiceSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_input", details: parsed.error.flatten() });

  try {
    const invoice = await createInvoice({ business_id: req.params.id, ...parsed.data });
    res.status(201).json(invoice);
  } catch (e: any) {
    if (e.message === "business_not_found") return res.status(404).json({ error: "not_found" });
    throw e;
  }
});

router.get("/invoices", async (req: BizRequest, res) => {
  const status = req.query.status ? String(req.query.status) : undefined;
  res.json(await listInvoicesForBusiness(req.params.id, status));
});

router.post("/reconcile", async (req: BizRequest, res) => {
  const result = await reconcileBusiness(req.params.id);
  res.json(result);
});

// === Phase 4: Business Intelligence ===

router.get("/insights", requireApiKey, async (req: AuthedRequest & BizRequest, res) => {
  if (!(await isConsentActive("business", req.params.id, req.client!.name))) {
    return res.status(403).json({ error: "consent_required", detail: "No active consent for this grantee" });
  }

  res.json({
    overdue_invoices: await getOverdueInvoices(req.params.id),
    cash_flow_forecast: await getCashFlowForecast(req.params.id),
    unusual_transactions: await getUnusualTransactions(req.params.id),
    customer_concentration: await getCustomerConcentration(req.params.id),
  });
});

// === Phase 5: Query Layer ===
// POST /v1/businesses/:id/ask {"question": "which invoices are overdue?"}
// Same consent gate — this exposes the same sensitive business data as
// /insights and /financial-profile, just through a natural-language door.
const askSchema = z.object({ question: z.string().min(3) });

router.post("/ask", requireApiKey, async (req: AuthedRequest & BizRequest, res) => {
  const parsed = askSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_input", details: parsed.error.flatten() });

  if (!(await isConsentActive("business", req.params.id, req.client!.name))) {
    return res.status(403).json({ error: "consent_required", detail: "No active consent for this grantee" });
  }

  try {
    const result = await answerQuestion(req.params.id, parsed.data.question);
    res.json(result);
  } catch (e: any) {
    if (e.message === "business_not_found") return res.status(404).json({ error: "not_found" });
    throw e;
  }
});

export default router;