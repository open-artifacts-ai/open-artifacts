import { z } from "zod";
import { CommentAuthorSchema } from "./comments.js";

/** A same-origin path: starts with one "/", never "//" or a scheme. */
const SameOriginPath = z
  .string()
  .max(2048)
  .refine(
    (h) => {
      if (!h.startsWith("/") || h.startsWith("//") || h.includes("\\"))
        return false;
      // Control characters, space and DEL are refused: URL parsers strip tabs and newlines.
      for (let i = 0; i < h.length; i++) {
        const c = h.charCodeAt(i);
        if (c <= 0x20 || c === 0x7f) return false;
      }
      try {
        return new URL(h, "https://x.invalid").origin === "https://x.invalid";
      } catch {
        return false;
      }
    },
    {
      message: "href must be a same-origin path",
    },
  );

const Iso = z.string().datetime({ offset: true });
const Base64Url = z.string().regex(/^[A-Za-z0-9_-]+$/);
const Hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

/**
 * #3132: a pending role proposal as a card. `holder` is where the role's
 * current holder (priorHolderName) is: live now, or away since a time; null
 * when the role has no holder, or the hub can't say.
 */
export const RoleCardSchema = z.object({
  proposalId: z.string(),
  action: z.enum(["set", "repoint", "clear"]),
  /** The role's name and namespace. */
  name: z.string(),
  namespace: z.string(),
  /** The agent that would hold it (null for a clear). */
  agentName: z.string().nullable(),
  priorHolderName: z.string().nullable(),
  targetMachine: z.string().optional(),
  priorMachine: z.string().optional(),
  holder: z
    .object({ state: z.enum(["live", "away"]), since: Iso.nullable() })
    .nullable(),
  expiresAt: Iso,
});
export type RoleCard = z.infer<typeof RoleCardSchema>;

