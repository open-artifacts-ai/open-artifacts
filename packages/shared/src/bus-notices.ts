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

/** GET R.busRoles, ordered by namespace then name. `live` false: the bus could not be asked (roles is then []). */
export const BusRolesSchema = z.strictObject({
  roles: z.array(BusRoleSchema).max(BUS_ROLE_MAX),
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
