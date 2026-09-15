import { Router } from "express";
import { z } from "zod";
import { createApiClient, listApiClients } from "../services/apiClientService";

const router = Router();

const createSchema = z.object({ name: z.string().min(2) });

router.post("/", async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_input", details: parsed.error.flatten() });

  const { client, apiKey } = await createApiClient(parsed.data.name);
  res.status(201).json({ ...client, api_key: apiKey, note: "Store this key now — it will not be shown again." });
});

router.get("/", async (_req, res) => {
  res.json(await listApiClients());
});

export default router;