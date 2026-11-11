import {
  type AgentKind,
  AgentKindSchema,
  AgentRefSchema,
  BusNameSchema,
  IsoTimeSchema,
  KindTokenSchema,
  LinkProofHashSchema,
  MachineLabelSchema,
  MsgIdSchema,
  REACH_PROPOSAL_MAX,
  ReceiptReasonSchema,
  RefusalReasonSchema,
  StatusLabelSchema,
  StatusStateSchema,
  WireNamespaceSchema,
} from "@oa/bus-protocol";
import { z } from "zod";

export const V = 1 as const;
export const MAX_BODY_BYTES = 1024 * 1024;
export const MAX_LINE_BYTES = 4 * 1024 * 1024;
export const INLINE_CAP_BYTES = 32 * 1024;

export const KIND = AgentKindSchema;
export type Kind = AgentKind;
/** A kind the daemon reports (roster, self, status): any token, shown via displayKind. */
export const KIND_TOKEN = KindTokenSchema;

/** Stable per-session handle: Claude sessionId, OpenCode root ses_, Pi session id. */
export const AGENT_REF = AgentRefSchema;
export const REFUSAL = RefusalReasonSchema;

const base = { v: z.literal(V), id: z.string().min(1).max(64) };
/**
 * On a reply to an agent's request: notices of its messages the hub delivered
 * after send_message stopped waiting, each sent once. The adapter appends them
 * to the tool result.
 */
const late = { late: z.array(z.string().min(1)).optional() };

/** No lone surrogates: text the hub, and a WebSocket, can carry. */
export const isWellFormed = (s: string): boolean =>
  (s as string & { isWellFormed(): boolean }).isWellFormed();
const WELL_FORMED = { message: "text is not well-formed unicode" };

/** The package version an adapter or CLI was built with, set by the bundler (packages/cli/scripts/bundle.mjs). */
declare const __OA_BUS_VERSION__: string | undefined;
export const CLIENT_VERSION: string =
  typeof __OA_BUS_VERSION__ === "string" ? __OA_BUS_VERSION__ : "0.0.0";

/** The adapter's or CLI's build version, for logs. The daemon never gates on it. */
const clientVersion = {
  client_version: z.string().min(1).max(64).optional(),
};

/**
 * What an adapter tells the daemon it can decode, in `hello.caps` (#1295).
 * `mailbox`: roster rows with `state: "away"` and `since`, and the
 * `mailbox_full` and `reserved_name` refusals. The daemon sends those only to
 * an adapter that listed it; an older one would fail to decode them.
 */
export const ADAPTER_CAPS = {
  mailbox: "mailbox",
  /**
   * `pending` (#1525): a `config_files` entry with `state: "pending"`, a
   * namespace waiting for the user's approval. An older strict decoder would
   * reject the whole frame on it, so the daemon sends it only to a client that
   * listed this.
   */
  pending: "pending",
  /**
   * `rename` (#1635): the adapter may send a `rename` frame when its session
   * is renamed. The daemon lists `rename` in `welcome.caps` only for an
   * adapter that listed it, and an adapter sends the frame only to a daemon
   * whose welcome listed it, so neither side meets a frame its decoder lacks.
   */
  rename: "rename",
  /**
   * `follow` (#1317): the adapter may send `follow`, `unfollow` and
   * `following`. The daemon lists `follow` in `welcome.caps` only for an
   * adapter that listed it, and an adapter sends the frames only to a daemon
   * whose welcome listed it. The adapter tools are offered either way: a
   * daemon without it answers them with a plain "update" error instead.
   */
  follow: "follow",
  /**
   * `reach` (#1346): the adapter may send `propose_reach`. The daemon lists
   * `reach` in `welcome.caps` only for an adapter that listed it. The adapter
   * tool is offered either way: a daemon without it answers with a plain
   * "update" error. The request goes to the hub over HTTP, so there is no
   * hub cap: a hub without the route answers 404.
   */
  reach: "reach",
  /**
   * `link` (#1856): the adapter may send a hello'd `link_proof` (its root's
   * proof hash, no pid) and decodes `link_proofed`. The daemon lists `link` in
   * `welcome.caps` only for an adapter that listed it, and an adapter sends
   * the frame only to a daemon whose welcome listed it.
   */
  link: "link",
} as const;

