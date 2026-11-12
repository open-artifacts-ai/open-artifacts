import { useSyncExternalStore } from "react";
import type { Draft, Lost } from "./useComments";

/**
 * Posts that failed after their box had closed (the card scrolled away, the
 * panel closed, another draft opened). They live here, outside any component,
 * so the text and the error survive until a box can take them: the thread's
 * reply box takes its entry when it next mounts, and a new comment that cannot
 * reopen (another draft is open) waits behind a "Restore" line.
 */
export type LostPost = Lost & {
  /** A new thread's draft, to reopen it. */
  draft?: NonNullable<Draft>;
};

const posts = new Map<string, LostPost>();
const listeners = new Set<() => void>();
const changed = () => {
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

export const lostKey = {
  reply: (artifact: string, thread: string) => `${artifact}|reply|${thread}`,
  ask: (artifact: string, thread: string) => `${artifact}|ask|${thread}`,
  note: (artifact: string) => `${artifact}|note`,
  draft: (artifact: string, d: NonNullable<Draft>) =>
    `${artifact}|draft|${JSON.stringify(d)}`,
};

export function putLost(key: string, l: LostPost) {
  const mine: LostPost = {
    ...l,
    // Used up once a box has taken it (or the reader posts again).
    clear: () => {
      if (posts.get(key) === mine) dropLost(key);
    },
  };
  posts.set(key, mine);
  changed();
}
export function dropLost(key: string) {
  if (posts.delete(key)) changed();
}

export const useLostPost = (key: string) =>
  useSyncExternalStore(
    subscribe,
    () => posts.get(key),
    () => undefined,
  );

let listCache: { artifact: string; out: [string, LostPost][] } | null = null;
/** The new-comment drafts that failed and are waiting for the reader, for one artifact. */
export const useLostDrafts = (artifact: string) =>
  useSyncExternalStore(
    subscribe,
    () => {
      const prefix = `${artifact}|draft|`;
      const out = [...posts].filter(([k]) => k.startsWith(prefix));
      // A stable snapshot while nothing changed.
      const same =
        listCache?.artifact === artifact &&
        listCache.out.length === out.length &&
        listCache.out.every(
          ([k, p], i) => out[i]?.[0] === k && out[i]?.[1] === p,
        );
      if (same && listCache) return listCache.out;
      listCache = { artifact, out };
      return out;
    },
    () => [] as [string, LostPost][],
  );
