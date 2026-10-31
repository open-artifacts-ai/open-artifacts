import { useCallback, useState } from "react";

/** A cursor stack: the current page's cursor, forward with a nextCursor, back one. */
export function usePaging() {
  const [stack, setStack] = useState<string[]>([]);
  const next = useCallback((c: string) => setStack((s) => [...s, c]), []);
  const prev = useCallback(() => setStack((s) => s.slice(0, -1)), []);
  const reset = useCallback(() => setStack([]), []);
  return { cursor: stack.at(-1), canPrev: stack.length > 0, next, prev, reset };
}
