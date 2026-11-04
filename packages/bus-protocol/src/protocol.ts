import { z } from "zod";
import { CapsSchema } from "./caps.ts";
import { newId } from "./ids.ts";
import { AgentKindSchema, KindTokenSchema } from "./kinds.ts";
import { LIMITS, utf8Exceeds } from "./limits.ts";
import { BusNameSchema } from "./names.ts";
import { WireNamespaceSchema } from "./namespace.ts";
import {
  MsgIdSchema,
  receiptReasonMatchesState,
  receiptShape,
} from "./receipts.ts";
import { AgentRefSchema, MachineLabelSchema } from "./refs.ts";
import { FormerNamesSchema, NameKindSchema } from "./rename.ts";
import {
  IsoTimeSchema,
  StatusLabelSchema,
  StatusStateSchema,
} from "./status.ts";

export const PROTOCOL_VERSION = 1;

/** Bare-string keepalive, never a frame: the daemon sends PING, the hub auto-answers PONG. */
export const PING = "ping";
export const PONG = "pong";

/**
 * `String.prototype.isWellFormed` (ES2024; Node 20+ and Workers). Typed here
 * because the package compiles against lib ES2022.
 */
const isWellFormed = (s: string): boolean =>
  (s as string & { isWellFormed(): boolean }).isWellFormed();

/**
 * Free text: a string with no lone surrogates. A lone surrogate survives
 * `JSON.parse` (as `\ud800`) but is not valid UTF-8, so forwarding it kills
 * the recipient's WebSocket (`WS_ERR_INVALID_UTF8`). Only needed on free-form
 * fields: bus names, namespaces, refs and enums are ASCII-only by regex, and
 * `MachineLabelSchema` already rejects `\p{Cs}`.
 */
const WellFormedText = z
  .string()
  .refine(isWellFormed, "not well-formed Unicode");

const FrameIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const base = { v: z.literal(1), id: FrameIdSchema } as const;

/** One JSON object per WebSocket message. Bodies are capped in UTF-8 bytes. */
const BodySchema = WellFormedText.refine(
  (s) => !utf8Exceeds(s, LIMITS.maxMessageBytes),
  "body too large",
);
const InlineBodySchema = WellFormedText.refine(
  (s) => !utf8Exceeds(s, LIMITS.inlineBodyBytes),
  "inline body too large",
);
const distinct = (a: string[]) => new Set(a).size === a.length;

const Hello = z.strictObject({
  ...base,
  type: z.literal("hello"),
  machine_label: MachineLabelSchema,
  client_version: WellFormedText.pipe(z.string().min(1).max(64)),
  /**
   * Capability tokens (`BUS_CAPS`, caps.ts): the hub gates new fields on
   * them, e.g. roster `former_names` on `rename`. Unknown tokens are ignored.
   * A hub decoder older than this field refuses a hello carrying it (client
   * frames are strict), so a client sends it only to hubs that accept it.
   */
  caps: CapsSchema.optional(),
});

const AgentUp = z.strictObject({
  ...base,
  type: z.literal("agent_up"),
  agent_ref: AgentRefSchema,
  kind: AgentKindSchema,
  proposed_name: WellFormedText.pipe(z.string().max(256)),
  namespace: WireNamespaceSchema,
  global: z.boolean(),
  /**
   * Whose name `proposed_name` is (#393). Absent means `chosen`. A hub
   * decoder older than this field refuses the unknown key, so a client sends
   * it only to hubs that accept it.
   */
  name_kind: NameKindSchema.optional(),
});

const AgentDown = z.strictObject({
  ...base,
  type: z.literal("agent_down"),
  agent_ref: AgentRefSchema,
});

const Sessions = z
  .strictObject({
    ...base,
    type: z.literal("sessions"),
    open: z.array(AgentRefSchema).max(LIMITS.maxRosterAgents),
    closed: z.array(AgentRefSchema).max(LIMITS.maxRosterAgents),
  })
  .refine((f) => {
    if (!distinct(f.open) || !distinct(f.closed)) return false;
    const open = new Set(f.open);
    return !f.closed.some((r) => open.has(r));
  }, "duplicate or overlapping session refs");

