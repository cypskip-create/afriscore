import { Router } from "express";
import { z } from "zod";
import { createBusiness, getBusiness, runVerificationChecks, getTrustRecord } from "../services/businessService";
import { isConsentActive } from "../services/consentService";
import { verifyChainIntegrity } from "../services/ledgerService";
import { requireApiKey, AuthedRequest } from "../middleware/apiKeyAuth";

const router = Router();

const createSchema = z.object({
  legal_name: z.string().min(2),
  trading_name: z.string().optional(),
  registration_number: z.string().optional(),
  kra_pin: z.string().optional(),
  industry: z.string().optional(),
});

router.post("/", (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_input", details: parsed.error.flatten() });

  const business = createBusiness(parsed.data);
  res.status(201).json(business);
});

router.get("/:id", (req, res) => {
  const business = getBusiness(req.params.id);
  if (!business) return res.status(404).json({ error: "not_found" });
  res.json(business);
});

router.post("/:id/verify", (req, res) => {
  try {
    const result = runVerificationChecks(req.params.id);
    res.json(result);
  } catch (e: any) {
    if (e.message === "business_not_found") return res.status(404).json({ error: "not_found" });
    throw e;
  }
});

// Trust record — this is the endpoint a partner platform (lender, marketplace,
// delivery app) actually calls. Gated by consent: the calling client (proven by
// its API key, not a self-declared header) must have an active consent grant.
router.get("/:id/trust-record", requireApiKey, (req: AuthedRequest, res) => {
  if (!isConsentActive("business", req.params.id, req.client!.name)) {
    return res.status(403).json({ error: "consent_required", detail: "No active consent for this grantee" });
  }

  const record = getTrustRecord(req.params.id);
  if (!record) return res.status(404).json({ error: "not_found" });
  res.json(record);
});

// Public integrity proof — deliberately unauthenticated. Doesn't leak business
// data, just confirms the hash chain hasn't been tampered with. Useful as a
// standalone trust demo for a partner evaluating the platform.
router.get("/:id/ledger/verify", (req, res) => {
  const result = verifyChainIntegrity("business", req.params.id);
  res.json(result);
});

export default router;