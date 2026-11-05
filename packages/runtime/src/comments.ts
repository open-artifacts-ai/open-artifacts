import {
  type Anchor,
  type BlockHint,
  createTextAnchor,
  resolveTextAnchor,
  type ShellToArtifact,
  type TextAnchor,
} from "@oa/shared";
import type { Bridge } from "./bridge.js";
import {
  flatText,
  offsetsToRange,
  rangeToOffsets,
  textNodeAt,
} from "./text-range.js";

// The frame half of comments (#682). Loaded with the schemas chunk, not the
// entry. Hard rule: comment text and author names never enter the frame. The
// shell sends anchors, opaque ids, pin numbers and flags; the frame sends
// anchors it built from the page's own text, ids, states and pixel offsets.
// Nothing here adds a node to the page: the overlay is one host element under
// <html> with a closed shadow root, and highlights use the CSS Custom Highlight
// API with an adopted stylesheet.

type Thread = Extract<
  ShellToArtifact,
  { type: "comments.set" }
>["threads"][number];
type Registry = {
  set(name: string, h: unknown): void;
  delete(name: string): void;
};
type Mode = "off" | "select" | "pin";
type Pos = {
  id: string;
  state: "exact" | "partial" | "collapsed" | "orphan" | "pin";
  top: number | null;
};

const BLOCK =
  "p,li,h1,h2,h3,h4,h5,h6,pre,blockquote,td,th,dt,dd,figcaption,div,section,article,.line";
const MUTATION_MS = 150;
const FLASH_MS = 1200;

const OVERLAY_CSS = `
:host{all:initial}
.btn{position:absolute;font:600 13px system-ui,sans-serif;padding:4px 10px;border:0;border-radius:6px;background:#1f5fbf;color:#fff;cursor:pointer;pointer-events:auto;box-shadow:0 2px 8px #0004}
.mark{position:absolute;width:6px;height:16px;border-radius:2px;background:#e0a000;pointer-events:auto;cursor:pointer}
.mark.on{background:#1f5fbf}
.pin{position:absolute;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;background:#1f5fbf;color:#fff;font:700 12px/22px system-ui,sans-serif;text-align:center;pointer-events:auto;cursor:pointer;box-shadow:0 1px 4px #0006}
.pin.on{outline:3px solid #e0a000}
`;
const PAGE_CSS =
  "::highlight(oa-comment){background:rgba(255,200,0,.35)}::highlight(oa-comment-active){background:rgba(255,160,0,.6)}";

export interface Comments {
  /** Recompute positions now and report them if they changed. */
  flush(): void;
  dispose(): void;
}

