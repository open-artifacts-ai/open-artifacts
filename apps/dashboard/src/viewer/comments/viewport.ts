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
  return Math.max(0, inset > 120 ? inset : 0);
}

/** True while a text field has focus: the only time a keyboard is up. */
function fieldFocused(): boolean {
  const a = document.activeElement as HTMLElement | null;
  if (!a) return false;
  return (
    a.tagName === "TEXTAREA" || a.tagName === "INPUT" || a.isContentEditable
  );
}

/**
 * How far to lift a fixed bottom sheet so it ends at the visible bottom. When
 * iOS pans the visual viewport (offsetTop > 0) that edge is offsetTop + height
 * in layout coordinates, so this is not keyboardInset().
 */
export function sheetLift(): number {
  const vv = window.visualViewport;
  if (!vv) return 0;
  const gap = window.innerHeight - vv.height * (vv.scale || 1);
  if (!fieldFocused()) {
    // Nothing editable has focus, so no keyboard: the gap is browser chrome
    // (iOS toolbars). Remember it. Just after a blur the keyboard may still
    // be leaving, so that gap is not taken as chrome.
    if (Date.now() - lastBlur > 800) baseline = Math.max(0, gap);
    return 0;
  }
  // A focused field is not a keyboard (iOS leaves a programmatically focused
  // field, such as a new draft's, focused with none up): only what the gap
  // exceeds the chrome by counts, and only a keyboard-sized amount.
  if (gap - baseline <= 120) return 0;
  return Math.max(
    0,
    window.innerHeight - (vv.offsetTop + vv.height) - baseline,
  );
}

/** The viewport gap while no field was focused: browser chrome, not a keyboard. */
let baseline = 0;
let lastBlur = 0;

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

/** Calls `fn` when the visual viewport resizes (not when it pans); returns the unsubscribe. */
export function onViewportResize(fn: () => void): () => void {
  const vv = window.visualViewport;
  if (!vv) return () => {};
  vv.addEventListener("resize", fn);
  return () => vv.removeEventListener("resize", fn);
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
 * Publishes the keyboard's height as `--oa-kb` and the visible height as `--oa-vvh` (one hundredth of it, so
 * `calc(var(--oa-vvh, 1svh) * 40)` is 40svh that follows the keyboard).
 * Reference counted: the first user installs it, the last removes it.
 */
export function trackViewportVar(): () => void {
  const root = document.documentElement;
  let poll: ReturnType<typeof setInterval> | null = null;
  const set = () => {
    root.style.setProperty("--oa-vvh", `${viewHeight() / 100}px`);
    // The phone sheet is fixed to the layout viewport: lift it above the keyboard.
    const lift = sheetLift();
    root.style.setProperty("--oa-kb", `${lift}px`);
    // iOS can close the keyboard (a draft left open, a blur, a pan that
    // never resets) without an event we hear: while lifted, look again, so a
    // stale lift heals itself and never leaves the sheet's top off-screen.
    if (lift > 0 && poll === null) poll = setInterval(set, 250);
    else if (lift === 0 && poll !== null) {
      clearInterval(poll);
      poll = null;
    }
  };
  if (users++ === 0) {
    // The sheet opens with no keyboard up, even if its field is focused
    // already: the gap now is the browser's chrome.
    const vv = window.visualViewport;
    if (vv)
      baseline = Math.max(0, window.innerHeight - vv.height * (vv.scale || 1));
    set();
    const off = onViewport(set);
    // The keyboard goes with the field's focus, and the layout viewport may
    // settle after the visual one: look again on both.
    document.addEventListener("focusin", set);
    const blurred = () => {
      lastBlur = Date.now();
      set();
    };
    document.addEventListener("focusout", blurred);
    window.addEventListener("resize", set);
    window.addEventListener("orientationchange", set);
    stop = () => {
      if (poll !== null) clearInterval(poll);
      poll = null;
      off();
      document.removeEventListener("focusin", set);
      document.removeEventListener("focusout", blurred);
      window.removeEventListener("resize", set);
      window.removeEventListener("orientationchange", set);
    };
  }
  return () => {
    if (--users > 0) return;
    stop?.();
    stop = null;
    root.style.removeProperty("--oa-vvh");
    root.style.removeProperty("--oa-kb");
  };
}
