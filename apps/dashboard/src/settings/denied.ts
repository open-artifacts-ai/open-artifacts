// Inline "only the owner can…" notes per member row. Kept outside the row: an
// optimistic Remove unmounts the row before the server's 403 puts it back.
import { useSyncExternalStore } from "react";

let notes: Readonly<Record<string, string>> = {};
const listeners = new Set<() => void>();
const set = (next: Record<string, string>) => {
  notes = next;
  for (const l of listeners) l();
};

/** Show `text` on member `id`'s row. */
export const denyMember = (id: string, text: string) =>
  set({ ...notes, [id]: text });
/** A new attempt on that row: the note goes. */
export const clearDenied = (id: string) => {
  if (!(id in notes)) return;
  const { [id]: _gone, ...rest } = notes;
  set(rest);
};

export function useDenied(id: string): string | undefined {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => notes[id],
  );
}
