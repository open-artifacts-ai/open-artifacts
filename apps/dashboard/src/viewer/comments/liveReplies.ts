import type { CommentThread } from "@oa/shared";
import { useLayoutEffect, useRef, useState } from "react";

/** How long a live reply keeps its tint (#2179); the CSS reads it as --oa-live-tint-ms. */
export const LIVE_TINT_MS = 2500;

export type LiveReplies = {
  /**
   * Replies that stay unfolded until reload: each thread's latest on load and
   * every reply since, so nothing the reader saw folds away mid-visit.
   */
  kept: ReadonlySet<string>;
  /** Replies that arrived while the page was open and are still tinted. */
  tint: ReadonlySet<string>;
  /** Every reply that arrived while the page was open, in arrival order. */
  arrived: readonly string[];
  /** For the polite live region: "New reply from <name>" or "<n> new replies". */
  announce: { text: string; n: number };
};

const NONE: ReadonlySet<string> = new Set();
const EMPTY: LiveReplies = {
  kept: NONE,
  tint: NONE,
  arrived: [],
  announce: { text: "", n: 0 },
};

/**
 * Finds replies that show up in a thread the page already knew (#2179).
 *
 * Seeding: every list seen before the mount's own fetch settles (a cached list
 * from an earlier visit, then the refetch that replaces it) only seeds what is
 * known, so coming back to an artifact never tints replies that came in while
 * away. After that, a new comment under a known thread is live; a thread that
 * is new is not, and the reader's own replies are kept but never tinted.
 */
export function useLiveReplies(
  artifactId: string,
  all: readonly CommentThread[] | undefined,
  /** False while the list is being fetched. */
  settled: boolean,
): LiveReplies {
  const known = useRef<{
    artifact: string;
    ready: boolean;
    threads: Map<string, Set<string>>;
  } | null>(null);
  const [live, setLive] = useState<LiveReplies>(EMPTY);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  // Layout effect: the state change re-renders before paint, so a live reply
  // never shows once folded and then jumps open.
  useLayoutEffect(() => {
    if (!known.current || known.current.artifact !== artifactId) {
      known.current = {
        artifact: artifactId,
        ready: false,
        threads: new Map(),
      };
      setLive(EMPTY);
    }
    if (!all) return;
    const k = known.current;
    if (!k.ready) {
      // Seed: the latest reply of each thread stays in view from here on.
      k.threads = new Map();
      const keep: string[] = [];
      for (const t of all) {
        k.threads.set(t.id, new Set(t.comments.map((c) => c.id)));
        const latest = t.comments.length > 1 ? t.comments.at(-1) : undefined;
        if (latest) keep.push(latest.id);
      }
      k.ready = settled;
      setLive({ ...EMPTY, kept: new Set(keep) });
      return;
    }
    const keep: string[] = [];
    const fresh: string[] = [];
    const names: string[] = [];
    for (const t of all) {
      const prev = k.threads.get(t.id);
      if (prev) {
        for (const c of t.comments) {
          if (prev.has(c.id)) continue;
          keep.push(c.id);
          // The reader's own reply is no news to them; an agent's always is,
          // even one acting for the reader.
          if (!(c.author.me && c.author.kind !== "agent")) {
            fresh.push(c.id);
            names.push(c.author.name);
          }
        }
      } else {
        const latest = t.comments.length > 1 ? t.comments.at(-1) : undefined;
        if (latest) keep.push(latest.id);
      }
      k.threads.set(t.id, new Set(t.comments.map((c) => c.id)));
    }
    if (!keep.length) return;
    setLive((l) => ({
      kept: new Set([...l.kept, ...keep]),
      tint: fresh.length ? new Set([...l.tint, ...fresh]) : l.tint,
      arrived: fresh.length ? [...l.arrived, ...fresh] : l.arrived,
      // One message per refetch, however many replies it brought.
      announce: !fresh.length
        ? l.announce
        : {
            text:
              fresh.length === 1
                ? `New reply from ${names[0]}`
                : `${fresh.length} new replies`,
            n: l.announce.n + 1,
          },
    }));
    if (!fresh.length) return;
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      setLive((l) => {
        const tint = new Set(l.tint);
        for (const id of fresh) tint.delete(id);
        return { ...l, tint };
      });
    }, LIVE_TINT_MS);
    timers.current.add(timer);
  }, [all, artifactId, settled]);
  useLayoutEffect(() => {
    const set = timers.current;
    return () => {
      for (const t of set) clearTimeout(t);
      set.clear();
    };
  }, []);
  return live;
}
