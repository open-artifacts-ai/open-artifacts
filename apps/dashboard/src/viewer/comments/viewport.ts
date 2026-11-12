import { useEffect, useState } from "react";

/** #2239: the part of the screen the reader can use. On iOS the keyboard
 * shrinks the visual viewport only; innerHeight and svh ignore it. */

/** The visible height: the visual viewport where it exists. */
export function viewHeight(): number {
  const vv = window.visualViewport;
  // Pinch zoom shrinks vv.height by the scale; the keyboard does not.
  return vv?.height ? vv.height * (vv.scale || 1) : window.innerHeight;
}

/** The viewport's visible bottom edge, in layout-viewport coordinates. */
export function viewBottom(): number {
  const vv = window.visualViewport;
  return vv ? vv.offsetTop + vv.height : window.innerHeight;
}

/** Height the on-screen keyboard takes (0 when none, or when it is ordinary browser chrome). */
export function keyboardInset(): number {
  const vv = window.visualViewport;
  if (!vv) return 0;
  // No offsetTop: iOS pans the page with the keyboard open, and that must
  // not hide it. The scale undoes pinch zoom, which is not a keyboard.
  const inset = window.innerHeight - vv.height * (vv.scale || 1);
  // Browser toolbars move by tens of pixels; a keyboard by hundreds.
  return inset > 120 ? inset : 0;
}

/** The composer's cap in px: its own cap, or 40% of what is visible. */
export function fieldCap(own: number): number {
  return Math.min(own, viewHeight() * 0.4 || Number.POSITIVE_INFINITY);
}

/** Calls `fn` when the visual viewport resizes or scrolls; returns the unsubscribe. */
export function onViewport(fn: () => void): () => void {
  const vv = window.visualViewport;
  if (!vv) return () => {};
  vv.addEventListener("resize", fn);
  vv.addEventListener("scroll", fn);
  return () => {
    vv.removeEventListener("resize", fn);
    vv.removeEventListener("scroll", fn);
  };
}

/** True while the on-screen keyboard is open. */
export function useKeyboardOpen(): boolean {
  const [open, setOpen] = useState(() => keyboardInset() > 0);
  useEffect(() => {
    const sync = () => setOpen(keyboardInset() > 0);
    sync();
    return onViewport(sync);
  }, []);
  return open;
}

let users = 0;
let stop: (() => void) | null = null;

/**
 * Publishes the visible height as `--oa-vvh` (one hundredth of it, so
 * `calc(var(--oa-vvh, 1svh) * 40)` is 40svh that follows the keyboard).
 * Reference counted: the first user installs it, the last removes it.
 */
export function trackViewportVar(): () => void {
  const root = document.documentElement;
  const set = () =>
    root.style.setProperty("--oa-vvh", `${viewHeight() / 100}px`);
  if (users++ === 0) {
    set();
    stop = onViewport(set);
  }
  return () => {
    if (--users > 0) return;
    stop?.();
    stop = null;
    root.style.removeProperty("--oa-vvh");
  };
}
