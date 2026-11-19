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
  // #2577: someone asked one of your agents; held for you.
  "request",
] as const;
type ShownKind = (typeof SHOWN_KINDS)[number];

export type Item = InboxItem & {
  kind: ShownKind;
  /** #2570 (contract v7, PROVISIONAL until @oa/shared has it): a mention's comment quote. */
  excerpt?: string;
};

const shown = (x: InboxItem): x is Item =>
  (SHOWN_KINDS as readonly string[]).includes(x.kind);

/** #2570: the quote, when the server sends one (the shared schema drops it). */
const excerptOf = (raw: unknown) => {
  const e = (raw as { excerpt?: unknown } | null)?.excerpt;
  return typeof e === "string" && e.trim() ? e.trim() : undefined;
};

/** One item, or null when it isn't one this client shows. */
export function readItem(raw: unknown): Item | null {
  const p = InboxItemSchema.safeParse(raw);
  if (!p.success || !shown(p.data)) return null;
  const excerpt = excerptOf(raw);
  // The schema may now pass a raw excerpt through: a blank one is dropped.
  return { ...p.data, excerpt };
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
