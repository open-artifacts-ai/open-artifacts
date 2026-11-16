// Email Service sending events a hosted install pulls from the platform
// (open-artifacts#2650): the platform receives the provider's bounce and
// complaint events and serves each one to the install that sent the message,
// once. POST /email-events/pull over the LoginGate, signed like /optouts (the
// body names no install: the gate stamps it). One definition both repos use.
import { z } from "zod";

/** A request nonce: 16 to 64 URL-safe characters, never reused by an install (the same as /optouts). */
export const EMAIL_EVENTS_NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;
export const EMAIL_EVENTS_PULL_PATH = "/email-events/pull";
/** Events one pull may return at most. */
export const EMAIL_EVENTS_PULL_MAX = 500;

/** The request: exactly { ts, nonce }. */
export const EmailEventsPullBodySchema = z.strictObject({
  /** ms since the epoch; the platform refuses a skew past ASSERTION_SKEW_MS. */
  ts: z.number().finite(),
  nonce: z.string().regex(EMAIL_EVENTS_NONCE_RE),
});
export type EmailEventsPullBody = z.infer<typeof EmailEventsPullBodySchema>;

/**
 * One event on a message this install sent. `kind` is the event: "bounced",
 * "failed" or "complained" (anything else is ignored by the install).
 * `bounceType` says how a bounce ended ("hard" is terminal); missing or any
 * value the install does not know is not terminal.
 */
export const EmailEventSchema = z.strictObject({
  messageId: z.string().min(1).max(200),
  kind: z.string().min(1).max(40),
  bounceType: z.string().min(1).max(40).nullish(),
});
export type EmailEvent = z.infer<typeof EmailEventSchema>;

/** POST /email-events/pull -> 200. Each event is served once. */
export const EmailEventsPullResponseSchema = z.strictObject({
  events: z.array(EmailEventSchema).max(EMAIL_EVENTS_PULL_MAX),
});
export type EmailEventsPullResponse = z.infer<
  typeof EmailEventsPullResponseSchema
>;
