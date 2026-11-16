// Bounces and complaints on outside share emails (#2650). Cloudflare Email
// Service publishes sending events (message.bounced, message.complained, ...)
// to a Queue; the platform binds this Worker as its consumer and sets
// EMAIL_EVENTS_QUEUE. A complaint pauses the member's outside share emails for
// 7 days at once; a bounce counts only when the event says it is terminal, and
// the third terminal bounce within 7 days pauses them: a stranger's complaint
// is the sender's reputation to protect, one bad address is not.
// message.failed never pauses: it can be our failure or the provider's.
// The sharer sees their own pause (notEmailed "sender_paused", pausedUntil),
// never which recipient bounced; the log carries sender_paused.
//
// PIN BEFORE ENABLING: the event shapes below are read from Cloudflare's
// documentation (payload.messageId, payload.terminal, the type names), not
// from live events. They must be checked against one real bounce and one real
// complaint on staging before EMAIL_EVENTS_QUEUE is set anywhere real.
import {
  EMAIL_EVENTS_ACK_MAX,
  EMAIL_EVENTS_ACK_PATH,
  EMAIL_EVENTS_PULL_PATH,
  type EmailEvent,
  EmailEventsAckResponseSchema,
  EmailEventsPullResponseSchema,
} from "@oa/provisioning-contract/email-events";
import { z } from "zod";
import { stmt } from "../db/stmt.js";
import type { Env } from "../env.js";
import { logError, logInfo, logWarn } from "../log.js";
import { LoginGateError, loginGateCall } from "./login-gate.js";

export const SENDER_PAUSE_MS = 7 * 24 * 60 * 60 * 1000;
/** Terminal bounces within SENDER_PAUSE_MS that pause a member. */
export const BOUNCES_TO_PAUSE = 3;
/** How long a message id stays traceable to its sender. */
const MESSAGE_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

/** Remembers which member sent an outside share email (called after a send). Never the address. */
export async function recordShareEmail(
  env: Env,
  messageId: string,
  userId: string,
  now = Date.now(),
): Promise<void> {
  await stmt(
    env.DB,
    `insert into share_email_messages (message_id, user_id, created_at)
     values (?1, ?2, ?3) on conflict (message_id) do nothing`,
  )
    .bind(messageId, userId, now)
    .run();
}

