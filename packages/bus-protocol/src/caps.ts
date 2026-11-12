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
   * Scoped role reach (#1346): a role the member gave reach to other
   * namespaces lets its holder see and message the agents there (each row
   * carries its own `namespace`; a name in two namespaces is `ambiguous`
   * until the send names `to_namespace`), and those agents reply to it. The
   * hub widens a socket's roster and routing only when its hello listed it,
   * and lists it in `hello_ok.caps`; any other socket sees today's behaviour.
   */
  reach: "reach",
  /**
   * Follows (#1317): the client may send `follow`, `unfollow` and `following`
   * and decodes `followed`, `unfollowed`, `follows` and the `follow_limit`
   * error. The hub answers those frames only on a socket whose hello listed
   * it (any other gets `bad_frame`, as an old hub would) and lists it in
   * `hello_ok.caps`; a client sends them only when it did.
   */
  follow: "follow",
  /**
   * Session links (#1822): the client may send `link_bind` and decodes
   * `link_bound`. The hub answers it only on a socket whose hello listed it
   * (any other gets `bad_frame`, as an old hub would) and lists it in
   * `hello_ok.caps`; a client sends it only when it did.
   */
  link: "link",
  /**
   * Link argument (#1856): `/mcp` reads and removes the reserved tool argument
   * `_oa_agent_proof` (LINK_PROOF_ARG) on every `tools/call`. Only a hub that
   * lists it in `hello_ok.caps` may be sent calls carrying it: an older one
   * would hand the argument to a strict tool schema and fail the call. A
   * daemon tells a harness adapter its proof was taken (`link_proofed.bound`)
   * only when the hub listed both `link` and this.
   */
  linkArg: "link_arg",
  /**
   * Waiting mail (#2029): the client decodes roster `waiting` on `away` rows.
   * The hub sends it only to a socket whose hello listed it (with `mailbox`),
   * and lists it in `hello_ok.caps`: a strict decoder without it would refuse
   * the whole roster.
   */
  waiting: "waiting",
  /**
   * Waiting lookup (#2079): the client may send `waiting_query` (up to 64 of
   * its own away `agent_ref`s) and decodes `waiting_counts`. The hub answers
   * only on a socket whose hello listed it (any other gets `bad_frame`, as an
   * old hub would) and lists it in `hello_ok.caps`; a client sends it only
   * when it did.
   */
  waitingQuery: "waiting_query",
  /**
   * Notice acks (#1752): a daemon listing it sends the existing `ack` frame
   * with a notice deliver frame's `msg_id` only once the harness took the
   * notice (nothing while it waits), and `refuse` (reason `closed`) if it is
   * dropped or the session is gone. The hub then reads the notice as held,
   * not delivered, until that ack. A socket without it keeps today's rule:
   * accepted by the socket is delivered.
   */
  noticeAck: "notice_ack",
  /**
<<<<<<< HEAD
   * Chosen names (#2311): the client may send `agent_up.name_chosen: true`
   * for a session whose harness says the user (or a peer) named it. The hub
   * lists it in `hello_ok.caps`; a client sends the key only when it did (an
   * older hub's strict decoder refuses it).
   */
  nameChosen: "name_chosen",
=======
   * Confirmed acks (#2198): a mail `ack` from a socket listing it is answered
   * by `acked {msg_id}` once the hub has durably settled the receipt, or, for
   * an id that can no longer settle (a repeat, unknown, not this machine's),
   * by the same opaque frame. Only on the link the ack came in on. Notice
   * acks are not answered. A daemon listing it keeps an ack record until the
   * hub confirmed it, and sends it again on a new link otherwise.
   */
  ackConfirm: "ack_confirm",
>>>>>>> origin/main
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
