// AC5a: a published 0.54.0 adapter's IPC decoder, frozen: v0.54.0's
// packages/ipc/src/frames.ts (`git show v0.54.0:packages/ipc/src/frames.ts`),
// verbatim but for its receipt reasons, pinned to v0.54.0's enum
// (packages/shared/src/receipts.ts at the tag: no `role_vacant`). The other
// @oa/bus-protocol schemas are today's. A daemon must answer a client below
// AGENT_CARD_MIN_CLIENT within it.
import {
  type AgentKind,
  AgentKindSchema,
  AgentRefSchema,
  BusNameSchema,
  KindTokenSchema,
  MachineLabelSchema,
  MsgIdSchema,
  WireNamespaceSchema,
} from "@oa/bus-protocol";
import { z } from "zod";

const RefusalReasonSchema = z.enum([
  "unknown_agent",
  "closed",
  "inbox_full",
  "too_large",
  "other_namespace",
  "revoked",
  "ambiguous",
]);
const ReceiptReasonSchema = z.union([
  RefusalReasonSchema,
  z.literal("recipient_closed"),
]);

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

/**
 * The IPC marker (C23c): sent by every adapter and CLI from 0.45.0, whose
 * decoders take any kind token. Its absence marks a 0.44.x client, whose
 * strict kind enum the daemon answers within (legacy.ts). Older daemons
 * strip it: unknown keys are dropped, never refused.
 */
const clientVersion = {
  client_version: z.string().min(1).max(64).optional(),
};

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
export const Self = z.object({ ...base, ...optIn, type: z.literal("self") });
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

/**
 * A local CLI asking the daemon how it is (`oa-bus status`, `install`). No
 * hello: the socket is the user's own (0600). `cwd` picks the namespace.
 */
export const StatusRequest = z.object({
  ...base,
  ...clientVersion,
  type: z.literal("status"),
  cwd: z.string().min(1).max(4096).optional(),
});
export type StatusRequest = z.infer<typeof StatusRequest>;

export const AdapterFrame = z.discriminatedUnion("type", [
  Hello,
  Send,
  List,
  Self,
  Fetch,
  Ack,
]);
export type AdapterFrame = z.infer<typeof AdapterFrame>;

export const AgentInfo = z.object({
  name: z.string(),
  namespace: z.string(),
  kind: KIND_TOKEN,
  /** `state === "live"`; kept for older adapters. */
  live: z.boolean(),
  /** Roster entries only: `queued` means the agent's machine is disconnected. */
  state: z.enum(["live", "queued"]).optional(),
  global: z.boolean(),
  /** The agent's machine (B13); absent when the hub is older. */
  machine_label: MachineLabelSchema.optional(),
});

export const Welcome = z.object({
  ...base,
  type: z.literal("welcome"),
  agent_ref: AGENT_REF,
  bus_name: z.string(),
  namespace: z.string(),
  global: z.boolean(),
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
  /** The namespace `cwd` resolves to, when the request named one. */
  namespace: z.string().optional(),
  /** One roster per namespace: this machine's sessions', or only `cwd`'s. */
  namespaces: z.array(
    z.object({
      namespace: z.string(),
      agents: z.array(
        z.object({
          name: z.string(),
          kind: KIND_TOKEN,
          /** Empty when the hub does not say which machine. */
          machine: z.string(),
          state: z.enum(["live", "queued"]),
        }),
      ),
    }),
  ),
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

export const DaemonFrame = z.discriminatedUnion("type", [
  Welcome,
  Receipt,
  Roster,
  Agent,
  Body,
  Deliver,
  Notice,
  ErrorFrame,
  StatusReply,
]);
export type DaemonFrame = z.infer<typeof DaemonFrame>;
