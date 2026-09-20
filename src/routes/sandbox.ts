import { Router } from "express";
import { z } from "zod";
import { createBusiness, listSandboxBusinesses } from "../services/businessService";
import { createPerson, listSandboxPersons } from "../services/personService";
import { testWebhookDelivery } from "../services/webhookService";
import { requireApiKey, AuthedRequest } from "../middleware/apiKeyAuth";

/**
 * Sandbox environment (spec section 33). Every business/person created
 * here is flagged is_sandbox=true — same code paths as live data (same
 * verification, same ledger, same reconciliation), so what a developer
 * tests here behaves the same way in production, just isolated from real
 * records. Nothing here bypasses consent or auth: sandboxing is about
 * data isolation, not weaker rules.
 */
const router = Router();

const businessSchema = z.object({
  legal_name: z.string().min(2),
  registration_number: z.string().optional(),
  kra_pin: z.string().optional(),
});

router.post("/businesses", async (req, res) => {
  const parsed = businessSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_input", details: parsed.error.flatten() });

  const business = await createBusiness({ ...parsed.data, is_sandbox: true });
  res.status(201).json(business);
});

router.get("/businesses", async (_req, res) => {
  res.json(await listSandboxBusinesses());
});

const personSchema = z.object({
  full_name: z.string().min(2),
  national_id: z.string().min(4).optional(),
});

router.post("/persons", async (req, res) => {
  const parsed = personSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_input", details: parsed.error.flatten() });

  const person = await createPerson({ ...parsed.data, is_sandbox: true });
  res.status(201).json(person);
});

router.get("/persons", async (_req, res) => {
  res.json(await listSandboxPersons());
});

// POST /v1/sandbox/webhook-test — fire one signed test delivery at any URL,
// so a developer can confirm their receiver validates the signature
// correctly before wiring up a real subscription.
const webhookTestSchema = z.object({ target_url: z.string().url() });

router.post("/webhook-test", requireApiKey, async (req: AuthedRequest, res) => {
  const parsed = webhookTestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_input", details: parsed.error.flatten() });

  const result = await testWebhookDelivery(parsed.data.target_url);
  res.json(result);
});

export default router;