import type { SelectionAnchor } from "@oa/shared";
import {
  type Anchor,
  type BlockHint,
  createTextAnchor,
  createTextResolver,
  type PinBadge,
  type Resolution,
  type ShellToArtifact,
  type TextAnchor,
} from "@oa/shared";
import type { Bridge } from "./bridge.js";
import {
  indexText,
  nodeAtIndex,
  rangeFromIndex,
  rangeToOffsets,
  type TextIndex,
} from "./text-range.js";

// The frame half of comments (#682). Loaded with the schemas chunk, not the
// entry. Hard rule: comment text and author names never enter the frame, with
// one exception (#2019): image and pdf pins carry a badge (initials or an
// agent's face) and the author's name as the bubble's accessible label (those
// frames hold no author script). The shell sends anchors, opaque ids, pin
// numbers and flags; the frame sends
// anchors it built from the page's own text, ids, states and pixel offsets.
// Nothing here adds a node to the page tree except one overlay host under
// <html> (its UI sits in a shadow root), and highlights use the CSS Custom
// Highlight API with an adopted stylesheet (an inline <style> would be blocked
// by a page's `style-src 'self'`). This is tidiness, not a security
// boundary: the page's own script shares this window, so it can see every
// message, reach the overlay and forge every message the frame sends. The
// shell must treat them all as hints.
//
// Cost model: resolving anchors is the expensive step, so it runs once per
// (text version, thread set) and its ranges are cached. Scroll and resize only
// re-measure the cached ranges; a DOM mutation bumps the text version.

type Thread = Extract<
  ShellToArtifact,
  { type: "comments.set" }
>["threads"][number];
type Registry = {
  set(name: string, h: unknown): void;
  delete(name: string): void;
};
type Slot = {
  thread: Thread;
  state: Pos["state"];
  /** The highlight range (exact/partial), or the char beside a collapsed spot. */
  range: Range | null;
};
type Mode = "off" | "view" | "select" | "pin";
type Pos = {
  id: string;
  state: "exact" | "partial" | "collapsed" | "orphan" | "pin";
  top: number | null;
};

const BLOCK =
  "p,li,h1,h2,h3,h4,h5,h6,pre,blockquote,td,th,dt,dd,figcaption,div,section,article,.line";
/** Re-resolve after a DOM change: trailing debounce, but never later than the max wait. */
const MUTATION_MS = 150;
const MUTATION_MAX_WAIT_MS = 1000;
const FLASH_MS = 1200;

const OVERLAY_CSS = `
:host{all:initial}
.btn{position:absolute;display:flex;align-items:center;gap:6px;font:500 13px/1 system-ui,sans-serif;padding:8px 12px;border:0;border-radius:999px;background:#17181a;color:#fff;cursor:pointer;pointer-events:auto;box-shadow:0 2px 8px rgba(0,0,0,.25)}
.btn::after{content:"";position:absolute;left:var(--ax,50%);top:100%;margin-left:-5px;border:5px solid transparent;border-top-color:#17181a;border-bottom:0}
.btn.below::after{top:auto;bottom:100%;border-top:0;border-bottom:5px solid #17181a}
.dark .btn{background:#eceef1;color:#17181a;box-shadow:0 2px 8px rgba(0,0,0,.5)}.dark .btn::after{border-top-color:#eceef1}.dark .btn.below::after{border-bottom-color:#eceef1}
.btn svg{width:14px;height:14px;flex:none}
.mark{position:absolute;width:6px;height:16px;border-radius:2px;background:#e0a000;pointer-events:auto;cursor:pointer}
.mark.on{background:#1f5fbf}
/* A pin is a 30px speech bubble whose bottom-left corner is the anchor: left/top
   are the stored point and the margin lifts the bubble above it, so the tail
   is exactly on x,y. It holds the pin's number (the frame never carries names).
   Ring: 2px white. Open (.on): plus a 2.5px amber ring. */
.pin{position:absolute;width:30px;height:30px;margin:-30px 0 0 0;border-radius:15px 15px 15px 3px;background:#1f5fbf;color:#fff;font:600 12.5px/30px system-ui,sans-serif;text-align:center;pointer-events:auto;cursor:pointer;box-shadow:0 0 0 2px #fff,0 3px 8px rgba(0,0,0,.3)}
/* Edges: flip, never clip. The sharp corner stays on x,y. Near the top the
   bubble hangs below the point; near the right edge it sits left of it. */
.pin.flip-y{margin:0;border-radius:3px 15px 15px 15px}
.pin.flip-x{margin:-30px 0 0 -30px;border-radius:15px 15px 3px 15px}
.pin.flip-x.flip-y{margin:0 0 0 -30px;border-radius:15px 3px 15px 15px}
.pin.initials{font-size:12px;letter-spacing:-.02em}
.pin.face{display:flex;align-items:center;justify-content:center;border-radius:9px 9px 9px 3px;background:var(--face,#1f5fbf)}
.pin.face.flip-y{border-radius:3px 9px 9px 9px}
.pin.face.flip-x{border-radius:9px 9px 3px 9px}
.pin.face.flip-x.flip-y{border-radius:9px 3px 9px 9px}
.pin.face.dashed{background:#fff;color:#5f6670;box-shadow:0 0 0 2px #fff,0 3px 8px rgba(0,0,0,.3);outline:1.5px dashed #5f6670;outline-offset:-4px}
.pin.face.dashed svg{stroke:#5f6670}
.pin svg{width:18px;height:18px;fill:none;stroke:#fff;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.pin:focus-visible{outline:2px solid #fff;outline-offset:2px;box-shadow:0 0 0 4px #1f5fbf}
/* A resolved thread opened from the list: its bubble shows faded, so the spot can be found. */
.pin.resolved{opacity:.55;filter:grayscale(.6)}
.pin.on{z-index:1;box-shadow:0 0 0 2px #fff,0 0 0 4.5px #e0a000,0 3px 8px rgba(0,0,0,.3)}
/* Placing: a translucent accent bubble with a dashed edge. */
.pin.ghost{background:#1f5fbf55;border:2px dashed #1f5fbf;box-sizing:border-box;box-shadow:none;pointer-events:none;color:#1f5fbf;line-height:26px}
button.pin{border:0;padding:0}
.pin.ghost.initials{background:#1f5fbf;color:#fff;border:0;line-height:30px;box-shadow:0 0 0 2px #fff,0 0 0 4px #1f5fbf,0 3px 8px rgba(0,0,0,.3)}
/* A pin whose page changed: a dashed outline outside the ring, not a colour alone, plus a title. */
.pin.changed{outline:2px dashed #8a5a00;outline-offset:4px}
/* Open and changed: the dashed outline sits past the 4.5px amber ring, so both read. */
.pin.changed.on{outline-offset:6.5px}
`;
const PAGE_CSS =
  "::highlight(oa-comment){background:rgba(255,200,0,.35)}::highlight(oa-comment-active){background:rgba(255,160,0,.6)}";

