import { Router } from "express";
import { z } from "zod";
import { createBusiness, getBusiness, runVerificationChecks, getTrustRecord } from "../services/businessService";
import { isConsentActive } from "../services/consentService";

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
// delivery app) actually calls. Gated by consent: the grantee (identified via
// x-client-id header for this MVP) must have an active consent grant.
router.get("/:id/trust-record", (req, res) => {
  const grantee = req.header("x-client-id");
  if (!grantee) return res.status(401).json({ error: "missing_client_id", detail: "Set x-client-id header" });

  if (!isConsentActive("business", req.params.id, grantee)) {
    return res.status(403).json({ error: "consent_required", detail: "No active consent for this grantee" });
  }

  const record = getTrustRecord(req.params.id);
  if (!record) return res.status(404).json({ error: "not_found" });
  res.json(record);
});

export default router;