/**
 * `to_namespace` names the target only; it never affects the sender's
 * identity, which the daemon attests via `from_ref`. A global sender may
 * target any namespace. A non-global sender may set `to_namespace` to its own
 * (an allowed no-op), or to another namespace ONLY when the name resolves
 * there to a global agent whose home namespace it is; anything else is
 * refused `other_namespace`. The refusal is identical whether or not a
 * non-global agent of that name exists in that namespace, so it cannot be
 * used to probe for existence.
 *
 * Hub resolution:
 * - non-global sender, no `to_namespace`: its own namespace first, then
 *   global agents; a name found in neither is `unknown_agent` even if it is
 *   live in another namespace (other namespaces are invisible). Only an
 *   explicit `to_namespace` is ever refused `other_namespace`.
 * - global sender with `to_namespace`: the name in that namespace.
 * - global sender without it: a global target, or a name matching in exactly
 *   one namespace, resolves; a name matching in two or more is refused
 *   `ambiguous`. Global names are unique, so a global target is never
 *   ambiguous.
 */
const Send = z.strictObject({
  ...base,
  type: z.literal("send"),
  from_ref: AgentRefSchema,
  to_name: BusNameSchema,
  to_namespace: WireNamespaceSchema.optional(),
  body: BodySchema,
});

const Ack = z.strictObject({
  ...base,
  type: z.literal("ack"),
  msg_id: MsgIdSchema,
});

/**
 * The harness did not take the message (Claude `peer_message_status`, a failed
 * prompt, a dead session). `held` is not a refusal: the daemon sends nothing
 * and keeps waiting. `reason` is fixed to `closed` — the spec's pinned refusal
 * reason for "the session could not take it".
 */
const Refuse = z.strictObject({
  ...base,
  type: z.literal("refuse"),
  msg_id: MsgIdSchema,
  reason: z.literal("closed"),
  detail: z.enum(["denied", "refused", "expired", "dropped"]),
});
const List = z.strictObject({
  ...base,
  type: z.literal("list"),
  from_ref: AgentRefSchema,
});
const Fetch = z.strictObject({
  ...base,
  type: z.literal("fetch"),
  from_ref: AgentRefSchema,
  msg_id: MsgIdSchema,
});

/** Self-reported status. Fire and forget: no reply on success. */
const Status = z.strictObject({
  ...base,
  type: z.literal("status"),
  from_ref: AgentRefSchema,
  state: StatusStateSchema,
  label: StatusLabelSchema.optional(),
});

/**
 * Rename a live agent (#393). Answered by `renamed`, or `error`
 * (`not_registered`, `rate_limited` with RENAME_MESSAGES.rate, `bad_frame`).
 * The hub names the agent as for `agent_up`, de-collided the same way. A hub
 * decoder older than this frame refuses it; one that decodes it but lacks the
 * handler (R393b) answers `error bad_frame`.
 */
const Rename = z.strictObject({
  ...base,
  type: z.literal("rename"),
  agent_ref: AgentRefSchema,
  proposed_name: WellFormedText.pipe(z.string().min(1).max(256)),
  /** A tool rename is `chosen`; a harness reverting to its fallback is `default`. Absent means `chosen`. */
  name_kind: NameKindSchema.optional(),
});

const HelloOk = z.strictObject({
  ...base,
  type: z.literal("hello_ok"),
  machine_id: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{16}$/),
  machine_label: MachineLabelSchema,
  server_version: WellFormedText.pipe(z.string().max(1024)),
});

const AgentOk = z.strictObject({
  ...base,
  type: z.literal("agent_ok"),
  agent_ref: AgentRefSchema,
  bus_name: BusNameSchema,
});

/**
 * The reply to `rename`. `former` is the name left; absent on a no-op. Names
 * compare case-insensitively: a case-only change is a rename, and the hub
 * never sends a `former` equal to `bus_name` ignoring case.
 */
const Renamed = z.strictObject({
  ...base,
  type: z.literal("renamed"),
  agent_ref: AgentRefSchema,
  bus_name: BusNameSchema,
  former: BusNameSchema.optional(),
});

