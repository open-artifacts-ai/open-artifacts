import { useLayoutEffect, useRef } from "react";

const CHIPS = "button[data-mention-chip]";

/**
 * #2247: one tab stop for a comment's mention chips. The container's chips
 * take tabindex 0 (the one last focused, else the first) and -1 (the rest);
 * the arrow keys, Home and End move focus between them.
 */
export function useRoving<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const at = useRef(0);
  const chips = () => [
    ...(ref.current?.querySelectorAll<HTMLElement>(CHIPS) ?? []),
  ];
  // After every render: chips come and go with the text.
  useLayoutEffect(() => {
    const all = chips();
    const cur = Math.min(at.current, all.length - 1);
    all.forEach((el, i) => {
      el.tabIndex = i === cur ? 0 : -1;
    });
  });
  return {
    ref,
    onFocus: (e: React.FocusEvent) => {
      const i = chips().indexOf(e.target as HTMLElement);
      if (i < 0) return;
      at.current = i;
      chips().forEach((el, j) => {
        el.tabIndex = j === i ? 0 : -1;
      });
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      const all = chips();
      const i = all.indexOf(e.target as HTMLElement);
      if (i < 0 || all.length < 2) return;
      const to =
        e.key === "ArrowRight" || e.key === "ArrowDown"
          ? (i + 1) % all.length
          : e.key === "ArrowLeft" || e.key === "ArrowUp"
            ? (i - 1 + all.length) % all.length
            : e.key === "Home"
              ? 0
              : e.key === "End"
                ? all.length - 1
                : -1;
      if (to < 0) return;
      e.preventDefault();
      all[to]?.focus({ preventScroll: true });
    },
  };
}