const roleMinutes = (since: string, now: number) => {
  const t = Date.parse(since);
  const min = Number.isNaN(t) ? 0 : Math.max(1, Math.floor((now - t) / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h} h` : `${Math.floor(h / 24)} d`;
};

/**
 * The sentence on a handover card, in plain words: "OA Platform W wants to
 * take over OA Platform from OA Platform L (away 40 min)." Shared by the
 * server's item text and the dashboard, which passes a live `now`.
 */
export function roleCardText(c: RoleCard, now = Date.now()): string {
  if (c.action === "clear")
    return `An agent asks to remove the role ${c.name}.`;
  const who = c.agentName ?? "An agent";
  if (c.action === "set") return `${who} asks for the role ${c.name}.`;
  const state =
    c.holder === null
      ? ""
      : c.holder.state === "live"
        ? " (live)"
        : c.holder.since
          ? ` (away ${roleMinutes(c.holder.since, now)})`
          : " (away)";
  const target = c.targetMachine
    ? `A new session on the ${c.targetMachine}`
    : "A new session";
  const prior = c.priorMachine
    ? `the ${c.priorMachine} session`
    : "the previous session";
  return `${target} wants to take over ${c.name} from ${prior}${state}.`;
}

export const InboxItemSchema = z
  .object({
    id: z.string(),
    level: z.enum(["needs_you", "update"]),
    kind: z.enum([
      "ask",
      "mention",
      "reply",
      "comment",
      "share",
      "decision",
      "proposal",
      "away",
      "member_set_up",
      "machine_update",
      // #2577: someone asked one of your agents and it is held for you.
      "request",
      // #3132: an agent asks to take over a role (the handover card).
      "role",
    ]),
    urgency: z.enum(["waiting", "approval", "plain"]).optional(),
    waitingSince: Iso.optional(),
    /** Null only for kind "proposal", "role", "away" and "member_set_up"; every other kind has its page. */
    artifact: z.object({ id: z.string(), title: z.string() }).nullable(),
    actor: CommentAuthorSchema.nullable(),
    /** The agent's bus identity id, used by Mute agent. */
    agentKey: z.string().optional(),
    proposal: z
      .object({
        id: z.string(),
        kind: z.enum(["role", "link"]),
        agentName: z.string(),
      })
      .optional(),
    /** Kind "role" (#3132): what the handover card shows; `id` is `role:<proposalId>`. */
    role: RoleCardSchema.optional(),
    away: z
      .object({
        since: Iso,
        count: z.number().int().min(0),
        pages: z.number().int().min(0),
      })
      .optional(),
    text: z.string(),
    /** A mention, reply or comment: the comment's plain text, at most 120 characters. In-app only, never in a push. */
    excerpt: z.string().max(120).optional(),
    href: SameOriginPath,
    createdAt: Iso,
    readAt: Iso.nullable(),
    later: z.object({ until: Iso, used: z.literal(true) }).optional(),
    backFromLater: z.literal(true).optional(),
  })
  .superRefine((item, ctx) => {
    if (
      item.artifact === null &&
      item.kind !== "proposal" &&
      item.kind !== "role" &&
      item.kind !== "away" &&
      item.kind !== "machine_update" &&
      item.kind !== "member_set_up"
    )
      ctx.addIssue({
        code: "custom",
        path: ["artifact"],
        message: "artifact is required for this kind",
      });
  });
export type InboxItem = z.infer<typeof InboxItemSchema>;

export const InboxSchema = z.object({
  needsYou: z.array(InboxItemSchema).max(200),
  later: z.array(InboxItemSchema),
  updates: z.array(InboxItemSchema),
  cursor: z.string().nullable(),
  counts: z.object({
    needsYou: z.number().int().min(0),
    unreadUpdates: z.number().int().min(0),
  }),
});
export type Inbox = z.infer<typeof InboxSchema>;

export const InboxReadBodySchema = z.object({
  ids: z.array(z.string()).max(200),
});
export type InboxReadBody = z.infer<typeof InboxReadBodySchema>;

/** An IANA zone name the runtime knows ("Europe/Paris"). */
const validZone = (z: string): boolean => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: z });
    return true;
  } catch {
    return false;
  }
};

export const InboxLaterBodySchema = z.object({
  until: z.enum(["hour", "morning"]),
  /** The person's zone (the browser's): "morning" is 08:00 there. Absent: the saved zone, then UTC. */
  timeZone: z
    .string()
    .min(1)
    .max(64)
    .refine(validZone, "Unknown time zone")
    .optional(),
});
export type InboxLaterBody = z.infer<typeof InboxLaterBodySchema>;

export const NotificationPrefsSchema = z.object({
  /** The browser preference is shared by every enrolled device. */
  needsYou: z.object({ inApp: z.literal(true), browser: z.boolean() }),
  /** Updates appear in For you. The server always returns browser false. */
  updates: z.object({ inApp: z.literal(true), browser: z.boolean() }),
  browserAllAsks: z.boolean(),
  quietHours: z.object({ start: Hhmm, end: Hhmm }).nullable(),
  timeZone: z.string().min(1).max(64),
  lockScreenDetail: z.boolean(),
});
export type NotificationPrefs = z.infer<typeof NotificationPrefsSchema>;

export const PushKeySchema = z.object({ publicKey: Base64Url });
export type PushKey = z.infer<typeof PushKeySchema>;

export const PushSubscribeBodySchema = z.object({
  endpoint: z
    .string()
    .max(2048)
    .refine((u) => {
      try {
        return new URL(u).protocol === "https:";
      } catch {
        return false;
      }
    }, "endpoint must be an https URL"),
  keys: z.object({ p256dh: Base64Url, auth: Base64Url }),
  label: z.string().max(80).optional(),
});
export type PushSubscribeBody = z.infer<typeof PushSubscribeBodySchema>;

export const PushSubscriptionsSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      label: z.string().nullable(),
      createdAt: Iso,
      lastSentAt: Iso.nullable(),
      /** Existing clients read these as true and false for every enrolled device. */
      needsYou: z.boolean(),
      updates: z.boolean(),
    }),
  ),
});
export type PushSubscriptions = z.infer<typeof PushSubscriptionsSchema>;

/** Legacy device PATCH. Setting needsYou false unenrolls the device. */
export const PushSubscriptionPatchBodySchema = z
  .strictObject({
    needsYou: z.boolean().optional(),
    updates: z.boolean().optional(),
  })
  .refine(
    (b) => b.needsYou !== undefined || b.updates !== undefined,
    "send needsYou or updates",
  );
export type PushSubscriptionPatchBody = z.infer<
  typeof PushSubscriptionPatchBodySchema
>;

export const PushPayloadSchema = z.object({
  v: z.literal(1),
  title: z.string(),
  body: z.string(),
  href: SameOriginPath,
  tag: z.string(),
  count: z.number().int().optional(),
});
export type PushPayload = z.infer<typeof PushPayloadSchema>;

export const InboxMuteBodySchema = z.object({
  kind: z.enum(["agent", "page"]),
  id: z.string(),
});
export type InboxMuteBody = z.infer<typeof InboxMuteBodySchema>;

export const InboxMutesSchema = z.object({
  items: z.array(
    z.object({
      kind: z.enum(["agent", "page"]),
      id: z.string(),
      name: z.string(),
    }),
  ),
});
export type InboxMutes = z.infer<typeof InboxMutesSchema>;
