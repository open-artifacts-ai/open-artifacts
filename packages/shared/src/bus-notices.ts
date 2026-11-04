import { z } from "zod";

// Collaboration suite, follows and notices (#1292): the bus address the
// server stores for follows and share-notice picks, and the share-notice
// setting's wire shape. The bus packages own the full name rules; these
// match OpenBus's wire rules (names.ts NAME_RE, WireNamespaceSchema).

/** Follows one member may hold across all their agents. */
export const FOLLOW_LIMIT = 200;
/** Addresses one member may pick for share notices. */
export const SHARE_NOTICE_MAX = 10;
/**
 * The sender name of every server notice. Reserved: the bus refuses any
 * agent that proposes it or a look-alike (isNoticeSenderName). The same
 * string as @oa/bus-protocol's INSTANCE_SENDER_NAME (branch
 * suite/bus-protocol); use that constant here once it is on main.
 */
export const NOTICE_SENDER = "open-artifacts";

export type NoticeKind = "shared" | "changed";

/**
 * One notice for one address in one member's bus: the shape the server
 * hands to delivery (#1292) for the hub and the local client to adopt.
 * Nothing in it is authored by a person or an agent.
 */
export type BusNotice = {
  /** Random id, for receipts and logs. */
  id: string;
  kind: NoticeKind;
  /** Always NOTICE_SENDER. */
  from: typeof NOTICE_SENDER;
  artifactId: string;
  version: number;
  /** `<origin>/a/<id>` */
  url: string;
  to: BusAddress;
  /** The fixed template (the server's noticeText). */
  text: string;
  /** Waiting notices with the same (to, coalesceKey) replace each other: the artifact id. */
  coalesceKey: string;
  /** Hold until then (ms epoch); absent: deliver now. */
  notBefore?: number;
};

const BUS_NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9 ._-]{0,62}[A-Za-z0-9_-])?$/;
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** Lowercased with every separator removed, as OpenBus folds reserved names. */
const fold = (s: string) => s.toLowerCase().replace(/[ ._-]/g, "");

/** Whether `name` is NOTICE_SENDER or a look-alike (case, separators, a -N suffix). */
export const isNoticeSenderName = (name: string): boolean =>
  fold(name.replace(/(?:[ ._-]+\d+|[ ._-]+)+$/, "")) === fold(NOTICE_SENDER);

/** One agent address inside a member's bus: (namespace, name). */
export const BusAddressSchema = z.strictObject({
  namespace: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-z0-9._~/-]+$/, "invalid namespace"),
  name: z
    .string()
    .max(64)
    .refine((s) => BUS_NAME_RE.test(s) && !IPV4_RE.test(s), "invalid name")
    .refine((s) => !isNoticeSenderName(s), "reserved name"),
});
export type BusAddress = z.infer<typeof BusAddressSchema>;

/** GET/PUT R.shareNotices. A repeated address is stored once. */
export const ShareNoticeAgentsSchema = z.strictObject({
  agents: z.array(BusAddressSchema).max(SHARE_NOTICE_MAX),
});
export type ShareNoticeAgents = z.infer<typeof ShareNoticeAgentsSchema>;

/** Role addresses one member may hold (#1296). */
export const BUS_ROLE_MAX = 100;

/**
 * One of the caller's role addresses (#1296): an alias in one namespace
 * pointing at one agent, by its stable id (it follows renames). `holderName`
 * is that agent's current name (its last one if it closed), null when no
 * holder is set or its row is gone. `vacant`: a send to the role is refused
 * now (no holder, or the holder is closed, gone or out of the namespace).
 */
export const BusRoleSchema = z.strictObject({
  id: z.string(),
  namespace: BusAddressSchema.shape.namespace,
  name: BusAddressSchema.shape.name,
  agentId: z.string().nullable(),
  holderName: z.string().nullable(),
  vacant: z.boolean(),
  setAt: z.string(),
});
export type BusRole = z.infer<typeof BusRoleSchema>;

