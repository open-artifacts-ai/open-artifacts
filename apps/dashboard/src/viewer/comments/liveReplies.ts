import type { CommentThread } from "@oa/shared";
import { useLayoutEffect, useRef, useState } from "react";

/** How long a live reply keeps its tint (#2179). */
export const LIVE_TINT_MS = 2500;

export type LiveReplies = {
  /**
   * Replies that stay unfolded until reload: each thread's latest on load and
   * every reply since, so nothing the reader saw folds away mid-visit.
   */
  kept: ReadonlySet<string>;
  /** The ones still tinted. */
  tint: ReadonlySet<string>;
};

const NONE: ReadonlySet<string> = new Set();

/**
 * Finds replies that show up in a thread the page already knew (#2179). The
 * first list seeds what is known; a thread that is new on a later list does
 * not count as live, only a new comment under a known thread, and the
 * reader's own replies are kept but never tinted.
 */
export function useLiveReplies(
  artifactId: string,
  all: readonly CommentThread[] | undefined,
): LiveReplies {
  const known = useRef<{
    artifact: string;
    threads: Map<string, Set<string>>;
  } | null>(null);
  const [live, setLive] = useState<LiveReplies>({ kept: NONE, tint: NONE });
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  // Layout effect: the state change re-renders before paint, so a live reply
  // never shows once folded and then jumps open.
  useLayoutEffect(() => {
    if (!all) return;
    if (!known.current || known.current.artifact !== artifactId) {
      known.current = { artifact: artifactId, threads: new Map() };
      setLive({ kept: NONE, tint: NONE });
    }
    const threads = known.current.threads;
    // Replies that stay unfolded until reload: the latest one a thread had
    // when the page first saw it, and every reply after that.
    const keep: string[] = [];
    const fresh: string[] = [];
    for (const t of all) {
      const prev = threads.get(t.id);
      if (prev) {
        for (const c of t.comments) {
          if (prev.has(c.id)) continue;
          keep.push(c.id);
          // The reader's own reply is no news to them; an agent's always is,
          // even one acting for the reader.
          if (!(c.author.me && c.author.kind !== "agent")) fresh.push(c.id);
        }
      } else {
        const latest = t.comments.length > 1 ? t.comments.at(-1) : undefined;
        if (latest) keep.push(latest.id);
      }
      threads.set(t.id, new Set(t.comments.map((c) => c.id)));
    }
    if (!keep.length) return;
    setLive((l) => ({
      kept: new Set([...l.kept, ...keep]),
      tint: fresh.length ? new Set([...l.tint, ...fresh]) : l.tint,
    }));
    if (!fresh.length) return;
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      setLive((l) => {
        const tint = new Set(l.tint);
        for (const id of fresh) tint.delete(id);
        return { kept: l.kept, tint };
      });
    }, LIVE_TINT_MS);
    timers.current.add(timer);
  }, [all, artifactId]);
  useLayoutEffect(() => {
    const set = timers.current;
    return () => {
      for (const t of set) clearTimeout(t);
      set.clear();
    };
  }, []);
  return live;
}
