import { useEffect } from "react";

/**
 * #2247: was the last input a touch tap? A hybrid device taps, then uses the
 * keyboard or the mouse: the next keydown or mouse movement ends "touch", so
 * hover and focus open the details again. Listened to once on the document,
 * in the capture phase, so it is current before any handler reads it (a Tab's
 * keydown lands on the element that is leaving, not the one that gains focus).
 */
let touch = false;
let users = 0;

const onDown = (e: PointerEvent) => {
  touch = e.pointerType === "touch";
};
const onMove = (e: PointerEvent) => {
  if (e.pointerType === "mouse") touch = false;
};
const onKey = () => {
  touch = false;
};

export const lastWasTouch = () => touch;

export function useInputKind() {
  useEffect(() => {
    if (users++ === 0) {
      document.addEventListener("pointerdown", onDown, true);
      document.addEventListener("pointermove", onMove, true);
      document.addEventListener("keydown", onKey, true);
    }
    return () => {
      if (--users === 0) {
        document.removeEventListener("pointerdown", onDown, true);
        document.removeEventListener("pointermove", onMove, true);
        document.removeEventListener("keydown", onKey, true);
        touch = false;
      }
    };
  }, []);
}
