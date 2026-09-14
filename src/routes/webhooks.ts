import { Router } from "express";
import { z } from "zod";
import { subscribe, listSubscriptions, listEvents } from "../services/webhookService";
import { requireApiKey, AuthedRequest } from "../middleware/apiKeyAuth";

const router = Router();

const subscribeSchema = z.object({
  event_pattern: z.string().min(3), // e.g. 'transaction.created' or 'transaction.*'
  target_url: z.string().url(),
});

router.post("/", requireApiKey, (req: AuthedRequest, res) => {
  const parsed = subscribeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_input", details: parsed.error.flatten() });

  const sub = subscribe({ client_name: req.client!.name, ...parsed.data });
  res.status(201).json({ ...sub, note: "Store the secret now — verify the x-africore-signature header on deliveries. It will not be shown again." });
});

router.get("/", requireApiKey, (req: AuthedRequest, res) => {
  const subs = listSubscriptions(req.client!.name).map(({ secret, ...rest }) => rest);
  res.json(subs);
});

// Debug/sandbox visibility into recently emitted events, per the doc's
// sandbox principle of letting developers see what the platform is doing.
router.get("/events", requireApiKey, (req, res) => {
  const eventType = req.query.event_type ? String(req.query.event_type) : undefined;
  res.json(listEvents(eventType));
});

export default router;