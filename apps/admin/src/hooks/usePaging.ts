import { useCallback, useState } from "react";

/**
 * A cursor stack: the current page's cursor, forward with a nextCursor, back
 * one. `key` names what the cursors page through (the list's filters): when it
 * changes the stack drops in the same render, so a cursor from one filter is
 * never sent with another.
 */
export function usePaging(key = "") {
  const [s, setS] = useState<{ key: string; stack: string[] }>({
    key,
    stack: [],
  });
  const stale = s.key !== key;
  // Adjusted during render, not in an effect: this render already reads page 1.
  if (stale) setS({ key, stack: [] });
  const stack = stale ? [] : s.stack;
  const next = useCallback(
    (c: string) => setS((p) => ({ key: p.key, stack: [...p.stack, c] })),
    [],
  );
  const prev = useCallback(
    () => setS((p) => ({ key: p.key, stack: p.stack.slice(0, -1) })),
    [],
  );
  const reset = useCallback(() => setS((p) => ({ key: p.key, stack: [] })), []);
  return { cursor: stack.at(-1), canPrev: stack.length > 0, next, prev, reset };
}