/** The runtime's current theme and a way to hear it change. */
export interface ThemeSource {
  get(): "light" | "dark";
  on(cb: (t: "light" | "dark") => void): () => void;
}

export interface Comments {
  /** Recompute positions now and report them if they changed. */
  flush(): void;
  dispose(): void;
}

const BUBBLE =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 3.5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7l-3 3v-3h-.5a1 1 0 0 1-1-1z"/></svg>';
/** Gap between the selection and the button, and the viewport margin. */
const BTN_GAP = 6;
const BTN_MARGIN = 4;
/** The bubble's pointer. */
const POINTER = 5;
/** #1732: the shell's touch bar (48px) plus a 12px gap; the selection's last line stays above it. */
const BAR_CLEAR = 48 + 12;
const SELECTION_MS = 100;
/** How long a collapsed selection stays usable for the shell's command. */
const KEPT_MS = 1500;

const SVG_NS = "http://www.w3.org/2000/svg";
const ICON_TAGS = new Set([
  "path",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "rect",
  "g",
]);
const ICON_ATTRS = new Set([
  "d",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "points",
  "width",
  "height",
  "transform",
]);
/**
 * Build the badge into a pin: initials as text, or an icon rebuilt from the
 * shell's markup. Only the allowlisted shapes and attributes are copied, so
 * nothing in the markup can run or load anything.
 */
function fillBadge(el: HTMLElement, badge: PinBadge): void {
  if ("initials" in badge) {
    el.classList.add("initials");
    el.textContent = badge.initials;
    return;
  }
  const doc = new DOMParser().parseFromString(
    `<svg xmlns="${SVG_NS}">${badge.icon}</svg>`,
    "image/svg+xml",
  );
  const root = doc.documentElement;
  if (root.localName !== "svg" || doc.querySelector("parsererror")) return;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const copy = (from: Element, to: Element, depth: number) => {
    if (depth > 4) return;
    for (const c of Array.from(from.children)) {
      if (!ICON_TAGS.has(c.localName)) continue;
      const n = document.createElementNS(SVG_NS, c.localName);
      for (const a of Array.from(c.attributes))
        if (ICON_ATTRS.has(a.name)) n.setAttribute(a.name, a.value);
      to.append(n);
      copy(c, n, depth + 1);
    }
  };
  copy(root, svg, 0);
  el.classList.add("face");
  if (badge.dashed) el.classList.add("dashed");
  el.style.setProperty("--face", badge.color);
  el.append(svg);
}