/** The reply to `send`: only `pending` or `refused`, never a false `delivered`. */
const ReceiptFrame = z
  .strictObject({ ...base, type: z.literal("receipt"), ...receiptShape })
  .refine(receiptReasonMatchesState, "reason does not match state")
  .refine(
    (f) => f.state === "pending" || f.state === "refused",
    "send receipt is pending or refused",
  );

const RosterAgent = z.strictObject({
  bus_name: BusNameSchema,
  /** Any kind token, so a future kind never fails the whole roster. Shown by its own token. */
  kind: KindTokenSchema,
  namespace: WireNamespaceSchema,
  global: z.boolean(),
  /**
   * `live`: machine connected. `queued`: machine disconnected but the session
   * was last reported open (mail waits up to 1 h). Closed agents are omitted.
   */
  state: z.enum(["live", "queued"]),
  /** The agent's machine label. */
  machine_label: MachineLabelSchema.optional(),
  /** Self-reported ("agent says"); cleared on close. */
  status: StatusStateSchema.optional(),
  status_label: StatusLabelSchema.optional(),
  status_at: IsoTimeSchema.optional(),
  /**
   * Names the agent left that still reach it (#393). Sent only to a socket
   * whose hello listed `BUS_CAPS.rename`: a decoder older than this field
   * refuses the row, and with it the whole roster.
   */
  former_names: FormerNamesSchema.optional(),
});
const Roster = z.strictObject({
  ...base,
  type: z.literal("roster"),
  agents: z.array(RosterAgent).max(LIMITS.maxRosterAgents),
});

const BodyFrame = z.strictObject({
  ...base,
  type: z.literal("body"),
  msg_id: MsgIdSchema,
  body: BodySchema,
});

/**
 * The exact `error rate_limited` messages the hub sends when it refuses an
 * `agent_up` at a live-agent cap (B11). Pinned: clients match on them.
 * `machine`: past LIMITS.maxAgentsPerMachine on the socket's machine;
 * `member`: past LIMITS.maxRosterAgents live agents on the member's bus.
 */
export const AGENT_CAP_MESSAGES = {
  machine: "Too many live agents on this machine",
  member: "Too many live agents on this bus",
} as const;

const ErrorFrame = z.strictObject({
  ...base,
  type: z.literal("error"),
  code: z.enum([
    "bad_frame",
    "not_registered",
    "not_found",
    "too_large",
    "rate_limited",
    "internal",
  ]),
  message: WellFormedText.pipe(z.string().max(1024)),
});

const Notice = z.strictObject({
  size: z.number().int().gt(LIMITS.inlineBodyBytes).max(LIMITS.maxMessageBytes),
  msg_id: MsgIdSchema,
});

const Deliver = z
  .strictObject({
    ...base,
    type: z.literal("deliver"),
    msg_id: MsgIdSchema,
    to_ref: AgentRefSchema,
    from_name: BusNameSchema,
    /** The SENDER's namespace, so a reply can set `to_namespace` from it. */
    namespace: WireNamespaceSchema,
    body: InlineBodySchema.optional(),
    notice: Notice.optional(),
  })
  .refine(
    (f) => (f.body === undefined) !== (f.notice === undefined),
    "body xor notice",
  )
  .refine(
    (f) => f.notice === undefined || f.notice.msg_id === f.msg_id,
    "notice msg_id mismatch",
  );

const ReceiptUpdate = z
  .strictObject({ ...base, type: z.literal("receipt_update"), ...receiptShape })
  .refine(receiptReasonMatchesState, "reason does not match state");

const RosterChanged = z.strictObject({
  ...base,
  type: z.literal("roster_changed"),
  namespace: WireNamespaceSchema,
});

export const CLIENT_FRAMES = [
  "hello",
  "agent_up",
  "agent_down",
  "sessions",
  "send",
  "ack",
  "refuse",
  "list",
  "fetch",
  "status",
  "rename",
] as const;
export const SERVER_FRAMES = [
  "hello_ok",
  "agent_ok",
  "receipt",
  "roster",
  "body",
  "error",
  "deliver",
  "receipt_update",
  "roster_changed",
  "renamed",
] as const;