export { REACH_PROPOSAL_MAX };

export const Hello = z.object({
  ...base,
  ...clientVersion,
  type: z.literal("hello"),
  kind: KIND,
  agent_ref: AGENT_REF,
  /** The adapter process. The daemon walks its ancestry; it is never trusted alone. */
  pid: z.number().int().positive(),
  /**
   * Optional only for codex, whose cwd the daemon reads from the rollout
   * (C26j); the daemon refuses any other kind without one.
   */
  cwd: z.string().min(1).max(4096).optional(),
  proposed_name: z
    .string()
    .min(1)
    .max(64)
    .refine(isWellFormed, WELL_FORMED)
    .optional(),
  /** What this adapter can decode (ADAPTER_CAPS); absent means none. */
  caps: z.array(z.string().max(32)).max(16).optional(),
  /**
   * #1608: the token the daemon's first welcome for this ref issued. A pi-like
   * ref stays bound to its first claimant after the link closes; a later hello
   * proves it is the same adapter by echoing this. Memory only, never logged.
   */
  bind_token: z.string().min(16).max(128).optional(),
  /** What the harness told the adapter, re-checked by the daemon. */
  attest: z
    .object({
      session_id: z.string().optional(),
      socket_path: z.string().optional(),
      proc_start: z.string().optional(),
      tui_pids: z.array(z.number().int().positive()).optional(),
    })
    .default({}),
  /**
   * What a Codex tools/call carried in `_meta` (C26b): Codex gives its MCP
   * server no session env, so identity arrives per call, and each call
   * re-proves itself. Optional: other kinds never send it, and older daemons
   * strip it.
   */
  codex: z
    .object({
      thread_id: AGENT_REF,
      call_id: z.string().min(1).max(256),
      /** The adapter's parent: the codex process hosting the thread. */
      ppid: z.number().int().positive(),
      /**
       * The turn metadata's `thread_source`, as Codex sent it: the daemon
       * decides what it admits. Absent when Codex sent none (an app-server
       * thread started without threadSource, C26j).
       */
      thread_source: z.string().min(1).max(64).optional(),
      /**
       * Code mode (C27): `_meta.itemId`, the outer `exec` custom_tool_call's
       * item id, which the rollout has when the call is made; `call_id` is
       * then a fresh `exec-<uuid>` that it never has. Older daemons strip it.
       */
      item_id: z.string().min(1).max(256).optional(),
      /** The turn metadata's `turn_id`: a code-mode call must be in it. */
      turn_id: z.string().min(1).max(256).optional(),
    })
    .optional(),
});
export type Hello = z.infer<typeof Hello>;

/**
 * The Codex `thread_source` values that mark a thread Codex spawned itself,
 * not the user's (codex-rs `ThreadSource`, all present in the 0.165 binary).
 * The adapter refuses them; the daemon decides from Codex's own state.
 */
export const SPAWNED_SOURCES: ReadonlySet<string> = new Set([
  "subagent",
  "guardian_review",
  "memory_consolidation",
]);

/** A tool call's request: its reply carries the agent's late-delivery notices. */
const optIn = { late: z.literal(true).optional() };

export const Send = z.object({
  ...base,
  ...optIn,
  type: z.literal("send"),
  to: BusNameSchema.refine(isWellFormed, WELL_FORMED),
  /** The target's namespace, for a global sender; forwarded as `to_namespace`. */
  namespace: WireNamespaceSchema.refine(isWellFormed, WELL_FORMED).optional(),
  body: z
    .string()
    .min(1)
    .refine((b) => Buffer.byteLength(b, "utf8") <= MAX_BODY_BYTES, {
      message: `body exceeds ${MAX_BODY_BYTES} bytes`,
    })
    .refine(isWellFormed, WELL_FORMED),
});
export const List = z.object({ ...base, ...optIn, type: z.literal("list") });
export const Self = z.object({
  ...base,
  ...optIn,
  type: z.literal("self"),
  /**
   * The `self` tool: also look up this agent's own roster row, for its status.
   * Costs a hub round trip, so internal lookups leave it out.
   */
  row: z.literal(true).optional(),
});
export const Fetch = z.object({
  ...base,
  ...optIn,
  type: z.literal("fetch"),
  msg_id: MsgIdSchema,
});
export const Ack = z.object({
  ...base,
  type: z.literal("ack"),
  msg_id: MsgIdSchema,
});