/** When this member's outside share emails are paused until (ms), or null when they are not. */
export async function pausedUntil(
  env: Env,
  userId: string,
  now = Date.now(),
): Promise<number | null> {
  const row = await stmt(
    env.DB,
    "select until_at from share_email_pauses where user_id = ?1",
  )
    .bind(userId)
    .first<{ until_at: number }>();
  return row && row.until_at > now ? row.until_at : null;
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

/** What an event comes down to, whichever way it arrived. */
export type SendingEvent = {
  messageId: string;
  kind: "bounced" | "complained";
  /** A bounce says so explicitly: only then does it count. */
  terminal: boolean;
};

const BOUNCED = "cf.email.sending.message.bounced";
const COMPLAINED = "cf.email.sending.message.complained";

/**
 * One event on a message we sent for a member. A complaint pauses them at
 * once; a bounce counts only when it is explicitly terminal (a missing field
 * is not a count), and the third within 7 days pauses them. A pause is 7
 * days, extended and never shortened. Only message ids this install recorded
 * count; anything else changes nothing. Resolves to whether it paused someone.
 */
export async function applySendingEvent(
  env: Env,
  ev: SendingEvent,
  now = Date.now(),
): Promise<boolean> {
  if (ev.kind === "bounced" && !ev.terminal) return false;
  // A first read that throws (rather than rejects) must reach the caller's
  // try as an ordinary rejection: without this turn the runtime reports the
  // rejected promise as unhandled before the caller's await has attached.
  await null;
  const row = await stmt(
    env.DB,
    "select user_id from share_email_messages where message_id = ?1",
  )
    .bind(ev.messageId)
    .first<{ user_id: string }>();
  if (!row) return false;
  if (ev.kind === "bounced") {
    // Once per message (a redelivered event counts once); then the third
    // terminal bounce in the window pauses.
    await stmt(
      env.DB,
      "update share_email_messages set bounced_at = ?2 where message_id = ?1 and bounced_at is null",
    )
      .bind(ev.messageId, now)
      .run();
    const n = await stmt(
      env.DB,
      "select count(*) as n from share_email_messages where user_id = ?1 and bounced_at > ?2",
    )
      .bind(row.user_id, now - SENDER_PAUSE_MS)
      .first<{ n: number }>();
    if ((n?.n ?? 0) < BOUNCES_TO_PAUSE) return false;
  }
  await stmt(
    env.DB,
    `insert into share_email_pauses (user_id, until_at, reason, created_at)
     values (?1, ?2, ?3, ?4)
     on conflict (user_id) do update set
       until_at = max(until_at, excluded.until_at), reason = excluded.reason`,
  )
    .bind(row.user_id, now + SENDER_PAUSE_MS, ev.kind, now)
    .run();
  logInfo("sender_paused", { userId: row.user_id, reason: ev.kind });
  return true;
}

/** One Queue message (Email Service's own event shape): complaints, and bounces that say terminal: true. */
export async function handleEmailEvent(
  env: Env,
  raw: unknown,
  now = Date.now(),
): Promise<boolean> {
  const ev = EventSchema.safeParse(raw);
  if (!ev.success) return false;
  const { type } = ev.data;
  if (type !== BOUNCED && type !== COMPLAINED) return false;
  return applySendingEvent(
    env,
    {
      messageId: ev.data.payload.messageId,
      kind: type === COMPLAINED ? "complained" : "bounced",
      terminal: ev.data.payload.terminal === true,
    },
    now,
  );
}

/**
 * Hosted: pulls the events the platform holds for this install over the
 * LoginGate (POST /email-events/pull, which deletes nothing), applies each
 * once by its eventId, and only then acknowledges them (POST
 * /email-events/ack, 100 at a time). The same rules as the Queue path: a
 * complaint pauses at once, a bounce counts only when its bounceType is "hard"
 * ("soft" never does), and only message ids this install recorded matter. The
 * contract admits no other kind or bounceType: a response that has one is
 * malformed and counts as no events. An event this install already processed
 * (its id is in share_email_events_seen) is a no-op, so a failed ack just
 * means the platform serves it again. An event that could not be applied is not
 * acknowledged and comes back (the platform keeps it 14 days). Never throws:
 * a gate that can't answer pulls or acknowledges nothing this tick. Resolves
 * to how many members were paused.
 */
export async function pullEmailEvents(env: Env): Promise<number> {
  let events: EmailEvent[];
  try {
    const out = EmailEventsPullResponseSchema.safeParse(
      await loginGateCall(env, EMAIL_EVENTS_PULL_PATH),
    );
    if (!out.success) throw new LoginGateError("bad_answer");
    events = out.data.events;
  } catch (e) {
    logWarn("email_events_pull_failed", e, {
      why: e instanceof LoginGateError ? e.why : "error",
    });
    return 0;
  }
  let paused = 0;
  const done: string[] = [];
  for (const e of events) {
    try {
      const seen = await stmt(
        env.DB,
        "select 1 as x from share_email_events_seen where event_id = ?1",
      )
        .bind(e.eventId)
        .first();
      if (!seen) {
        if (
          await applySendingEvent(env, {
            messageId: e.messageId,
            kind: e.kind,
            terminal: e.bounceType === "hard",
          })
        )
          paused++;
        await stmt(
          env.DB,
          "insert into share_email_events_seen (event_id, created_at) values (?1, ?2) on conflict (event_id) do nothing",
        )
          .bind(e.eventId, Date.now())
          .run();
      }
      done.push(e.eventId);
    } catch (err) {
      logError("email_event_apply_failed", err);
    }
  }
  // Acknowledge what was handled, in batches; a refused batch is retried by
  // the next pull (served again, then a no-op).
  for (let i = 0; i < done.length; i += EMAIL_EVENTS_ACK_MAX) {
    try {
      const out = EmailEventsAckResponseSchema.safeParse(
        await loginGateCall(env, EMAIL_EVENTS_ACK_PATH, {
          eventIds: done.slice(i, i + EMAIL_EVENTS_ACK_MAX),
        }),
      );
      if (!out.success) throw new LoginGateError("bad_answer");
    } catch (err) {
      logWarn("email_events_ack_failed", err, {
        why: err instanceof LoginGateError ? err.why : "error",
      });
      break;
    }
  }
  return paused;
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
    stmt(
      env.DB,
      "delete from share_email_events_seen where created_at < ?1",
    ).bind(now - MESSAGE_KEEP_MS),
  ]);
}
