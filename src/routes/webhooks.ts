import { Router } from "express";
import { z } from "zod";
import { subscribe, listSubscriptions, listEvents } from "../services/webhookService";
import { requireApiKey, AuthedRequest } from "../middleware/apiKeyAuth";

const router = Router();

const subscribeSchema = z.object({
  event_pattern: z.string().min(3),
  target_url: z.string().url(),
});

router.post("/", requireApiKey, async (req: AuthedRequest, res) => {
  const parsed = subscribeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_input", details: parsed.error.flatten() });

  const sub = await subscribe({ client_name: req.client!.name, ...parsed.data });
  res.status(201).json({ ...sub, note: "Store the secret now — verify the x-africore-signature header on deliveries. It will not be shown again." });
});

router.get("/", requireApiKey, async (req: AuthedRequest, res) => {
  const subs = (await listSubscriptions(req.client!.name)).map(({ secret, ...rest }) => rest);
  res.json(subs);
});

router.get("/events", requireApiKey, async (req, res) => {
  const eventType = req.query.event_type ? String(req.query.event_type) : undefined;
  res.json(await listEvents(eventType));
});

export default router;