/** The agent's own status claim: the daemon sends it to the hub as a `status` frame. */
export const SetStatus = z.object({
  ...base,
  ...optIn,
  type: z.literal("set_status"),
  state: StatusStateSchema,
  label: StatusLabelSchema.optional(),
});
/**
 * The session was renamed (#1635): the new bus name, already a slug. Fire and
 * forget; the daemon tells the hub once and answers only a refusal.
 */
export const Rename = z.object({
  ...base,
  ...optIn,
  type: z.literal("rename"),
  name: z.string().min(1).max(64).refine(isWellFormed, WELL_FORMED),
});
/**
 * Follow, unfollow or list follows (#1317). The agent is the connection's
 * attested one and the member is the machine's: the frames name neither. The
 * daemon forwards them to the hub only when its hello_ok listed `follow`.
 */
export const Follow = z.object({
  ...base,
  ...optIn,
  type: z.literal("follow"),
  artifact: z.string().min(1).max(2048).refine(isWellFormed, WELL_FORMED),
});
export const Unfollow = z.object({
  ...base,
  ...optIn,
  type: z.literal("unfollow"),
  artifact: z.string().min(1).max(2048).refine(isWellFormed, WELL_FORMED),
});
export const Following = z.object({
  ...base,
  ...optIn,
  type: z.literal("following"),
});
/**
 * Ask that the role this agent holds reach more namespaces (#1346). The agent
 * is the connection's attested one: the frame names no session, role or
 * address. Answered by `reach_proposed`, or `error`.
 */
export const ProposeReach = z.object({
  ...base,
  ...optIn,
  type: z.literal("propose_reach"),
  namespaces: z.array(WireNamespaceSchema).min(1).max(REACH_PROPOSAL_MAX),
});
/**
 * A local CLI asking the daemon how it is (`oa-bus status`, `install`). No
 * hello: the socket is the user's own (0600). `cwd` picks the namespace.
 */
export const StatusRequest = z.object({
  ...base,
  ...clientVersion,
  type: z.literal("status"),
  cwd: z.string().min(1).max(4096).optional(),
  /** What this client can decode (ADAPTER_CAPS); absent means none. */
  caps: z.array(z.string().max(32)).max(16).optional(),
});
export type StatusRequest = z.infer<typeof StatusRequest>;

/**
 * `oa-bus mcp-proof` telling the daemon a Claude process's proof hash (#1822).
 * No hello, like `status`: the socket is the user's own (0600). `pid` is the
 * Claude process the helper found; the daemon binds the hash only to a live
 * Claude record it attested for that pid.
 */
export const LinkProofRequest = z.object({
  ...base,
  type: z.literal("link_proof"),
  pid: z.number().int().positive(),
  hash: LinkProofHashSchema,
});
export type LinkProofRequest = z.infer<typeof LinkProofRequest>;

/**
 * A harness adapter telling the daemon its root's proof hash on its own
 * hello'd link (#1856, `ADAPTER_CAPS.link`). It names no agent and no pid: the
 * daemon binds the hash to the agent this connection's hello attested, so a
 * link cannot speak for any other. Strict, so a frame that tries is refused.
 */
export const AdapterLinkProof = z
  .object({
    ...base,
    type: z.literal("link_proof"),
    hash: LinkProofHashSchema,
  })
  .strict();
export type AdapterLinkProof = z.infer<typeof AdapterLinkProof>;

export const AdapterFrame = z.discriminatedUnion("type", [
  Hello,
  Send,
  List,
  Self,
  Fetch,
  Ack,
  SetStatus,
  Rename,
  Follow,
  Unfollow,
  Following,
  ProposeReach,
  AdapterLinkProof,
]);
export type AdapterFrame = z.infer<typeof AdapterFrame>;

