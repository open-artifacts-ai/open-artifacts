import { z } from "zod";

/** A same-origin path: starts with one "/", never "//" or a scheme. */
const SameOriginPath = z
  .string()
  .max(2048)
  .refine(
    (h) => h.startsWith("/") && !h.startsWith("//") && !h.includes("\\"),
    {
      message: "href must be a same-origin path",
    },
  );

const Iso = z.string();
const Base64Url = z.string().regex(/^[A-Za-z0-9_-]+$/);
const Hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export const InboxItemSchema = z.object({
  id: z.string(),
  level: z.enum(["needs_you", "update"]),
  kind: z.enum(["ask", "mention", "reply", "comment", "share", "decision"]),
  urgency: z.enum(["waiting", "approval", "plain"]).optional(),
  waitingSince: Iso.optional(),
  artifact: z.object({ id: z.string(), title: z.string() }),
  actor: z
    .object({ kind: z.enum(["person", "agent"]), name: z.string() })
    .nullable(),
  text: z.string(),
  href: SameOriginPath,
  createdAt: Iso,
  readAt: Iso.nullable(),
  later: z.object({ until: Iso, used: z.literal(true) }).optional(),
  backFromLater: z.literal(true).optional(),
});
export type InboxItem = z.infer<typeof InboxItemSchema>;

export const InboxSchema = z.object({
  needsYou: z.array(InboxItemSchema),
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
