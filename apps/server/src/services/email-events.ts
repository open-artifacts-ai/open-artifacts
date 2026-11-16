// Bounces and complaints on outside share emails (#2650). Cloudflare Email
// Service publishes sending events (message.bounced, message.failed,
// message.complained) to a Queue; the platform binds this Worker as its
// consumer and sets EMAIL_EVENTS_QUEUE. A bounce or complaint on a member's
// outside share email pauses that member's outside share emails for 7 days: a
// stranger's complaint is the sender's reputation to protect. The sharer sees
// notEmailed "skipped" (never why); the log carries sender_paused.
import { z } from "zod";
import { stmt } from "../db/stmt.js";
import type { Env } from "../env.js";
import { logError, logInfo } from "../log.js";
import { sha256Hex } from "../util/crypto.js";

export const SENDER_PAUSE_MS = 7 * 24 * 60 * 60 * 1000;
/** How long a message id stays traceable to its sender. */
const MESSAGE_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

/** The row key of an address: the SHA-256 of its normalized form, never the address. */
export const addressKey = (email: string): Promise<string> =>
  sha256Hex(email.trim().toLowerCase());

/** Remembers which member sent which outside share email (called after a send). */
export async function recordShareEmail(
  env: Env,
  messageId: string,
  userId: string,
  email: string,
  now = Date.now(),
): Promise<void> {
  await stmt(
    env.DB,
    `insert into share_email_messages (message_id, user_id, address_hash, created_at)
     values (?1, ?2, ?3, ?4) on conflict (message_id) do nothing`,
  )
    .bind(messageId, userId, await addressKey(email), now)
    .run();
}

/** Whether this member's outside share emails are paused now. */
export async function senderPaused(
  env: Env,
  userId: string,
  now = Date.now(),
): Promise<boolean> {
  const row = await stmt(
    env.DB,
    "select until_at from share_email_pauses where user_id = ?1",
  )
    .bind(userId)
    .first<{ until_at: number }>();
  return row !== null && row.until_at > now;
}

// What Email Service publishes (see its event-subscriptions reference): the
// type, and a payload with the message id and delivery. Only what is read.
const EventSchema = z.object({
  type: z.string(),
  payload: z.object({
    messageId: z.string().min(1).max(200),
    terminal: z.boolean().optional(),
  }),
});

const PAUSING = new Set([
  "cf.email.sending.message.bounced",
  "cf.email.sending.message.failed",
  "cf.email.sending.message.complained",
]);

/**
 * One event. A bounce, a failure or a complaint on a message we sent for a
 * member pauses that member for 7 days (extended, never shortened). Anything
 * else (delivered, deferred, a soft bounce, a message that is not an outside
 * share email) changes nothing. Resolves to whether it paused someone.
 */
export async function handleEmailEvent(
  env: Env,
  raw: unknown,
  now = Date.now(),
): Promise<boolean> {
  const ev = EventSchema.safeParse(raw);
  if (!ev.success || !PAUSING.has(ev.data.type)) return false;
  // A soft bounce (not terminal) is retried by the sender: no pause.
  if (ev.data.type.endsWith(".bounced") && ev.data.payload.terminal === false)
    return false;
  const row = await stmt(
    env.DB,
    "select user_id from share_email_messages where message_id = ?1",
  )
    .bind(ev.data.payload.messageId)
    .first<{ user_id: string }>();
  if (!row) return false;
  const kind = ev.data.type.slice(ev.data.type.lastIndexOf(".") + 1);
  await stmt(
    env.DB,
    `insert into share_email_pauses (user_id, until_at, reason, created_at)
     values (?1, ?2, ?3, ?4)
     on conflict (user_id) do update set
       until_at = max(until_at, excluded.until_at), reason = excluded.reason`,
  )
    .bind(row.user_id, now + SENDER_PAUSE_MS, kind, now)
    .run();
  logInfo("sender_paused", { userId: row.user_id, reason: kind });
  return true;
}

/**
 * The Queue consumer. With EMAIL_EVENTS_QUEUE unset, or another queue's batch,
 * nothing is read and nothing changes. Each message is acked once handled (or
 * unreadable); an error retries that message only.
 */
export async function emailEventsConsumer(
  batch: MessageBatch<unknown>,
  env: Env,
): Promise<void> {
  if (!env.EMAIL_EVENTS_QUEUE || batch.queue !== env.EMAIL_EVENTS_QUEUE) {
    logInfo("email_events_ignored", { queue: batch.queue });
    batch.ackAll();
    return;
  }
  for (const m of batch.messages) {
    try {
      await handleEmailEvent(env, m.body);
      m.ack();
    } catch (e) {
      logError("email_event_failed", e);
      m.retry();
    }
  }
}

/** The daily sweep: expired pauses and message ids past their keep. */
export async function sweepEmailEvents(env: Env, now: number): Promise<void> {
  await env.DB.batch([
    stmt(env.DB, "delete from share_email_pauses where until_at < ?1").bind(
      now,
    ),
    stmt(env.DB, "delete from share_email_messages where created_at < ?1").bind(
      now - MESSAGE_KEEP_MS,
    ),
  ]);
}
