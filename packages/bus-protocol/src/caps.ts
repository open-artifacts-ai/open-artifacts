import { z } from "zod";

/**
 * Capability tokens a client lists in its `hello` (`caps`). The hub gates new
 * hub-to-client fields on them, not on `client_version`: OA's client reports
 * 0.0.0 until #1308, so a version can't tell an old client from a new one.
 * Consumers ignore tokens they don't know.
 */
export const BUS_CAPS = {
  /**
   * Renames (#393): the client decodes roster `former_names` and a
   * former-name receipt `to_name`. The hub sends those only to a socket whose
   * hello listed it.
   */
  rename: "rename",
  /**
   * Role addresses (#1296): the client decodes the `role_vacant` refusal and
   * a role hit's receipt `to_name` (the holder's name). The hub sends those
   * only to a socket whose hello listed it; any other gets `unknown_agent`
   * for a vacant role and no `to_name`.
   */
  roles: "roles",
  /**
   * Agent ids on replies: the client decodes `deliver.from_id` and the
   * `agent_gone` refusal, and may send `send.to_id`. The hub sends those only
   * to a socket whose hello listed it, and lists it in `hello_ok.caps`; the
   * client sends `to_id` only when it did.
   */
  ids: "ids",
  /**
   * Lasting mailboxes (#1295): the client decodes a send receipt's `queued`
   * and `since`, the `mailbox_full` and `reserved_name` refusals, and roster
   * rows with `state: "away"` and `since`. The hub sends those only to a
   * socket whose hello listed it, and lists it in `hello_ok.caps`; any other
   * socket sees today's shapes (`inbox_full`, `unknown_agent`, no away rows).
   * A client also lists it to have the hub hand an address over on `agent_up`
   * `replaces` (a /clear).
   */
  mailbox: "mailbox",
  /**
   * Project links (#1567): the client understands roster rows and routing
   * across the namespaces its member linked (each row carries its own
   * `namespace`; a name in two linked namespaces is `ambiguous` until the
   * send names `to_namespace`). The hub widens a socket's roster and routing
   * only when its hello listed it, and lists it in `hello_ok.caps`; any other
   * socket sees today's isolation.
   */
  links: "links",
  /**
   * Follows (#1317): the client may send `follow`, `unfollow` and `following`
   * and decodes `followed`, `unfollowed`, `follows` and the `follow_limit`
   * error. The hub answers those frames only on a socket whose hello listed
   * it (any other gets `bad_frame`, as an old hub would) and lists it in
   * `hello_ok.caps`; a client sends them only when it did.
   */
  follow: "follow",
} as const;
export type BusCap = (typeof BUS_CAPS)[keyof typeof BUS_CAPS];

/** Most tokens one hello may list. */
export const MAX_CAPS = 16;

/** One capability token: lowercase, starts with a letter, at most 32 chars. */
export const CapTokenSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/);

/** `hello.caps`: up to MAX_CAPS distinct tokens, known or not. */
export const CapsSchema = z
  .array(CapTokenSchema)
  .max(MAX_CAPS)
  .refine((a) => new Set(a).size === a.length, "duplicate caps");

/** True when the hello listed `cap`. A hello without `caps` has none. */
export function hasCap(
  hello: { caps?: readonly string[] | undefined } | null | undefined,
  cap: BusCap,
): boolean {
  return hello?.caps?.includes(cap) ?? false;
}
