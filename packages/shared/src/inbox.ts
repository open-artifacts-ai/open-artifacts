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
      "machine",
      "away",
    ]),
    urgency: z.enum(["waiting", "approval", "plain"]).optional(),
    waitingSince: Iso.optional(),
    /** Null only for kind "machine" and "away"; every other kind has its page. */
    artifact: z.object({ id: z.string(), title: z.string() }).nullable(),
    actor: CommentAuthorSchema.nullable(),
    /** The agent's roster key, used by Mute agent. */
    agentKey: z.string().optional(),
    machine: z.object({ id: z.string(), name: z.string() }).optional(),
    away: z
      .object({
        since: Iso,
        count: z.number().int().min(0),
        pages: z.number().int().min(0),
      })
      .optional(),
    text: z.string(),
    href: SameOriginPath,
    createdAt: Iso,
    readAt: Iso.nullable(),
    later: z.object({ until: Iso, used: z.literal(true) }).optional(),
    backFromLater: z.literal(true).optional(),
  })
  .superRefine((item, ctx) => {
    if (
      item.artifact === null &&
      item.kind !== "machine" &&
      item.kind !== "away"
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

export const InboxLaterBodySchema = z.object({
  until: z.enum(["hour", "morning"]),
});
export type InboxLaterBody = z.infer<typeof InboxLaterBodySchema>;

export const NotificationPrefsSchema = z.object({
  needsYou: z.object({ inApp: z.literal(true), browser: z.boolean() }),
  updates: z.object({ inApp: z.literal(true), browser: z.literal(false) }),
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
    }),
  ),
});
export type PushSubscriptions = z.infer<typeof PushSubscriptionsSchema>;

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
