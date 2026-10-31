import { useState } from "react";

/** A cursor stack: the current page's cursor, forward with a nextCursor, back one. */
export function usePaging() {
  const [stack, setStack] = useState<string[]>([]);
  return {
    cursor: stack.at(-1),
    canPrev: stack.length > 0,
    next: (c: string) => setStack((s) => [...s, c]),
    prev: () => setStack((s) => s.slice(0, -1)),
    reset: () => setStack([]),
  };
}