export const ClientFrameSchema = z.discriminatedUnion("type", [
  Hello,
  AgentUp,
  AgentDown,
  Sessions,
  Send,
  Ack,
  Refuse,
  List,
  Fetch,
  Status,
  Rename,
]);
export const ServerFrameSchema = z.discriminatedUnion("type", [
  HelloOk,
  AgentOk,
  ReceiptFrame,
  Roster,
  BodyFrame,
  ErrorFrame,
  Deliver,
  ReceiptUpdate,
  RosterChanged,
  Renamed,
]);
export const FrameSchema = z.discriminatedUnion("type", [
  Hello,
  AgentUp,
  AgentDown,
  Sessions,
  Send,
  Ack,
  Refuse,
  List,
  Fetch,
  Status,
  Rename,
  HelloOk,
  AgentOk,
  ReceiptFrame,
  Roster,
  BodyFrame,
  ErrorFrame,
  Deliver,
  ReceiptUpdate,
  RosterChanged,
  Renamed,
]);

export type ClientFrame = z.infer<typeof ClientFrameSchema>;
export type ServerFrame = z.infer<typeof ServerFrameSchema>;
export type Frame = z.infer<typeof FrameSchema>;
export type AgentUpFrame = z.infer<typeof AgentUp>;
export type SendFrame = z.infer<typeof Send>;
export type DeliverFrame = z.infer<typeof Deliver>;
export type RefuseFrame = z.infer<typeof Refuse>;
export type HelloFrame = z.infer<typeof Hello>;
export type RenameFrame = z.infer<typeof Rename>;
export type RenamedFrame = z.infer<typeof Renamed>;

/**
 * Serializes a frame with `v` then `id` first, so an oversize id is recoverable.
 * Throws `RangeError` when the text holds a lone surrogate (`JSON.stringify`
 * would emit it as a `\ud800` escape, which every decoder rejects as
 * `bad_frame`). Callers that send user-derived text catch it; the hub's
 * `sendFrame` already does.
 */
export function encodeFrame(frame: Frame): string {
  const { v, id, ...rest } = frame;
  return JSON.stringify({ v, id, ...rest }, (_k, val: unknown) => {
    if (typeof val === "string" && !isWellFormed(val))
      throw new RangeError("encodeFrame: frame contains a lone surrogate");
    return val;
  });
}

/** Correlation id for a new request or unsolicited push. */
export function frameId(): string {
  return newId();
}

export type DecodeResult<F> =
  | { ok: true; frame: F }
  | { ok: false; error: "bad_frame" | "too_large"; id?: string };

/**
 * Wire limits: a body is at most 1 MB of UTF-8 (`maxMessageBytes`), which is at
 * most 2 MB as JSON text once escaped (worst case about 2 chars per byte for
 * quotes and newlines; control characters are rarer but 6 chars each, so the
 * raw cap is 2 MB + 4 KB and the body is re-measured after parsing).
 * A body made mostly of control characters escapes up to 6x, so it can be
 * `too_large` on the wire even though it is under 1 MB of UTF-8.
 */
export const MAX_RAW_FRAME_CHARS = 2 * LIMITS.maxMessageBytes + 4096;
/**
 * Pre-scan caps (outside strings), per direction. `tokens` counts `:` plus
 * `,`; `structural` counts brackets, whole strings, colons and commas, and
 * bounds floods like `[][][]...` that stay shallow and token-free.
 *
 * Client frames (hub side, untrusted daemons) nest at most 4 deep and carry
 * no roster, so they keep the tight caps.
 *
 * Server frames (client side) carry the roster. Its worst row (status fields
 * plus LIMITS.maxFormerNames `former_names` entries, #393) nests 5 deep and
 * uses about 40 tokens and 90 structural characters, so a full 1000-agent
 * roster is about 40000 and 90000: 65536 and 131072 leave ~1.6x and ~1.4x.
 */