/**
 * A config file the daemon refused or noted (#1527). `reason` completes
 * "<file> …"; `fix` is the exact step. `pending` (#1525): a namespace waiting for approval.
 */
export const ConfigFile = z.object({
  file: z.string(),
  /** `pending` (#1525) goes only to clients that listed ADAPTER_CAPS.pending. */
  state: z.enum(["refused", "noted", "pending"]),
  reason: z.string(),
  fix: z.string(),
});
export type ConfigFile = z.infer<typeof ConfigFile>;

/** Where a namespace came from (#1570): an approved `.oa-bus.json`, the git remote, the git folder's name, or the cwd's. */
export const NamespaceSource = z.enum(["config", "git", "dir", "cwd"]);

export const AgentInfo = z.object({
  name: z.string(),
  namespace: z.string(),
  /** `self` only (#1570). */
  namespace_source: NamespaceSource.optional(),
  kind: KIND_TOKEN,
  /** `state === "live"`; kept for older adapters. */
  live: z.boolean(),
  /**
   * Roster entries only: `queued` means the agent's machine is disconnected;
   * `away` (#1295) means it is closed and its mailbox is kept, with `since`.
   */
  state: z.enum(["live", "queued", "away"]).optional(),
  /** When an `away` agent closed. */
  since: IsoTimeSchema.optional(),
  /** #2029: mail pending to an `away` agent, capped at 100. */
  waiting: z.number().int().min(1).max(100).optional(),
  global: z.boolean(),
  /** The agent's machine (B13); absent when the hub is older. */
  machine_label: MachineLabelSchema.optional(),
  /** The agent's own status claim, from the hub. */
  status: StatusStateSchema.optional(),
  status_label: StatusLabelSchema.optional(),
  status_at: IsoTimeSchema.optional(),
  /** `self` with `row` only: config files refused or noted. Older adapters ignore it. */
  config_files: z.array(ConfigFile).optional(),
});

export const Welcome = z.object({
  ...base,
  type: z.literal("welcome"),
  agent_ref: AGENT_REF,
  bus_name: z.string(),
  namespace: z.string(),
  global: z.boolean(),
  /** What this daemon accepts (ADAPTER_CAPS), only for an adapter that listed `rename` or `follow`. */
  caps: z.array(z.string().max(32)).max(16).optional(),
  /** #1608: pi-like kinds only. Echo it in every later hello for this ref. */
  bind_token: z.string().min(16).max(128).optional(),
});
export const Receipt = z.object({
  ...base,
  type: z.literal("receipt"),
  msg_id: z.string(),
  state: z.enum(["pending", "delivered", "expired", "refused"]),
  reason: ReceiptReasonSchema.optional(),
  /**
   * The daemon answered for a send it holds for resend (C16): `msg_id` is its
   * frame id, not a hub msg_id, so never show it or `fetch` it.
   */
  held: z.literal(true).optional(),
  /** The daemon's own copy for this result: shown as-is, never as an error. */
  text: z.string().min(1).optional(),
  ...late,
});
export const Roster = z.object({
  ...base,
  type: z.literal("roster"),
  agents: z.array(AgentInfo),
  ...late,
});
export const Agent = z.object({
  ...base,
  type: z.literal("agent"),
  agent: AgentInfo.nullable(),
  ...late,
});
/** set_status was taken; the hub answers nothing on success. */
export const StatusSet = z.object({
  ...base,
  type: z.literal("status_set"),
  /** An earlier status the hub refused, or that never reached it: show it with this result. */
  earlier: z.object({ code: z.string(), message: z.string() }).optional(),
  ...late,
});
/** One followed artifact, as the hub lists it. */
const FollowEntry = z.object({
  artifact_id: z.string(),
  url: z.string(),
  followed_at: z.string(),
});
/** The reply to `follow`. */
export const Followed = z.object({
  ...base,
  type: z.literal("followed"),
  ...FollowEntry.shape,
  ...late,
});
/** The reply to `unfollow`. */
export const Unfollowed = z.object({
  ...base,
  type: z.literal("unfollowed"),
  removed: z.boolean(),
  ...late,
});
/** The reply to `following`, newest first. */
export const Follows = z.object({
  ...base,
  type: z.literal("follows"),
  follows: z.array(FollowEntry),
  ...late,
});
/** The reply to `propose_reach`: the one-time link for the member, and when it expires. */
export const ReachProposed = z.object({
  ...base,
  type: z.literal("reach_proposed"),
  confirm_url: z.string(),
  expires_at: z.string(),
  ...late,
});
export const Body = z.object({
  ...base,
  type: z.literal("body"),
  msg_id: z.string(),
  body: z.string(),
  ...late,
});
export const Deliver = z
  .object({
    ...base,
    type: z.literal("deliver"),
    msg_id: z.string(),
    from_name: z.string(),
    namespace: z.string(),
    body: z.string().optional(),
    notice: z.object({ size: z.number(), msg_id: z.string() }).optional(),
  })
  .refine((d) => (d.body === undefined) !== (d.notice === undefined), {
    message: "deliver needs exactly one of body or notice",
  });