/** How long a role proposal's confirm link works (#1372). */
export const BUS_ROLE_PROPOSAL_TTL_MS = 15 * 60_000;
/** Pending role proposals one member may have at once (#1372). */
export const BUS_ROLE_PROPOSALS_PENDING_MAX = 20;
/** The newest role proposals GET R.busRoles lists, pending or decided (#1372). */
export const BUS_ROLE_PROPOSALS_LISTED = 20;

/**
 * What a role proposal does once confirmed (#1372): `set` creates the role
 * and points it at `agentId`, `repoint` points an existing role at
 * `agentId`, `clear` removes the role (as DELETE R.busRole(id)).
 */
export const BusRoleProposalActionSchema = z.enum(["set", "repoint", "clear"]);
export type BusRoleProposalAction = z.infer<typeof BusRoleProposalActionSchema>;

/**
 * Where a role proposal stands: `pending` until the member confirms it on
 * its link (`applied`), turns it down or it can't apply (`refused`, with
 * `reason`), or its link runs out (`expired`).
 */
export const BusRoleProposalStatusSchema = z.enum([
  "pending",
  "applied",
  "refused",
  "expired",
]);
export type BusRoleProposalStatus = z.infer<typeof BusRoleProposalStatusSchema>;

/**
 * One role change an AI agent proposed for the member over MCP
 * (bus_role_propose, #1372). Nothing changes until the member confirms it in
 * a browser. `agentId`/`agentName`: the new holder (null for clear);
 * `priorAgentId`/`priorHolderName`: the holder it displaces, as of the
 * proposal (null when none). Names are the agents' current ones. Never the
 * confirm link.
 */
export const BusRoleProposalSchema = z.strictObject({
  id: z.string(),
  action: BusRoleProposalActionSchema,
  namespace: BusAddressSchema.shape.namespace,
  name: BusAddressSchema.shape.name,
  roleId: z.string().nullable(),
  agentId: z.string().nullable(),
  agentName: z.string().nullable(),
  priorAgentId: z.string().nullable(),
  priorHolderName: z.string().nullable(),
  status: BusRoleProposalStatusSchema,
  /** Why it was refused: `rejected` (the member said no), `changed` (the role moved since), or a PUT R.busRoles refusal reason. */
  reason: z.string().nullable(),
  createdAt: z.string(),
  expiresAt: z.string(),
  decidedAt: z.string().nullable(),
});
export type BusRoleProposal = z.infer<typeof BusRoleProposalSchema>;

/**
 * GET R.busRoles, ordered by namespace then name. `live` false: the bus
 * could not be asked (roles and proposals are then []). `proposals`: the
 * newest BUS_ROLE_PROPOSALS_LISTED role proposals, newest first (#1372).
 */
export const BusRolesSchema = z.strictObject({
  roles: z.array(BusRoleSchema).max(BUS_ROLE_MAX),
  proposals: z.array(BusRoleProposalSchema).max(BUS_ROLE_PROPOSALS_LISTED),
  live: z.boolean(),
});
export type BusRoles = z.infer<typeof BusRolesSchema>;

/** PUT R.busRoles: point the role (namespace, name) at `agentId`, or vacate it (null). */
export const BusRolePutSchema = z.strictObject({
  namespace: BusAddressSchema.shape.namespace,
  name: BusAddressSchema.shape.name,
  agentId: z.string().min(1).max(64).nullable(),
});
export type BusRolePut = z.infer<typeof BusRolePutSchema>;

/**
 * MCP bus_role_propose (#1372): propose pointing the role (namespace, name)
 * at the open agent named `agent` (action "set": creates the role, or
 * re-points it), or removing the role ("clear", no agent). `agent` is a bus
 * name, as agents see each other on the bus; the hub binds the proposal to
 * that agent's id. One object, not a union, so every MCP client takes the
 * schema; the tool refuses a "set" without `agent` or a "clear" with one.
 * Nothing changes until the member confirms it on the returned link.
 */
export const BusRoleProposeInputSchema = z.strictObject({
  action: z.enum(["set", "clear"]),
  namespace: BusAddressSchema.shape.namespace,
  name: BusAddressSchema.shape.name,
  agent: BusAddressSchema.shape.name.optional(),
});
export type BusRoleProposeInput = z.infer<typeof BusRoleProposeInputSchema>;
