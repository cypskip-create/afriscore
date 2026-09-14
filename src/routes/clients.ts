import { Router } from "express";
import { z } from "zod";
import { createApiClient, listApiClients } from "../services/apiClientService";

const router = Router();

const createSchema = z.object({ name: z.string().min(2) });

// In production this would sit behind account signup/login. For the
// developer platform MVP, anyone can register a named client and get a key.
router.post("/", (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_input", details: parsed.error.flatten() });

  const { client, apiKey } = createApiClient(parsed.data.name);
  res.status(201).json({ ...client, api_key: apiKey, note: "Store this key now — it will not be shown again." });
});

router.get("/", (_req, res) => {
  res.json(listApiClients());
});

export default router;