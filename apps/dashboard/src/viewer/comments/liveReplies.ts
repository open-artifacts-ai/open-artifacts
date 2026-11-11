import type { CommentThread } from "@oa/shared";
import { useLayoutEffect, useRef, useState } from "react";

/** How long a live reply keeps its tint (#2179). */
export const LIVE_TINT_MS = 2500;

export type LiveReplies = {
  /** Replies that arrived while the page was open: they stay unfolded until reload. */
  kept: ReadonlySet<string>;
  /** The ones still tinted. */
  tint: ReadonlySet<string>;
};

const NONE: ReadonlySet<string> = new Set();

/**
 * Finds replies that show up in a thread the page already knew (#2179). The
 * first list seeds what is known; a thread that is new on a later list does
 * not count as live, only a new comment under a known thread.
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
    const fresh: string[] = [];
    for (const t of all) {
      const prev = threads.get(t.id);
      const ids = new Set(t.comments.map((c) => c.id));
      if (prev) for (const id of ids) if (!prev.has(id)) fresh.push(id);
      threads.set(t.id, ids);
    }
    if (!fresh.length) return;
    setLive((l) => ({
      kept: new Set([...l.kept, ...fresh]),
      tint: new Set([...l.tint, ...fresh]),
    }));
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
