import crypto from "crypto";
import { v4 as uuid } from "uuid";
import { dbAll, dbRun } from "../db";

interface WebhookSubscription {
  id: string;
  client_name: string;
  event_pattern: string;
  target_url: string;
  status: string;
  created_at: string;
  secret: string;
}

function matchesPattern(eventType: string, pattern: string): boolean {
  if (pattern === eventType) return true;
  if (pattern.endsWith(".*")) return eventType.startsWith(pattern.slice(0, -1));
  return false;
}

/** Generates a per-subscription signing secret, returned once at subscribe
 *  time. Every delivery to this subscription is signed with it so the
 *  receiver can verify the webhook actually came from AfriCore and wasn't
 *  forged or replayed with tampered contents. */
export async function subscribe(input: { client_name: string; event_pattern: string; target_url: string }): Promise<WebhookSubscription> {
  const sub: WebhookSubscription = {
    id: uuid(),
    client_name: input.client_name,
    event_pattern: input.event_pattern,
    target_url: input.target_url,
    status: "active",
    created_at: new Date().toISOString(),
    secret: `whsec_${crypto.randomBytes(24).toString("hex")}`,
  };
  await dbRun(
    `INSERT INTO webhook_subscriptions (id, client_name, event_pattern, target_url, status, created_at, secret)
     VALUES (@id, @client_name, @event_pattern, @target_url, @status, @created_at, @secret)`,
    sub
  );
  return sub;
}

export async function listSubscriptions(clientName?: string): Promise<WebhookSubscription[]> {
  if (clientName) {
    return dbAll<WebhookSubscription>(`SELECT * FROM webhook_subscriptions WHERE client_name = ?`, [clientName]);
  }
  return dbAll<WebhookSubscription>(`SELECT * FROM webhook_subscriptions`);
}

function sign(secret: string, body: string): string {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

/**
 * Records the event (always, for audit/debugging via GET /v1/webhook-events)
 * and attempts best-effort, signed delivery to any matching active
 * subscription. Delivery failures never throw — webhook delivery must not
 * break the operation that triggered the event.
 */
export async function emitEvent(eventType: string, payload: object): Promise<void> {
  const id = uuid();
  const createdAt = new Date().toISOString();
  const payloadStr = JSON.stringify(payload);

  await dbRun(
    `INSERT INTO webhook_events (id, event_type, payload, created_at, delivery_attempts, last_delivery_status)
     VALUES (?, ?, ?, ?, 0, NULL)`,
    [id, eventType, payloadStr, createdAt]
  );

  const allSubs = await listSubscriptions();
  const subs = allSubs.filter((s) => s.status === "active" && matchesPattern(eventType, s.event_pattern));

  for (const sub of subs) {
    const body = JSON.stringify({ event: eventType, data: payload, id });
    const signature = sign(sub.secret, body);

    try {
      await fetch(sub.target_url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-africore-signature": signature,
        },
        body,
      });
      await dbRun(`UPDATE webhook_events SET delivery_attempts = delivery_attempts + 1, last_delivery_status = 'delivered' WHERE id = ?`, [id]);
    } catch (err) {
      await dbRun(`UPDATE webhook_events SET delivery_attempts = delivery_attempts + 1, last_delivery_status = 'failed' WHERE id = ?`, [id]);
    }
  }
}

export async function listEvents(eventType?: string, limit = 50) {
  if (eventType) {
    return dbAll(`SELECT * FROM webhook_events WHERE event_type = ? ORDER BY created_at DESC LIMIT ?`, [eventType, limit]);
  }
  return dbAll(`SELECT * FROM webhook_events ORDER BY created_at DESC LIMIT ?`, [limit]);
}