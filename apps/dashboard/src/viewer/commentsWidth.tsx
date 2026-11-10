// #1986: one width for the comments margin column and the side panel,
// resizable from 960px up and remembered per browser.
import {
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from "react";

export const KEY = "oa.comments.width";
export const DEFAULT_WIDTH = 352;
export const MIN_WIDTH = 300;
const MAX_WIDTH = 560;
/** The artifact always keeps this much room. */
const KEEP = 600;
/** Below this window width the layout is the old fixed one. */
export const RESIZE_FROM = 960;
const STEP = 16;
const STEP_SHIFT = 64;

export const maxWidth = (win: number) =>
  Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, win - KEEP));
export const clampWidth = (w: number, win: number) =>
  Math.round(Math.min(maxWidth(win), Math.max(MIN_WIDTH, w)));

/** The stored width, or the default when it is missing, unreadable or not a positive number. */
export function loadWidth(): number {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null || raw.trim() === "") return DEFAULT_WIDTH;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_WIDTH;
  } catch {
    return DEFAULT_WIDTH;
  }
}

type Snap = { width: number; min: number; max: number; enabled: boolean };
let raw = DEFAULT_WIDTH;
let draft: number | null = null;
let win = 1280;
let snap: Snap = {
  width: DEFAULT_WIDTH,
  min: MIN_WIDTH,
  max: 560,
  enabled: true,
};
const subs = new Set<() => void>();

function recompute() {
  const width = clampWidth(draft ?? raw, win);
  const max = maxWidth(win);
  if (
    width !== snap.width ||
    max !== snap.max ||
    win >= RESIZE_FROM !== snap.enabled
  ) {
    snap = { width, min: MIN_WIDTH, max, enabled: win >= RESIZE_FROM };
    for (const f of subs) f();
  }
}

/** Reload from storage and the window (first use, and tests). */
export function resetWidthStore() {
  raw = loadWidth();
  draft = null;
  win = typeof window === "undefined" ? 1280 : window.innerWidth;
  snap = { ...snap, width: -1 };
  recompute();
}

if (typeof window !== "undefined") {
  resetWidthStore();
  window.addEventListener("resize", () => {
    win = window.innerWidth;
    recompute();
  });
}

function commit(w: number) {
  raw = clampWidth(w, win);
  draft = null;
  try {
    localStorage.setItem(KEY, String(raw));
  } catch {
    // Storage blocked: the width lasts for this page only.
  }
  snap = { ...snap, width: -1 };
  recompute();
}

const subscribe = (f: () => void) => {
  subs.add(f);
  return () => {
    subs.delete(f);
  };
};

/** The width to use now, whether resizing is on, and its limits. */
export function useCommentsWidth(): Snap {
  return useSyncExternalStore(
    subscribe,
    () => snap,
    () => snap,
  );
}

/**
 * Keep --oa-comments-w on `ref`'s element current without re-rendering the
 * caller: a drag moves the width on every pointermove.
 */
export function useCommentsWidthVar(ref: RefObject<HTMLElement | null>) {
  // Every render (the element may be a different one), plus every change.
  useLayoutEffect(() => {
    const apply = () =>
      ref.current?.style.setProperty("--oa-comments-w", `${snap.width}px`);
    apply();
    return subscribe(apply);
  });
}

/** The drag handle on the comments column's left edge. Renders nothing below 960px. */
export function CommentsResizer() {
  const s = useCommentsWidth();
  const start = useRef<{ x: number; w: number } | null>(null);
  const body = useRef<HTMLElement | null>(null);
  const { enabled } = s;
  // The handle going away mid-drag (window under 960px, column closed) must
  // not leave the frame inert or an unsaved width behind.
  useEffect(() => {
    if (!enabled) return;
    return () => {
      if (!start.current) return;
      start.current = null;
      if (body.current) delete body.current.dataset.resizing;
      body.current = null;
      draft = null;
      recompute();
    };
  }, [enabled]);
  if (!enabled) return null;
  const setDragging = (el: HTMLElement, on: boolean) => {
    if (on) {
      body.current = el.parentElement;
      if (body.current) body.current.dataset.resizing = "";
    } else {
      if (body.current) delete body.current.dataset.resizing;
      body.current = null;
    }
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? STEP_SHIFT : STEP;
    let v: number | null = null;
    // The handle is on the column's left edge: left widens, right narrows.
    if (e.key === "ArrowLeft") v = s.width + step;
    else if (e.key === "ArrowRight") v = s.width - step;
    else if (e.key === "Home") v = s.min;
    else if (e.key === "End") v = s.max;
    else if (e.key === "Enter") v = DEFAULT_WIDTH;
    if (v === null) return;
    e.preventDefault();
    commit(v);
  };
  const end = (e: PointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    start.current = null;
    setDragging(e.currentTarget, false);
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    // A click with no movement changes and stores nothing.
    if (draft !== null) commit(draft);
  };
  return (
    // A focusable, valued separator is a splitter widget; <hr> cannot carry that.
    // biome-ignore lint/a11y/useSemanticElements: window splitter pattern
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize comments"
      aria-valuenow={s.width}
      aria-valuemin={s.min}
      aria-valuemax={s.max}
      tabIndex={0}
      title="Drag to resize. Double-click to reset."
      className="oa-resizer"
      onKeyDown={onKey}
      onDoubleClick={() => commit(DEFAULT_WIDTH)}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        start.current = { x: e.clientX, w: s.width };
        e.currentTarget.setPointerCapture?.(e.pointerId);
        setDragging(e.currentTarget, true);
      }}
      onPointerMove={(e) => {
        if (!start.current) return;
        draft = clampWidth(
          start.current.w + (start.current.x - e.clientX),
          win,
        );
        recompute();
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
    />
  );
}
