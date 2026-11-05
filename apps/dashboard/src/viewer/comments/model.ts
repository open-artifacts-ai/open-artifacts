import {
  COMMENT_THREADS_MAX,
  CommentIdSchema,
  type CommentThread,
  type ShellToArtifact,
} from "@oa/shared";

/** Where the frame says a thread sits (a hint from page code, never trusted for anything but order). */
export type FramePosition = {
  state: "exact" | "partial" | "collapsed" | "orphan" | "pin";
  top: number | null;
};
export type Positions = ReadonlyMap<string, FramePosition>;

/** Thread numbers by creation order, 1 to 9999: the frame's `n`, and "Pin 3". */
export function numbering(threads: readonly CommentThread[]) {
  const sorted = [...threads].sort(
    (a, b) =>
      a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
  return new Map(sorted.map((t, i) => [t.id, Math.min(i + 1, 9999)]));
}

/**
 * The comments.set payload. Anchors, opaque ids and numbers only: no text, no
 * names, never anything from `comments`. Notes aren't drawn; ids the frame's
 * schema would refuse are left out.
 */
export function frameThreads(
  threads: readonly CommentThread[],
  active: string | null,
): Extract<ShellToArtifact, { type: "comments.set" }>["threads"] {
  const n = numbering(threads);
  const out: Extract<ShellToArtifact, { type: "comments.set" }>["threads"] = [];
  for (const t of threads) {
    if (t.anchor.kind === "note" || !CommentIdSchema.safeParse(t.id).success)
      continue;
    out.push({
      id: t.id,
      anchor: t.anchor,
      n: n.get(t.id),
      ...(t.id === active ? { active: true } : {}),
      ...(t.status === "resolved" ? { resolved: true } : {}),
    });
    if (out.length >= COMMENT_THREADS_MAX) break;
  }
  return out;
}

/**
 * Document order: whole-page notes first, then threads by where the frame
 * placed them, then the ones it couldn't place (by age). Orphans (even the old
 * spot is gone) are returned apart, for the "On earlier text" section.
 */
export function arrange(threads: readonly CommentThread[], pos: Positions) {
  const byAge = (a: CommentThread, b: CommentThread) =>
    a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
  const orphans: CommentThread[] = [];
  const notes: CommentThread[] = [];
  const placed: CommentThread[] = [];
  const unplaced: CommentThread[] = [];
  for (const t of threads) {
    const p = pos.get(t.id);
    if (t.anchor.kind === "note") notes.push(t);
    else if (p?.state === "orphan") orphans.push(t);
    else if (p && p.top !== null) placed.push(t);
    else unplaced.push(t);
  }
  const top = (t: CommentThread) => pos.get(t.id)?.top ?? 0;
  placed.sort((a, b) => top(a) - top(b) || byAge(a, b));
  return {
    ordered: [...notes.sort(byAge), ...placed, ...unplaced.sort(byAge)],
    orphans: orphans.sort(byAge),
  };
}

/** At most `max` passes per `windowMs`: frame messages are forgeable and may flood. */
export function createGate(max: number, windowMs: number, now = Date.now) {
  let stamps: number[] = [];
  return () => {
    const t = now();
    stamps = stamps.filter((s) => t - s < windowMs);
    if (stamps.length >= max) return false;
    stamps.push(t);
    return true;
  };
}
