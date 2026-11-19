// Email Service sending events a hosted install pulls from the platform
// (open-artifacts#2650): the platform receives the provider's bounce and
// complaint events and holds them for the install that sent the message
// (14 days unless acknowledged). The install pulls (POST /email-events/pull),
// processes each event once by its eventId, then acknowledges them in batches
// (POST /email-events/ack). Both over the LoginGate, signed like /optouts (the
// body names no install: the gate stamps it). One definition both repos use.
import { z } from "zod";

/** A request nonce: 16 to 64 URL-safe characters, never reused by an install (the same as /optouts). */
export const EMAIL_EVENTS_NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;
export const EMAIL_EVENTS_PULL_PATH = "/email-events/pull";
export const EMAIL_EVENTS_ACK_PATH = "/email-events/ack";
/** Event ids one ack may name at most. */
export const EMAIL_EVENTS_ACK_MAX = 100;
/** Events one pull may return at most. */
export const EMAIL_EVENTS_PULL_MAX = 100;

/** The request: exactly { ts, nonce }. */
export const EmailEventsPullBodySchema = z.strictObject({
  /** ms since the epoch; the platform refuses a skew past ASSERTION_SKEW_MS. */
  ts: z.number().finite(),
  nonce: z.string().regex(EMAIL_EVENTS_NONCE_RE),
});
export type EmailEventsPullBody = z.infer<typeof EmailEventsPullBodySchema>;

/**
 * One event on a message this install sent. `kind` is "bounced" or
 * "complained". `bounceType` is always present: "hard" (terminal) or "soft" for
 * a bounce, null for a complaint.
 */
export const EmailEventSchema = z.strictObject({
  /** The platform's id for this event: what the install acknowledges, and what makes a repeat a no-op. */
  eventId: z.string().min(1).max(200),
  messageId: z.string().min(1).max(200),
  kind: z.enum(["bounced", "complained"]),
  bounceType: z.enum(["hard", "soft"]).nullable(),
});
export type EmailEvent = z.infer<typeof EmailEventSchema>;

/** POST /email-events/pull -> 200. Deletes nothing: an event stays (14 days) until acknowledged. */
export const EmailEventsPullResponseSchema = z.strictObject({
  events: z.array(EmailEventSchema).max(EMAIL_EVENTS_PULL_MAX),
});
export type EmailEventsPullResponse = z.infer<
  typeof EmailEventsPullResponseSchema
>;

/** POST /email-events/ack: the events the install has processed, at most EMAIL_EVENTS_ACK_MAX. */
export const EmailEventsAckBodySchema = z.strictObject({
  ts: z.number().finite(),
  nonce: z.string().regex(EMAIL_EVENTS_NONCE_RE),
  eventIds: z
    .array(z.string().min(1).max(200))
    .min(1)
    .max(EMAIL_EVENTS_ACK_MAX),
});
export type EmailEventsAckBody = z.infer<typeof EmailEventsAckBodySchema>;

/** POST /email-events/ack -> 200: how many of them it removed. */
export const EmailEventsAckResponseSchema = z.strictObject({
  acked: z.number().int().nonnegative(),
});
export type EmailEventsAckResponse = z.infer<
  typeof EmailEventsAckResponseSchema
>;
