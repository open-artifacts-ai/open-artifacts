/**
 * The inbox as this client reads it (#2512). Items are parsed one at a time
 * against @oa/shared's InboxItemSchema and kept only when their kind is one v1
 * shows: an item that doesn't parse, or a kind this client doesn't show (a new
 * kind, or an approval row: "machine" or contract v6's "proposal", which v1
 * leaves out), is skipped, so it can never blank the list.
 */
import { type Inbox, type InboxItem, InboxItemSchema } from "@oa/shared";
import { z } from "zod";

/** The kinds v1 shows. No approval rows (Product, #2512). */
export const SHOWN_KINDS = [
  "ask",
  "mention",
  "reply",
  "comment",
  "share",
  "decision",
  "away",
] as const;
type ShownKind = (typeof SHOWN_KINDS)[number];

export type Item = InboxItem & { kind: ShownKind };

const shown = (x: InboxItem): x is Item =>
  (SHOWN_KINDS as readonly string[]).includes(x.kind);

/** One item, or null when it isn't one this client shows. */
export function readItem(raw: unknown): Item | null {
  const p = InboxItemSchema.safeParse(raw);
  return p.success && shown(p.data) ? p.data : null;
}

/** Keeps the items it can show; drops the rest. */
const Items = z.array(z.unknown()).transform((xs) =>
  xs.flatMap((x) => {
    const it = readItem(x);
    return it ? [it] : [];
  }),
);

export const ListSchema = z.object({
  needsYou: Items,
  later: Items,
  updates: Items,
  cursor: z.string().nullable(),
  counts: z.object({
    needsYou: z.number().int().min(0),
    unreadUpdates: z.number().int().min(0),
  }),
});
export type List = z.infer<typeof ListSchema>;
export type Counts = Inbox["counts"];

/** POST R.meInboxLater's answer: the deferred item (any kind; it only joins Later when shown). */
export const LaterItemSchema = z.unknown().transform(readItem);