export function createComments(
  bridge: Pick<Bridge, "on" | "send">,
  signal?: AbortSignal,
): Comments {
  const format =
    document.querySelector('meta[name="oa-format"]')?.getAttribute("content") ??
    "html";
  const hasPins = format === "image" || format === "pdf";
  let mode: Mode = "off";
  let threads: Thread[] = [];
  let text: string | null = null;
  let lastReport = "";
  let painted: { id: string; range: Range }[] = [];
  let flashId: string | undefined;
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  const lastPositions = new Map<string, Pos>();

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
    root.append(style, layer);
    document.documentElement.append(host);
    return layer;
  };

  let sheet: CSSStyleSheet | undefined;
  const highlights = (): Registry | undefined => {
    if (typeof CSS === "undefined" || !("highlights" in CSS)) return undefined;
    if (!sheet && typeof CSSStyleSheet !== "undefined") {
      try {
        sheet = new CSSStyleSheet();
        sheet.replaceSync(PAGE_CSS);
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      } catch {
        sheet = undefined;
      }
    }
    return (CSS as unknown as { highlights: Registry }).highlights;
  };

  const getText = (): string => {
    if (text === null) text = flatText(document.body);
    return text;
  };

  // ---- positions and painting ----
  const docTop = (r: DOMRect) => r.top + scrollY;

  function pinBox(a: Extract<Anchor, { kind: "pin" }>): DOMRect | null {
    const el =
      format === "image"
        ? document.querySelector(".oa-image img")
        : a.page
          ? document.querySelector(`.page[data-page-number="${a.page}"]`)
          : null;
    return el ? el.getBoundingClientRect() : null;
  }

  function textRect(start: number, end: number): DOMRect | null {
    const r = offsetsToRange(document.body, start, end);
    if (!r) return null;
    const rect = r.getClientRects()[0] ?? r.getBoundingClientRect();
    return rect && (rect.width > 0 || rect.height > 0) ? rect : null;
  }

  function compute(): Pos[] {
    const t = getText();
    const out: Pos[] = [];
    const normal: Range[] = [];
    const active: Range[] = [];
    painted = [];
    const marks: HTMLElement[] = [];
    const mark = (cls: string, x: number, y: number, label?: string) => {
      const d = document.createElement("div");
      d.className = cls;
      d.style.left = `${x}px`;
      d.style.top = `${y}px`;
      if (label) d.textContent = label;
      marks.push(d);
      return d;
    };
    for (const th of threads) {
      const isActive = !!th.active || th.id === flashId;
      if (th.anchor.kind === "pin") {
        const box = pinBox(th.anchor);
        if (!box) {
          out.push({ id: th.id, state: "pin", top: null });
          continue;
        }
        const x = box.left + scrollX + th.anchor.x * box.width;
        const y = box.top + scrollY + th.anchor.y * box.height;
        out.push({ id: th.id, state: "pin", top: y });
        if (!th.resolved) {
          const d = mark(isActive ? "pin on" : "pin", x, y, String(th.n ?? ""));
          d.addEventListener("click", () => open(th.id));
        }
        continue;
      }
      if (th.anchor.kind !== "text") continue;
      const res = resolveTextAnchor(t, th.anchor as TextAnchor);
      if (res.state === "orphan") {
        out.push({ id: th.id, state: "orphan", top: null });
      } else if (res.state === "collapsed") {
        const rect =
          textRect(res.at, res.at + 1) ??
          (res.at > 0 ? textRect(res.at - 1, res.at) : null);
        out.push({
          id: th.id,
          state: "collapsed",
          top: rect ? docTop(rect) : null,
        });
        if (rect && !th.resolved) {
          const d = mark(
            isActive ? "mark on" : "mark",
            rect.left + scrollX - 3,
            docTop(rect),
          );
          d.addEventListener("click", () => open(th.id));
        }
      } else {
        const range = offsetsToRange(document.body, res.start, res.end);
        const rect = textRect(res.start, res.end);
        out.push({
          id: th.id,
          state: res.state,
          top: rect ? docTop(rect) : null,
        });
        if (range && !th.resolved) {
          (isActive ? active : normal).push(range);
          painted.push({ id: th.id, range });
        }
      }
    }
    const reg = highlights();
    if (reg && typeof Highlight !== "undefined") {
      reg.set("oa-comment", new Highlight(...normal));
      reg.set("oa-comment-active", new Highlight(...active));
    }
    if (marks.length || layer)
      overlay().replaceChildren(...marks, ...(btn?.isConnected ? [btn] : []));
    return out;
  }

  function report(force: boolean) {
    if (mode === "off" && !threads.length) return;
    const positions = compute();
    lastPositions.clear();
    for (const p of positions) lastPositions.set(p.id, p);
    const key = JSON.stringify(positions);
    if (!force && key === lastReport) return;
    lastReport = key;
    bridge.send({ oa: 1, type: "comment.positions", positions });
  }

  let raf = 0;
  const schedule = () => {
    if (raf || mode === "off") return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      report(false);
      showButton();
    });
  };

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
    const o = rangeToOffsets(document.body, range);
    if (!o) return null;
    const t = getText();
    let { start, end } = o;
    while (start < end && /\s/.test(t[start])) start++;
    while (end > start && /\s/.test(t[end - 1])) end--;
    if (end <= start) return null;
    const a = textNodeAt(document.body, start);
    const b = textNodeAt(document.body, end - 1);
    const block = blockOf(a);
    if (!a || !b || !block || block !== blockOf(b)) return null;
    return { start, end, range };
  }

  function hideButton() {
    btn?.remove();
  }

  function showButton() {
    if (mode !== "select") return hideButton();
    const s = selection();
    if (!s) return hideButton();
    const rects = s.range.getClientRects();
    const rect = rects[rects.length - 1] ?? s.range.getBoundingClientRect();
    if (!btn) {
      btn = document.createElement("button");
      btn.textContent = "Comment";
      // Keep the selection while the button is pressed.
      btn.addEventListener("pointerdown", (e) => e.preventDefault());
      btn.addEventListener("mousedown", (e) => e.preventDefault());
      btn.addEventListener("click", onCommentClick);
      btn.className = "btn";
    }
    btn.style.left = `${rect.right + scrollX}px`;
    btn.style.top = `${rect.bottom + scrollY + 4}px`;
    if (!btn.isConnected) overlay().append(btn);
  }

  function onCommentClick() {
    const s = selection();
    if (!s) return hideButton();
    const block: BlockHint = {};
    if (format === "pdf") {
      const pg = Number(
        blockOf(textNodeAt(document.body, s.start))
          ?.closest(".page")
          ?.getAttribute("data-page-number"),
      );
      if (pg >= 1) block.page = pg;
    } else if (format === "code") {
      const t = getText();
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
      getText(),
      s.start,
      s.end,
      1,
      block,
    );
    bridge.send({ oa: 1, type: "comment.select", anchor });
    getSelection()?.removeAllRanges();
    hideButton();
  }

  // ---- clicks on the page: pin placement and highlight hits ----
  function onClick(e: MouseEvent) {
    if (mode === "off" || e.composedPath()[0] === host) return;
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
      });
      return;
    }
    const sel = getSelection();
    if (sel && sel.rangeCount > 0 && !sel.isCollapsed) return;
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

  // ---- shell messages ----
  const off = bridge.on((m) => {
    if (m.type === "comments.mode") {
      mode = m.mode;
      if (mode === "off") {
        hideButton();
        lastReport = "";
      }
      if (mode !== "off") showButton();
    } else if (m.type === "comments.set") {
      threads = m.threads;
      report(true);
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
  let mutTimer: ReturnType<typeof setTimeout> | undefined;
  const onMutation = () => {
    text = null;
    clearTimeout(mutTimer);
    mutTimer = setTimeout(() => report(false), MUTATION_MS);
  };
  const observer =
    typeof MutationObserver === "undefined"
      ? undefined
      : new MutationObserver(onMutation);
  observer?.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  document.addEventListener("selectionchange", schedule);
  document.addEventListener("click", onClick, true);
  addEventListener("resize", schedule, { passive: true });
  addEventListener("scroll", schedule, { passive: true });

  const dispose = () => {
    off();
    observer?.disconnect();
    document.removeEventListener("selectionchange", schedule);
    document.removeEventListener("click", onClick, true);
    removeEventListener("resize", schedule);
    removeEventListener("scroll", schedule);
    clearTimeout(mutTimer);
    clearTimeout(flashTimer);
    if (raf) cancelAnimationFrame(raf);
    const reg = highlights();
    reg?.delete("oa-comment");
    reg?.delete("oa-comment-active");
    if (sheet)
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter(
        (s) => s !== sheet,
      );
    host?.remove();
  };
  signal?.addEventListener("abort", dispose);
  return { flush: () => report(false), dispose };
}
