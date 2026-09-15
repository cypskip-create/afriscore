import { Router } from "express";
import { z } from "zod";
import { grantConsent, revokeConsent, listConsents } from "../services/consentService";

const router = Router();

const grantSchema = z.object({
  subject_type: z.enum(["business", "person"]),
  subject_id: z.string().uuid(),
  grantee: z.string().min(1),
  purpose: z.string().min(1),
  scope: z.array(z.string()).min(1),
});

router.post("/", async (req, res) => {
  const parsed = grantSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_input", details: parsed.error.flatten() });

  const consent = await grantConsent(parsed.data);
  res.status(201).json(consent);
});

router.delete("/:id", async (req, res) => {
  const consent = await revokeConsent(req.params.id);
  if (!consent) return res.status(404).json({ error: "not_found" });
  res.json(consent);
});

router.get("/", async (req, res) => {
  const { subject_type, subject_id } = req.query;
  if (!subject_type || !subject_id) {
    return res.status(400).json({ error: "missing_params", detail: "subject_type and subject_id are required" });
  }
  res.json(await listConsents(String(subject_type), String(subject_id)));
});

export default router;