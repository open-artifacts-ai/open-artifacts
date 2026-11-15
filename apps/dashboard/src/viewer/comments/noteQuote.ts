// "Comment on selection" in a doc (#1100): the selection goes to the
// whole-page composer as a Markdown quote, which takes it (in front of any
// text already typed) with the cursor after it. No live anchor yet (#2535).
import { useSyncExternalStore } from "react";

type Pending = { text: string };
const pending = new Map<string, Pending>();
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of [...listeners]) l();
};

/**
 * The quote for a selection: one quoted paragraph per line (blank lines
 * dropped), then a blank line where the cursor goes.
 */
export function quoteLines(selection: string): string {
  const lines = selection
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return "";
  return `${lines.map((l) => `> ${l}`).join("\n>\n")}\n\n`;
}

/** Hand a quote to `artifactId`'s whole-page composer (now, or when it mounts). */
export function quoteToNote(artifactId: string, quote: string) {
  if (!quote) return;
  pending.set(artifactId, { text: quote });
  emit();
}

/** The composer took it. */
export function takeNoteQuote(artifactId: string, p: Pending) {
  if (pending.get(artifactId) !== p) return;
  pending.delete(artifactId);
  emit();
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

/** The quote waiting for `artifactId`'s whole-page composer, if any. */
export function useNoteQuote(artifactId: string): Pending | null {
  return useSyncExternalStore(
    subscribe,
    () => pending.get(artifactId) ?? null,
    () => null,
  );
}
