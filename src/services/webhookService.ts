import { v4 as uuid } from "uuid";
import { db } from "../db";

interface WebhookSubscription {
  id: string;
  client_name: string;
  event_pattern: string;
  target_url: string;
  status: string;
  created_at: string;
}

function matchesPattern(eventType: string, pattern: string): boolean {
  if (pattern === eventType) return true;
  if (pattern.endsWith(".*")) return eventType.startsWith(pattern.slice(0, -1));
  return false;
}

export function subscribe(input: { client_name: string; event_pattern: string; target_url: string }): WebhookSubscription {
  const sub: WebhookSubscription = {
    id: uuid(),
    client_name: input.client_name,
    event_pattern: input.event_pattern,
    target_url: input.target_url,
    status: "active",
    created_at: new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO webhook_subscriptions (id, client_name, event_pattern, target_url, status, created_at)
     VALUES (@id, @client_name, @event_pattern, @target_url, @status, @created_at)`
  ).run(sub);
  return sub;
}

export function listSubscriptions(clientName?: string): WebhookSubscription[] {
  if (clientName) {
    return db.prepare(`SELECT * FROM webhook_subscriptions WHERE client_name = ?`).all(clientName) as WebhookSubscription[];
  }
  return db.prepare(`SELECT * FROM webhook_subscriptions`).all() as WebhookSubscription[];
}

/**
 * Records the event (always, for audit/debugging via GET /v1/webhook-events)
 * and attempts best-effort delivery to any matching active subscription.
 * Delivery failures never throw — webhook delivery must not break the
 * operation that triggered the event (e.g. a transaction sync should
 * succeed even if a partner's endpoint is down).
 */
export async function emitEvent(eventType: string, payload: object): Promise<void> {
  const id = uuid();
  const createdAt = new Date().toISOString();
  const payloadStr = JSON.stringify(payload);

  db.prepare(
    `INSERT INTO webhook_events (id, event_type, payload, created_at, delivery_attempts, last_delivery_status)
     VALUES (?, ?, ?, ?, 0, NULL)`
  ).run(id, eventType, payloadStr, createdAt);

  const subs = listSubscriptions().filter((s) => s.status === "active" && matchesPattern(eventType, s.event_pattern));

  for (const sub of subs) {
    try {
      await fetch(sub.target_url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: eventType, data: payload, id }),
      });
      db.prepare(`UPDATE webhook_events SET delivery_attempts = delivery_attempts + 1, last_delivery_status = 'delivered' WHERE id = ?`).run(id);
    } catch (err) {
      db.prepare(`UPDATE webhook_events SET delivery_attempts = delivery_attempts + 1, last_delivery_status = 'failed' WHERE id = ?`).run(id);
    }
  }
}

export function listEvents(eventType?: string, limit = 50) {
  if (eventType) {
    return db
      .prepare(`SELECT * FROM webhook_events WHERE event_type = ? ORDER BY created_at DESC LIMIT ?`)
      .all(eventType, limit);
  }
  return db.prepare(`SELECT * FROM webhook_events ORDER BY created_at DESC LIMIT ?`).all(limit);
}