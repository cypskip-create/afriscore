import { Router } from "express";
import { z } from "zod";
import { createPerson, getPerson, runPersonVerification, getPersonTrustRecord } from "../services/personService";
import { isConsentActive } from "../services/consentService";
import { verifyChainIntegrity } from "../services/ledgerService";
import { requireApiKey, AuthedRequest } from "../middleware/apiKeyAuth";

const router = Router();

const createSchema = z.object({
  full_name: z.string().min(2),
  national_id: z.string().min(4).optional(),
  phone: z.string().min(7).optional(),
});

router.post("/", async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_input", details: parsed.error.flatten() });

  const person = await createPerson(parsed.data);
  res.status(201).json(person);
});

router.get("/:id", async (req, res) => {
  const person = await getPerson(req.params.id);
  if (!person) return res.status(404).json({ error: "not_found" });
  res.json(person);
});

router.post("/:id/verify", async (req, res) => {
  try {
    const result = await runPersonVerification(req.params.id);
    res.json(result);
  } catch (e: any) {
    if (e.message === "person_not_found") return res.status(404).json({ error: "not_found" });
    throw e;
  }
});

router.get("/:id/trust-record", requireApiKey, async (req: AuthedRequest, res) => {
  if (!(await isConsentActive("person", req.params.id, req.client!.name))) {
    return res.status(403).json({ error: "consent_required", detail: "No active consent for this grantee" });
  }

  const record = await getPersonTrustRecord(req.params.id);
  if (!record) return res.status(404).json({ error: "not_found" });
  res.json(record);
});

router.get("/:id/ledger/verify", async (req, res) => {
  const result = await verifyChainIntegrity("person", req.params.id);
  res.json(result);
});

export default router;