/** A short local notice from Open Artifacts bus (the sender's mail expired or was refused); never a message. */
export const Notice = z.object({
  ...base,
  type: z.literal("notice"),
  text: z.string().min(1),
  /** The message the notice is about. */
  msg_id: z.string().optional(),
});
export const ErrorFrame = z.object({
  ...base,
  type: z.literal("error"),
  code: z.string(),
  message: z.string(),
  ...late,
});

export const StatusReply = z.object({
  ...base,
  type: z.literal("status"),
  pid: z.number().int().positive(),
  version: z.string(),
  label: z.string(),
  hub: z.enum(["connected", "connecting"]),
  /** Why the hub link is down: a Node error code, `timeout` or `HTTP 502`. */
  hub_error: z.string().optional(),
  /** The link has been open at least once since the daemon started. Older daemons omit it. */
  hub_ever: z.boolean().optional(),
  /** Ms epoch of the last drop, while the link is down after being up. Older daemons omit it. */
  hub_since: z.number().optional(),
  /** The hub's `server_version` from its last `hello_ok`. Absent before one, and from older daemons. */
  hub_version: z.string().optional(),
  /** This daemon takes `link_proof` (#1822). Older daemons omit it. */
  link: z.boolean().optional(),
  /** The namespace `cwd` resolves to, when the request named one. */
  namespace: z.string().optional(),
  /** One roster per namespace: this machine's sessions', or only `cwd`'s. */
  namespaces: z.array(
    z.object({
      namespace: z.string(),
      /** Where it came from (#1570); absent from older daemons. */
      source: NamespaceSource.optional(),
      agents: z.array(
        z.object({
          name: z.string(),
          kind: KIND_TOKEN,
          /** Empty when the hub does not say which machine. */
          machine: z.string(),
          state: z.enum(["live", "queued"]),
          status: StatusStateSchema.optional(),
          status_label: StatusLabelSchema.optional(),
          status_at: IsoTimeSchema.optional(),
        }),
      ),
    }),
  ),
  /** Config files refused or noted (#1527). Absent from older daemons, and when there are none. */
  config_files: z.array(ConfigFile).optional(),
  /** Messages sent from this machine the hub delivered after the 5 s window, within the last hour. */
  late: z
    .array(
      z.object({
        from: z.string(),
        to: z.string(),
        /** `excerptOf` the body; absent when unknown. */
        excerpt: z.string().optional(),
        /** When it was delivered, ms since the epoch. */
        at: z.number(),
      }),
    )
    .optional(),
});
export type StatusReply = z.infer<typeof StatusReply>;

/** The reply to `link_proof` (either form): whether a live record took the hash. */
export const LinkProofed = z.object({
  ...base,
  type: z.literal("link_proofed"),
  bound: z.boolean(),
});

export const DaemonFrame = z.discriminatedUnion("type", [
  LinkProofed,
  Welcome,
  Receipt,
  Roster,
  Agent,
  Body,
  Deliver,
  Notice,
  ErrorFrame,
  StatusReply,
  StatusSet,
  Followed,
  Unfollowed,
  Follows,
  ReachProposed,
]);
export type DaemonFrame = z.infer<typeof DaemonFrame>;
