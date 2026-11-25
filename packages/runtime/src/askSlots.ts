import type { Bridge } from "./bridge.js";

/** #2426 B: the first shell protocol that reads `ask.slots` (shared PROTOCOL_ASK_SLOTS; not imported to keep this chunk small). */
export const SHELL_ASK_SLOTS = 8;
/** At most this many slots are reported; the rest are dropped (shared ASK_SLOTS_MAX). */
export const SLOTS_MAX = 20;
/** The tallest a slot may be made (shared ASK_SLOT_H_MAX). */
export const SLOT_H_MAX = 2000;
const KEY = /^[a-z0-9-]{1,64}$/;
const SEL = "[data-oa-ask]";

const clamp = (n: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : 0));

/**
 * #2426 B: the page marks places for asks with `<div data-oa-ask="key">`. The
 * runtime tells the shell where they are (never what is in them) and lets the
 * shell set their height, so the shell's card, drawn over the frame, takes room
 * in the page's flow. A key means nothing until the shell maps it to an ask.
 */
export function createAskSlots(
  bridge: Pick<Bridge, "on" | "send"> & Partial<Pick<Bridge, "shellProtocol">>,
  signal?: AbortSignal,
) {
  /** The heights the shell asked for, by key: they stick to a slot that appears later. */
  const sizes = new Map<string, number>();
  let last = "[]";
  let raf = 0;
  let ended = false;

  /** Valid, first-wins, capped: the slot elements by key. */
  const find = (): [string, HTMLElement][] => {
    const seen = new Set<string>();
    const out: [string, HTMLElement][] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(SEL))) {
      const key = el.getAttribute("data-oa-ask") ?? "";
      if (!KEY.test(key) || seen.has(key)) continue;
      seen.add(key);
      out.push([key, el]);
      if (out.length >= SLOTS_MAX) break;
    }
    return out;
  };

  // Inline and important: the page's own styles cannot collapse a slot the
  // shell sized, or stretch one it closed.
  const set = (el: HTMLElement, p: string, v: string) => {
    if (
      el.style.getPropertyValue(p) !== v ||
      el.style.getPropertyPriority(p) !== "important"
    )
      el.style.setProperty(p, v, "important");
  };
  const size = (el: HTMLElement, h: number) => {
    const px = `${h}px`;
    set(el, "display", "block");
    set(el, "box-sizing", "border-box");
    set(el, "height", px);
    set(el, "min-height", px);
    set(el, "max-height", px);
    set(el, "overflow", "hidden");
    if (h === 0) {
      for (const p of ["padding", "margin", "border-width"]) set(el, p, "0");
    }
    el.setAttribute("data-oa-ask-sized", String(h));
  };

  /**
   * The slots the ResizeObserver watches. Re-observing every report would fire
   * its initial callback for each element each time, which reports again: a
   * loop at rAF speed with nothing changing.
   */
  let watched: HTMLElement[] = [];
  const watchSlots = (els: HTMLElement[]) => {
    if (
      els.length === watched.length &&
      els.every((el, i) => el === watched[i])
    )
      return;
    ro?.disconnect();
    for (const el of els) ro?.observe(el);
    watched = els;
  };

  const report = (force: boolean) => {
    raf = 0;
    if (ended) return;
    const slots = find();
    for (const [key, el] of slots) {
      const h = sizes.get(key);
      if (h !== undefined) size(el, h);
    }
    watchSlots(slots.map(([, el]) => el));
    if ((bridge.shellProtocol?.() ?? 0) < SHELL_ASK_SLOTS) return;
    const list = slots.map(([key, el]) => {
      const r = el.getBoundingClientRect();
      return {
        key,
        rect: {
          x: clamp(r.left, -100_000, 100_000),
          y: clamp(r.top, -100_000, 100_000),
          width: clamp(r.width, 0, 100_000),
          height: clamp(r.height, 0, 100_000),
        },
      };
    });
    const sig = JSON.stringify(list);
    if (!force && sig === last) return;
    last = sig;
    bridge.send({ oa: 1, type: "ask.slots", slots: list });
  };

  let force = false;
  const schedule = (f = false) => {
    force ||= f;
    if (raf || ended) return;
    raf = requestAnimationFrame(() => {
      const f2 = force;
      force = false;
      report(f2);
    });
  };

  const ro =
    typeof ResizeObserver === "undefined"
      ? undefined
      : new ResizeObserver(() => schedule());
  const mo =
    typeof MutationObserver === "undefined"
      ? undefined
      : new MutationObserver(() => schedule());
  /**
   * Watch the document's own changes once a slot exists, or once the shell has
   * said it reads them (protocol 8): before that a page pays nothing for this,
   * and a page with no slots is the common case.
   */
  let watching = false;
  const watchDocument = () => {
    if (watching || ended) return;
    if ((bridge.shellProtocol?.() ?? 0) < SHELL_ASK_SLOTS && !find().length)
      return;
    watching = true;
    mo?.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-oa-ask", "style", "class"],
    });
  };
  watchDocument();
  const onMove = () => schedule();
  addEventListener("resize", onMove, { passive: true });
  addEventListener("scroll", onMove, { passive: true, capture: true });

  const off = bridge.on((m) => {
    if (m.type === "shell.protocol") {
      watchDocument();
      schedule(true);
    } else if (m.type === "ask.slotSize") {
      watchDocument();
      const h = clamp(m.h, 0, SLOT_H_MAX);
      sizes.set(m.key, h);
      const hit = find().find(([k]) => k === m.key);
      if (hit) size(hit[1], h);
      schedule();
    }
  });

  const stop = () => {
    ended = true;
    off();
    mo?.disconnect();
    ro?.disconnect();
    cancelAnimationFrame(raf);
    removeEventListener("resize", onMove);
    removeEventListener("scroll", onMove, true);
  };
  signal?.addEventListener("abort", stop);
  schedule();
  return { dispose: stop };
}