type ScanCaps = { depth: number; tokens: number; structural: number };
const CLIENT_CAPS: ScanCaps = { depth: 4, tokens: 16384, structural: 65536 };
const SERVER_CAPS: ScanCaps = { depth: 5, tokens: 65536, structural: 131072 };
/** `:` plus `,` directly inside one object: frame objects have at most about a dozen keys. */
const MAX_OBJECT_TOKENS = 64;
const ID_PREFIX_RE = /^\s*\{"v":1,"id":"([A-Za-z0-9_-]{1,64})"/;

function recoverId(raw: string): string | undefined {
  return ID_PREFIX_RE.exec(raw.slice(0, 96))?.[1];
}

/**
 * One pass, ignoring string contents: false when nesting is deeper than
 * caps.depth or there are more than caps.tokens `:` and `,` outside strings.
 * Bounds JSON.parse and zod's unknown-key scan on hostile input.
 */
function structureOk(raw: string, caps: ScanCaps): boolean {
  let depth = 0;
  let tokens = 0;
  let matches = 0;
  let nextBs = -2; // cached index of the next backslash at or after the scan point; -1 = none
  // `:`/`,` count inside the current container; an object is capped tightly
  // (no frame object has more than a dozen keys), an array by caps.tokens.
  const inObject: boolean[] = [];
  const counts: number[] = [];
  const re = /["{}[\]:,]/g;
  for (let m = re.exec(raw); m !== null; m = re.exec(raw)) {
    if (++matches > caps.structural) return false;
    const c = m[0];
    if (c === '"') {
      // Skip the string, linearly and without regex backtracking. The next
      // quote is found with indexOf; only if a backslash comes first do we
      // walk the escapes char by char (`\x` is two chars, so `\"` is skipped).
      const start = re.lastIndex;
      const q = raw.indexOf('"', start);
      if (q === -1) return false;
      if (nextBs !== -1 && nextBs < start) nextBs = raw.indexOf("\\", start);
      let j = q;
      if (nextBs !== -1 && nextBs < q) {
        let i = nextBs;
        const n = raw.length;
        for (; i < n; i++) {
          const ch = raw.charCodeAt(i);
          if (ch === 92) i++;
          else if (ch === 34) break;
        }
        if (i >= n) return false;
        j = i;
      }
      re.lastIndex = j + 1;
    } else if (c === "{" || c === "[") {
      if (++depth > caps.depth) return false;
      inObject[depth] = c === "{";
      counts[depth] = 0;
    } else if (c === "}" || c === "]") {
      depth--;
    } else {
      if (++tokens > caps.tokens) return false;
      const n = (counts[depth] ?? 0) + 1;
      counts[depth] = n;
      if (inObject[depth] && n > MAX_OBJECT_TOKENS) return false;
    }
  }
  return true;
}

function decode<F>(
  raw: unknown,
  schema: z.ZodType<F>,
  caps: ScanCaps,
): DecodeResult<F> {
  if (typeof raw !== "string") return { ok: false, error: "bad_frame" };
  if (raw.length > MAX_RAW_FRAME_CHARS) {
    const id = recoverId(raw);
    return id
      ? { ok: false, error: "too_large", id }
      : { ok: false, error: "too_large" };
  }
  if (!structureOk(raw, caps)) return { ok: false, error: "bad_frame" };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, error: "bad_frame" };
  }
  let id: string | undefined;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const o = value as Record<string, unknown>;
    if (typeof o.id === "string" && FrameIdSchema.safeParse(o.id).success)
      id = o.id;
    if (
      typeof o.body === "string" &&
      utf8Exceeds(o.body, LIMITS.maxMessageBytes)
    ) {
      return id
        ? { ok: false, error: "too_large", id }
        : { ok: false, error: "too_large" };
    }
  }
  const r = schema.safeParse(value);
  if (r.success) return { ok: true, frame: r.data };
  return id
    ? { ok: false, error: "bad_frame", id }
    : { ok: false, error: "bad_frame" };
}

/** Hub side: accepts only daemon-to-hub frames. Never throws. */
export function decodeClientFrame(raw: unknown): DecodeResult<ClientFrame> {
  return decode(raw, ClientFrameSchema, CLIENT_CAPS);
}

/** Daemon side: accepts only hub-to-daemon frames. Never throws. */
export function decodeServerFrame(raw: unknown): DecodeResult<ServerFrame> {
  return decode(raw, ServerFrameSchema, SERVER_CAPS);
}

export function formatFrameError(
  message: string,
  frameId: string | null,
): string {
  return frameId ? `${message} (frame ${frameId})` : message;
}