/** #2408: the first shell protocol that announces itself (shared PROTOCOL_SHELL_ANNOUNCES; not imported to keep this chunk small). */
export const SHELL_ANNOUNCES = 6;

export function createComments(
  bridge: Pick<Bridge, "on" | "send"> & Partial<Pick<Bridge, "shellProtocol">>,
  signal?: AbortSignal,
  /** The viewer's theme (the shell's, not the OS's): the bubble follows it. */
  theme?: ThemeSource,
): Comments {
  const format =
    document.querySelector('meta[name="oa-format"]')?.getAttribute("content") ??
    "html";
  const hasPins = format === "image" || format === "pdf";
  let mode: Mode = "off";
  /** Disposed: nothing may paint or send again (#1473 review). */
  let ended = false;
  /**
   * The quote a comment is being written about (#1834), kept painted. No
   * version: it is a paint hint, not a record (the resolver ignores it).
   */
  let draftText: SelectionAnchor | undefined;
  let draftCache: {
    text: SelectionAnchor;
    ver: number;
    range: Range | null;
  } | null = null;
  let threads: Thread[] = [];
  let ghost:
    | { x: number; y: number; page?: number; badge?: PinBadge }
    | undefined;
  /** Text index of the body, rebuilt when the text version or the body changes. */
  let index: TextIndex | null = null;
  let indexVer = -1;
  let indexBody: HTMLElement | null = null;
  /** Bumped by every DOM mutation outside the overlay. */
  let textVer = 0;
  /** Resolved threads for the current text and thread set; null = stale. */
  let slots: Slot[] | null = null;
  let lastReport = "";
  let painted: { id: string; range: Range }[] = [];
  let flashId: string | undefined;
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  const lastPositions = new Map<string, Pos>();
  /** Touch: the shell draws the Comment bar, so the floating button stays off. */
  const coarse = () =>
    typeof matchMedia === "function" &&
    matchMedia("(pointer: coarse)").matches === true;
  /** The last non-empty selection (#1732): iOS can collapse it before the shell's command arrives. */
  let kept: { start: number; end: number; ver: number } | null = null;
  let selTimer: ReturnType<typeof setTimeout> | undefined;
  let keptTimer: ReturnType<typeof setTimeout> | undefined;
  let selSent: { has: boolean; bottom: number } = { has: false, bottom: 0 };

  // ---- overlay: one host under <html>, closed shadow root ----
  let host: HTMLElement | undefined;
  let layer: HTMLElement | undefined;
  let btn: HTMLButtonElement | undefined;
  const overlay = () => {
    if (host && layer) return layer;
    host = document.createElement("div");
    host.style.cssText =
      "position:absolute;top:0;left:0;width:0;height:0;overflow:visible;z-index:2147483647;pointer-events:none";
    const root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = OVERLAY_CSS;
    layer = document.createElement("div");
    layer.classList.toggle("dark", theme?.get() === "dark");
    root.append(style, layer);
    document.documentElement.append(host);
    return layer;
  };

  /**
   * The page's highlight rules: an adopted sheet, never an inline `<style>`.
   * An artifact page can ship a CSP that blocks inline styles
   * (`style-src 'self'`), and constructable sheets are not subject to it
   * (#1473 review). A page that rewrites `document.adoptedStyleSheets` takes
   * ours with it, so it is adopted again by anything that can notice: a paint,
   * a page mutation, a click or a selection change.
   */
  let sheet: CSSStyleSheet | undefined;
  const adoptSheet = () => {
    if (typeof CSSStyleSheet === "undefined") return;
    if (!sheet) {
      try {
        sheet = new CSSStyleSheet();
        sheet.replaceSync(PAGE_CSS);
      } catch {
        return;
      }
    }
    // Never rebuilt after a failed adoption: the sheet is created once.
    if (document.adoptedStyleSheets.includes(sheet)) return;
    try {
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    } catch {
      // No setter (older engines, jsdom): nothing to adopt into.
    }
  };

  const highlights = (): Registry | undefined => {
    if (typeof CSS === "undefined" || !("highlights" in CSS)) return undefined;
    adoptSheet();
    return (CSS as unknown as { highlights: Registry }).highlights;
  };

  const getIndex = (): TextIndex => {
    const body = document.body;
    if (!index || indexVer !== textVer || indexBody !== body) {
      index = body ? indexText(body) : { text: "", nodes: [], starts: [] };
      indexVer = textVer;
      indexBody = body;
    }
    return index;
  };

  /** Pin bubbles are this tall and wide; one near an edge flips so it is never clipped. */
  const BUBBLE_PX = 30;
  /** The classes that keep the bubble's sharp corner on x,y near the top or right edge. */
  const flips = (x: number, y: number): string =>
    [
      y < BUBBLE_PX ? "flip-y" : "",
      x > (document.documentElement.clientWidth || innerWidth) - BUBBLE_PX
        ? "flip-x"
        : "",
    ]
      .filter(Boolean)
      .join(" ");
  const clampTop = (n: number) => Math.min(10_000_000, Math.max(0, n));
  const docTop = (r: DOMRect) => clampTop(r.top + scrollY);

  function pinBox(a: Extract<Anchor, { kind: "pin" }>): DOMRect | null {
    const el =
      format === "image"
        ? document.querySelector(".oa-image img")
        : a.page
          ? document.querySelector(`.page[data-page-number="${a.page}"]`)
          : null;
    return el ? el.getBoundingClientRect() : null;
  }

  const rectOf = (r: Range | null): DOMRect | null => {
    if (!r) return null;
    const rect = r.getClientRects()[0] ?? r.getBoundingClientRect();
    return rect && (rect.width > 0 || rect.height > 0) ? rect : null;
  };

  /** Resolve every thread once per text version and thread set. */
  function ensureSlots(): Slot[] {
    if (slots) return slots;
    const idx = getIndex();
    const resolve = createTextResolver(idx.text);
    slots = threads.map((thread): Slot => {
      if (thread.anchor.kind !== "text") {
        return { thread, state: "pin", range: null };
      }
      const res: Resolution = resolve(thread.anchor as TextAnchor);
      if (res.state === "orphan")
        return { thread, state: "orphan", range: null };
      if (res.state === "collapsed") {
        const range =
          rangeFromIndex(idx, res.at, res.at + 1) ??
          (res.at > 0 ? rangeFromIndex(idx, res.at - 1, res.at) : null);
        return { thread, state: "collapsed", range };
      }
      return {
        thread,
        state: res.state,
        range: rangeFromIndex(idx, res.start, res.end),
      };
    });
    return slots;
  }

  /** The draft quote's range, resolved once per text version. */
  function draftRange(): Range | null {
    if (!draftText) return null;
    if (draftCache?.text === draftText && draftCache.ver === textVer)
      return draftCache.range;
    const idx = getIndex();
    const res = createTextResolver(idx.text)(draftText as TextAnchor);
    const range =
      res.state === "exact" || res.state === "partial"
        ? rangeFromIndex(idx, res.start, res.end)
        : null;
    draftCache = { text: draftText, ver: textVer, range };
    return range;
  }

  const clearPaint = () => {
    painted = [];
    const reg = highlights();
    reg?.delete("oa-comment");
    reg?.delete("oa-comment-active");
    layer?.replaceChildren(...(btn?.isConnected ? [btn] : []));
  };

  /** Highlights for the cached ranges (no resolving, no measuring). */
  function paint() {
    const normal: Range[] = [];
    const active: Range[] = [];
    painted = [];
    for (const s of ensureSlots()) {
      if (
        !s.range ||
        s.thread.resolved ||
        (s.state !== "exact" && s.state !== "partial")
      )
        continue;
      const isActive = !!s.thread.active || s.thread.id === flashId;
      (isActive ? active : normal).push(s.range);
      painted.push({ id: s.thread.id, range: s.range });
    }
    const reg = highlights();
    if (reg && typeof Highlight !== "undefined") {
      // #1834: the quote being written about takes the active thread's colour,
      // so choosing Comment highlights it and posting changes nothing.
      const draft = draftRange();
      reg.set("oa-comment", new Highlight(...normal));
      reg.set(
        "oa-comment-active",
        new Highlight(...active, ...(draft ? [draft] : [])),
      );
    }
  }

  /** Measure the cached ranges: positions for the shell, marks and pins for the overlay. */
  function compute(): Pos[] {
    if (mode === "off") {
      clearPaint();
      return [];
    }
    const list = ensureSlots();
    paint();
    const out: Pos[] = [];
    const marks: HTMLElement[] = [];
    const mark = (
      cls: string,
      x: number,
      y: number,
      label?: string,
      badge?: PinBadge,
      id?: string,
    ) => {
      // A real pin with a badge is a button: keyboard reachable, named.
      const live = badge !== undefined && !cls.includes("ghost");
      const d = document.createElement(live ? "button" : "div");
      if (d instanceof HTMLButtonElement) {
        d.type = "button";
        if (badge?.label) d.setAttribute("aria-label", badge.label);
      }
      d.className = cls;
      if (id) d.dataset.id = id;
      d.style.left = `${x}px`;
      d.style.top = `${y}px`;
      if (badge) fillBadge(d, badge);
      else if (label) d.textContent = label;
      marks.push(d);
      return d;
    };
    for (const s of list) {
      const th = s.thread;
      const isActive = !!th.active || th.id === flashId;
      if (th.anchor.kind === "pin") {
        const box = pinBox(th.anchor);
        if (!box) {
          out.push({ id: th.id, state: "pin", top: null });
          continue;
        }
        const x = box.left + scrollX + th.anchor.x * box.width;
        const y = box.top + scrollY + th.anchor.y * box.height;
        out.push({ id: th.id, state: "pin", top: clampTop(y) });
        // A resolved thread is drawn (faded) only while it is the open one.
        if (!th.resolved || isActive) {
          const cls = [
            "pin",
            isActive ? "on" : "",
            th.resolved ? "resolved" : "",
            th.changed ? "changed" : "",
            flips(x, clampTop(y)),
          ]
            .filter(Boolean)
            .join(" ");
          const d = mark(
            cls,
            x,
            clampTop(y),
            String(th.n ?? ""),
            th.badge,
            th.id,
          );
          if (th.changed) d.title = "Changed since this was placed.";
          d.addEventListener("click", () => open(th.id));
        }
        continue;
      }
      if (s.state === "orphan") {
        out.push({ id: th.id, state: "orphan", top: null });
        continue;
      }
      const rect = rectOf(s.range);
      out.push({
        id: th.id,
        state: s.state,
        top: rect ? docTop(rect) : null,
      });
      if (s.state === "collapsed" && rect && !th.resolved) {
        const d = mark(
          isActive ? "mark on" : "mark",
          rect.left + scrollX - 3,
          docTop(rect),
        );
        d.addEventListener("click", () => open(th.id));
      }
    }
    if (ghost) {
      const box = pinBox({ kind: "pin", page: ghost.page } as Extract<
        Anchor,
        { kind: "pin" }
      >);
      if (box) {
        const gx = box.left + scrollX + ghost.x * box.width;
        const gy = clampTop(box.top + scrollY + ghost.y * box.height);
        mark(
          ["pin ghost", flips(gx, gy)].filter(Boolean).join(" "),
          gx,
          gy,
          undefined,
          ghost.badge,
        );
      }
    }
    if (marks.length || layer) {
      // A re-measure rebuilds the pins; keyboard focus stays on the same one.
      const lay = overlay();
      const focused = (lay.getRootNode() as ShadowRoot).activeElement;
      const keep =
        focused instanceof HTMLElement && lay.contains(focused)
          ? focused.dataset.id
          : undefined;
      lay.replaceChildren(...marks, ...(btn?.isConnected ? [btn] : []));
      if (keep)
        marks
          .find((m) => m.dataset.id === keep)
          ?.focus({ preventScroll: true });
    }
    return out;
  }

  function report(force: boolean) {
    if (mode === "off" || !document.body) return;
    const positions = compute();
    lastPositions.clear();
    for (const p of positions) lastPositions.set(p.id, p);
    const key = JSON.stringify(positions);
    if (!force && key === lastReport) return;
    lastReport = key;
    bridge.send({ oa: 1, type: "comment.positions", positions });
  }

  // One animation frame batches what the page events asked for: scroll
  // re-measures, a selection change re-checks the button, resize does both.
  let raf = 0;
  let wantReport = false;
  let wantButton = false;
  const schedule = (measure: boolean, button: boolean) => {
    wantReport ||= measure;
    wantButton ||= button;
    if (raf || mode === "off") return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const m = wantReport;
      const b = wantButton;
      wantReport = wantButton = false;
      if (m) report(false);
      if (b) showButton();
    });
  };
  const onSelectionChange = () => {
    adoptSheet();
    schedule(false, true);
    if (mode !== "select") return;
    clearTimeout(selTimer);
    selTimer = setTimeout(reportSelection, SELECTION_MS);
  };
  // Also when the document grew or shrank (an image loaded, content arrived
  // above): re-measure the pins and re-place the button. showButton only
  // shows one for a live selection in select mode, as before.
  const onResize = () => schedule(true, true);
  const onScroll = () => schedule(true, false);

  function open(id: string) {
    bridge.send({ oa: 1, type: "comment.open", id });
  }

  // ---- selection button ----
  const blockOf = (n: Node | null): Element | null =>
    (n?.nodeType === 3 ? n.parentElement : (n as Element | null))?.closest(
      BLOCK,
    ) ?? null;

  function selection(): { start: number; end: number; range: Range } | null {
    const sel = getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    const idx = getIndex();
    const o = document.body && rangeToOffsets(document.body, range, idx);
    if (!o) return null;
    const t = idx.text;
    let { start, end } = o;
    while (start < end && /\s/.test(t[start])) start++;
    while (end > start && /\s/.test(t[end - 1])) end--;
    if (end <= start) return null;
    // A selection may span blocks: the flat text separates them with a space,
    // as the server's does, so the quote verifies and resolves the same way.
    if (!nodeAtIndex(idx, start) || !nodeAtIndex(idx, end - 1)) return null;
    return { start, end, range };
  }

  /** Tell the shell whether text is selected, and keep its last line clear of the bar. */
  function reportSelection() {
    const s = mode === "select" ? selection() : null;
    let bottom = 0;
    if (s) {
      kept = { start: s.start, end: s.end, ver: textVer };
      const rects = s.range.getClientRects();
      const r = rects[rects.length - 1] ?? s.range.getBoundingClientRect();
      bottom = Math.min(10_000_000, Math.max(-10_000_000, r.bottom));
      // Only when the bar first appears: never while the reader drags a handle.
      const vh = globalThis.visualViewport?.height ?? innerHeight;
      const over = bottom - (vh - BAR_CLEAR);
      if (coarse() && over > 0 && !selSent.has) scrollBy(0, over);
      clearTimeout(keptTimer);
    } else if (kept) {
      // A collapse is forgotten after the tap window, so a stale quote never
      // comes back on a later command.
      clearTimeout(keptTimer);
      keptTimer = setTimeout(() => {
        kept = null;
      }, KEPT_MS);
    }
    const has = !!s;
    if (selSent.has === has && selSent.bottom === bottom) return;
    selSent = { has, bottom };
    bridge.send({ oa: 1, type: "comment.selection", has, bottom });
  }

  function hideButton() {
    btn?.remove();
  }

  /** The first line's selected part (the pill centers over it), and the last line's bottom. */
  function selRect(): {
    left: number;
    right: number;
    top: number;
    bottom: number;
  } | null {
    const s = selection();
    if (!s) return null;
    const list = Array.from(s.range.getClientRects());
    const rects = list.length ? list : [s.range.getBoundingClientRect()];
    const first = rects[0];
    const last = rects[rects.length - 1];
    if (!first || !last) return null;
    return {
      left: first.left,
      right: first.right,
      top: first.top,
      bottom: last.bottom,
    };
  }

  /** Centered above the first line of the selection (below it when there is no room), kept inside the viewport. */
  function place(rect: {
    left: number;
    right: number;
    top: number;
    bottom: number;
  }) {
    if (!btn || !selection()) return;
    const vw = document.documentElement.clientWidth || innerWidth;
    const w = btn.offsetWidth;
    const h = btn.offsetHeight;
    const mid = (rect.left + rect.right) / 2;
    const x = Math.max(BTN_MARGIN, Math.min(mid - w / 2, vw - w - BTN_MARGIN));
    const above = rect.top - h - BTN_GAP - POINTER >= BTN_MARGIN;
    btn.classList.toggle("below", !above);
    btn.style.setProperty(
      "--ax",
      `${Math.max(12, Math.min(mid - x, w - 12))}px`,
    );
    btn.style.left = `${x + scrollX}px`;
    btn.style.top = `${
      above
        ? rect.top + scrollY - h - BTN_GAP - POINTER
        : rect.bottom + scrollY + BTN_GAP + POINTER
    }px`;
  }

  /**
   * A webfont that swaps in after the button shows reflows the page, which
   * moves the selection's rect; the button would sit off center until the next
   * selection (#1648). Its own width cannot change (the overlay is a closed
   * shadow root with `:host{all:initial}` and a system-ui font), so what is
   * placed again is the button, from a fresh rect. Later batches and a lazy
   * `@font-face` fire `loadingdone` too, which is why the listener is on the
   * font set rather than a one-shot `ready`. Other late reflows (an image
   * that loads, content inserted above) change the document's size: a
   * ResizeObserver on <html> re-measures then.
   */
  function onFontsLoaded() {
    if (mode !== "select" || !btn?.isConnected) return;
    const rect = selRect();
    if (rect) place(rect);
  }

  function fontSet(): FontFaceSet | undefined {
    // A hostile page can define `document.fonts` with a throwing getter.
    try {
      return (
        (document as Document & { fonts?: FontFaceSet }).fonts ?? undefined
      );
    } catch {
      return undefined;
    }
  }

  function showButton() {
    if (mode !== "select" || coarse()) return hideButton();
    const rect = selRect();
    if (!rect) return hideButton();
    if (!btn) {
      btn = document.createElement("button");
      btn.innerHTML = `${BUBBLE}<span>Comment</span>`;
      // Keep the selection while the button is pressed.
      btn.addEventListener("pointerdown", (e) => e.preventDefault());
      btn.addEventListener("mousedown", (e) => e.preventDefault());
      btn.addEventListener("click", onCommentClick);
      btn.className = "btn";
    }
    if (!btn.isConnected) overlay().append(btn);
    place(rect);
  }

  function onCommentClick() {
    const live = selection();
    const s =
      live ??
      (kept && kept.ver === textVer
        ? { start: kept.start, end: kept.end }
        : null);
    if (!s) return hideButton();
    const block: BlockHint = {};
    if (format === "pdf") {
      const pg = Number(
        blockOf(nodeAtIndex(getIndex(), s.start))
          ?.closest(".page")
          ?.getAttribute("data-page-number"),
      );
      if (pg >= 1) block.page = pg;
    } else if (format === "code") {
      const t = getIndex().text;
      let line = 1;
      for (
        let i = t.indexOf("\n");
        i !== -1 && i < s.start;
        i = t.indexOf("\n", i + 1)
      )
        line++;
      block.line = line;
    }
    const { version: _v, ...anchor } = createTextAnchor(
      getIndex().text,
      s.start,
      s.end,
      1,
      block,
    );
    bridge.send({ oa: 1, type: "comment.select", anchor });
    getSelection()?.removeAllRanges();
    kept = null;
    hideButton();
    clearTimeout(selTimer);
    reportSelection();
  }

  // ---- clicks on the page: pin placement and highlight hits ----
  function onClick(e: MouseEvent) {
    if (mode === "off" || e.composedPath()[0] === host) return;
    adoptSheet();
    if (mode === "pin") {
      if (!hasPins) return;
      const target = e.target instanceof Element ? e.target : null;
      const el =
        format === "image"
          ? target?.closest(".oa-image img")
          : target?.closest(".page");
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;
      e.preventDefault();
      e.stopPropagation();
      const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
      const pg = Number(el.getAttribute("data-page-number"));
      bridge.send({
        oa: 1,
        type: "comment.pin",
        pin: pg >= 1 ? { x, y, page: pg } : { x, y },
        // #2019: where the click landed, so the shell can open the box beside
        // it. #2408: only for a shell that said it knows the field; an older
        // one refuses the whole message.
        ...((bridge.shellProtocol?.() ?? 0) >= SHELL_ANNOUNCES
          ? { at: { x: Math.max(0, e.clientX), y: Math.max(0, e.clientY) } }
          : {}),
      });
      return;
    }
    const sel = getSelection();
    if (sel && sel.rangeCount > 0 && !sel.isCollapsed) return;
    // #1473: a link or a control under the pointer does its own thing; opening
    // the thread too would both navigate and cover the page.
    // `composedPath()[0]`, not `target`: inside a shadow root the target is the
    // host, and a link in there would not be seen (#1473 review).
    const inner = e.composedPath()[0];
    const hit = inner instanceof Element ? inner : null;
    if (
      hit?.closest(
        "a[href], button, input, select, textarea, label, [role='button'], [role='link']",
      )
    )
      return;
    let best: { id: string; size: number } | undefined;
    for (const p of painted) {
      for (const r of Array.from(p.range.getClientRects())) {
        if (
          e.clientX < r.left ||
          e.clientX > r.right ||
          e.clientY < r.top ||
          e.clientY > r.bottom
        )
          continue;
        const size = p.range.toString().length;
        if (!best || size < best.size) best = { id: p.id, size };
      }
    }
    if (best) open(best.id);
  }

  /** Where Esc belongs to the page or to a dialog above the frame (#1698). */
  const ESC_NOT_OURS =
    "input, textarea, select, [aria-modal='true'], [data-state='open'][role='dialog'], [role='alertdialog']";
  // Esc in pin mode: the frame holds focus after a click, so tell the shell.
  // Not while an IME, a field or a modal owns the key, matching the shell's guard.
  function onKey(e: KeyboardEvent) {
    if (e.key !== "Escape" || mode !== "pin") return;
    if (e.isComposing) return;
    const t = e.target;
    if (
      t instanceof HTMLElement &&
      (t.isContentEditable || t.closest(ESC_NOT_OURS) !== null)
    )
      return;
    bridge.send({ oa: 1, type: "comment.escape" });
  }

  // A pointer down anywhere in the page but our own overlay: the shell drops
  // an unsent draft (the browser collapses the selection itself).
  function onPointerDown(e: PointerEvent) {
    if (mode === "off") return;
    if (host && e.composedPath().includes(host)) return;
    bridge.send({ oa: 1, type: "comment.away" });
  }

  // ---- shell messages ----
  const off = bridge.on((m) => {
    if (m.type === "comments.mode") {
      const was = mode;
      mode = m.mode;
      if (mode !== "select") {
        kept = null;
        clearTimeout(selTimer);
        reportSelection();
      } else if (was !== "select") {
        // A selection made before the shell's mode arrived (a fast reader,
        // or a test) is reported on entering select, not on its next change.
        // A repeated select is a no-op, so a stale quote's timer isn't reset.
        clearTimeout(selTimer);
        reportSelection();
      }
      if (mode === "off") {
        // No mode, no draft: a quote left behind would paint on the next set
        // (#1850 review).
        draftText = undefined;
        draftCache = null;
        hideButton();
        clearPaint();
        lastReport = "";
      } else {
        if (threads.length) report(true);
        showButton();
      }
    } else if (m.type === "comments.set") {
      threads = m.threads;
      ghost = m.ghost;
      draftText = m.draft;
      draftCache = null;
      slots = null;
      report(true);
    } else if (m.type === "comments.clear") {
      // The reader clicked elsewhere in the shell: a live selection ends here.
      getSelection()?.removeAllRanges();
      kept = null;
      clearTimeout(selTimer);
      reportSelection();
      hideButton();
    } else if (m.type === "comments.comment") {
      if (mode === "select") onCommentClick();
    } else if (m.type === "comments.focus") {
      const p = lastPositions.get(m.id);
      if (p?.top != null) scrollTo(0, Math.max(0, p.top - innerHeight / 3));
      flashId = m.id;
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => {
        flashId = undefined;
        report(false);
      }, FLASH_MS);
      report(false);
    }
  });

  // ---- page events ----
  // A mutation keeps the old slots: their live ranges are still re-measured
  // on scroll. Re-resolving runs from a timer, trailing MUTATION_MS but never
  // later than MUTATION_MAX_WAIT_MS after the first change, so a page that
  // never stops changing still re-anchors, and one that changes every frame
  // does not re-resolve every frame.
  let mutTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingSince = 0;
  const reresolve = () => {
    pendingSince = 0;
    slots = null;
    report(false);
  };
  const ours = (r: MutationRecord): boolean => {
    if (!host) return false;
    if (r.target === host || host.contains(r.target)) return true;
    return (
      r.target === document.documentElement &&
      r.addedNodes.length + r.removedNodes.length > 0 &&
      Array.from(r.addedNodes).every((n) => n === host) &&
      Array.from(r.removedNodes).every((n) => n === host)
    );
  };
  const onMutation = (records: MutationRecord[]) => {
    // A page that rewrote `adoptedStyleSheets` may not repaint anything: the
    // observer is the first thing to notice (#1473 review).
    adoptSheet();
    if (records.every(ours)) return;
    textVer++;
    const now = Date.now();
    if (!pendingSince) pendingSince = now;
    clearTimeout(mutTimer);
    mutTimer = setTimeout(
      reresolve,
      Math.max(
        0,
        Math.min(MUTATION_MS, pendingSince + MUTATION_MAX_WAIT_MS - now),
      ),
    );
  };
  // <html>, not <body>: a replaced or late body is a change there. The script
  // runs from <head>, so documentElement always exists.
  const observer =
    typeof MutationObserver === "undefined"
      ? undefined
      : new MutationObserver(onMutation);
  observer?.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  // <html>, as for mutations: a replaced body stays observed. Our overlay is
  // absolutely placed, so moving the button never resizes the document.
  const sizer =
    typeof ResizeObserver === "undefined"
      ? undefined
      : new ResizeObserver(onResize);
  sizer?.observe(document.documentElement);
  document.addEventListener("selectionchange", onSelectionChange);
  document.addEventListener("click", onClick, true);
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("keydown", onKey, true);
  addEventListener("resize", onResize, { passive: true });
  addEventListener("scroll", onScroll, { passive: true });

  const fonts = fontSet();
  fonts?.addEventListener?.("loadingdone", onFontsLoaded);

  const dispose = () => {
    off();
    fonts?.removeEventListener?.("loadingdone", onFontsLoaded);
    observer?.disconnect();
    sizer?.disconnect();
    document.removeEventListener("selectionchange", onSelectionChange);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("keydown", onKey, true);
    removeEventListener("resize", onResize);
    removeEventListener("scroll", onScroll);
    clearTimeout(mutTimer);
    clearTimeout(flashTimer);
    clearTimeout(selTimer);
    clearTimeout(keptTimer);
    if (raf) cancelAnimationFrame(raf);
    ended = true;
    const reg = highlights();
    reg?.delete("oa-comment");
    reg?.delete("oa-comment-active");
    if (sheet)
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter(
        (s) => s !== sheet,
      );
    offTheme?.();
    host?.remove();
  };
  // The bubble's colors follow the viewer's theme, not the OS's.
  const offTheme = theme?.on((t) =>
    layer?.classList.toggle("dark", t === "dark"),
  );
  // #1473: a signal that was already aborted never fires `abort`, so the host,
  // the listener and the stylesheet would stay behind.
  if (signal?.aborted) dispose();
  else signal?.addEventListener("abort", dispose);
  // `flush` after dispose would paint again and put the host back.
  return { flush: () => (ended ? undefined : report(false)), dispose };
}
