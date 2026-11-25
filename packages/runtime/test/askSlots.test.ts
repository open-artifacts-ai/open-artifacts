import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAskSlots } from "../src/askSlots.js";

type Msg = { type: string; [k: string]: unknown };
let listeners: ((m: Msg) => void)[];
let sent: Msg[];
let proto: number;
let raf: FrameRequestCallback[];
let ctl: AbortController;

const bridge = () => ({
  on: (l: (m: never) => void) => {
    listeners.push(l as (m: Msg) => void);
    return () => {};
  },
  send: (m: Msg) => void sent.push(m),
  shellProtocol: () => proto,
});
const frames = () => {
  const q = raf;
  raf = [];
  for (const cb of q) cb(0);
};
const slotsMsgs = () => sent.filter((m) => m.type === "ask.slots");
const lastSlots = () =>
  slotsMsgs().at(-1)?.slots as { key: string; rect: Record<string, number> }[];
const fromShell = (m: Msg) => {
  for (const l of listeners) l(m);
};
const slot = (key: string) => {
  const d = document.createElement("div");
  d.setAttribute("data-oa-ask", key);
  document.body.append(d);
  return d;
};
const start = () => createAskSlots(bridge() as never, ctl.signal);

beforeEach(() => {
  listeners = [];
  sent = [];
  proto = 8;
  raf = [];
  ctl = new AbortController();
  document.body.innerHTML = "";
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    raf.push(cb);
    return raf.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
});
afterEach(() => {
  ctl.abort();
  vi.unstubAllGlobals();
});

describe("ask slots in the frame", () => {
  it("reports each [data-oa-ask] element by key, on the next frame", () => {
    slot("launch-day");
    slot("other-1");
    start();
    expect(slotsMsgs()).toHaveLength(0);
    frames();
    expect(lastSlots().map((s) => s.key)).toEqual(["launch-day", "other-1"]);
    expect(lastSlots()[0]?.rect).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  it("drops keys that do not match [a-z0-9-]{1,64}, and repeats", () => {
    for (const k of ["Bad", "has space", "a_b", "", "x".repeat(65), "ok", "ok"])
      slot(k);
    start();
    frames();
    expect(lastSlots().map((s) => s.key)).toEqual(["ok"]);
  });

  it("reports at most 20 slots", () => {
    for (let i = 0; i < 25; i++) slot(`s${i}`);
    start();
    frames();
    expect(lastSlots()).toHaveLength(20);
    expect(lastSlots().at(-1)?.key).toBe("s19");
  });

  it("clamps the rect to the contract's range", () => {
    const el = slot("far");
    el.getBoundingClientRect = () =>
      ({ left: 1e9, top: -1e9, width: 1e9, height: Number.NaN }) as DOMRect;
    start();
    frames();
    expect(lastSlots()[0]?.rect).toEqual({
      x: 100_000,
      y: -100_000,
      width: 100_000,
      height: 0,
    });
  });

  it("sends nothing to a shell older than protocol 8, until it announces 8", () => {
    proto = 7;
    slot("a");
    start();
    frames();
    expect(slotsMsgs()).toHaveLength(0);
    proto = 8;
    fromShell({ type: "shell.protocol", protocol: 8 });
    frames();
    expect(slotsMsgs()).toHaveLength(1);
  });

  it("reports again when the page changes, and not when nothing moved", () => {
    start();
    frames();
    expect(slotsMsgs()).toHaveLength(0);
    const el = slot("late");
    el.getBoundingClientRect = () =>
      ({ left: 5, top: 6, width: 7, height: 8 }) as DOMRect;
    dispatchEvent(new Event("scroll"));
    frames();
    expect(slotsMsgs()).toHaveLength(1);
    dispatchEvent(new Event("resize"));
    frames();
    expect(slotsMsgs()).toHaveLength(1);
  });

  it("sets the slot height on ask.slotSize, important, and marks it", () => {
    const el = slot("a");
    el.style.cssText = "height: 1px";
    start();
    fromShell({ type: "ask.slotSize", key: "a", h: 180 });
    expect(el.style.getPropertyValue("height")).toBe("180px");
    expect(el.style.getPropertyPriority("height")).toBe("important");
    expect(el.style.getPropertyValue("min-height")).toBe("180px");
    expect(el.getAttribute("data-oa-ask-sized")).toBe("180");
  });

  it("collapses a key the shell answered with h 0, padding and all", () => {
    const el = slot("unknown");
    el.style.cssText = "height: 300px; padding: 20px";
    start();
    fromShell({ type: "ask.slotSize", key: "unknown", h: 0 });
    expect(el.style.getPropertyValue("height")).toBe("0px");
    expect(el.style.getPropertyValue("padding")).toBe("0px");
    expect(el.getAttribute("data-oa-ask-sized")).toBe("0");
  });

  it("keeps a size for a slot that appears after the answer", () => {
    start();
    fromShell({ type: "ask.slotSize", key: "later", h: 90 });
    const el = slot("later");
    frames();
    expect(el.style.getPropertyValue("height")).toBe("90px");
  });

  it("settles when a report changes nothing (#3064 review)", () => {
    // A ResizeObserver that calls back as soon as it observes, as browsers do
    // on the initial delivery: re-observing on every report used to loop.
    const callbacks: (() => void)[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(cb: () => void) {
          callbacks.push(cb);
        }
        observe() {
          for (const cb of callbacks) cb();
        }
        disconnect() {}
      },
    );
    slot("launch-day");
    start();
    frames();
    frames();
    // One report went out; nothing is pending, so the loop has stopped.
    expect(slotsMsgs()).toHaveLength(1);
    expect(raf).toHaveLength(0);
  });

  it("watches the document only once a slot exists or the shell reads slots", () => {
    const observe = vi.fn();
    vi.stubGlobal(
      "MutationObserver",
      class {
        observe = observe;
        disconnect() {}
      },
    );
    // No slot, no protocol yet: an ordinary page pays nothing.
    proto = 0;
    start();
    frames();
    expect(observe).not.toHaveBeenCalled();
    // The shell announces protocol 8: now it watches.
    proto = 8;
    fromShell({ type: "shell.protocol", protocol: 8 });
    expect(observe).toHaveBeenCalledTimes(1);
  });

  it("caps a height at 2000 and ignores a bad key", () => {
    const el = slot("a");
    start();
    fromShell({ type: "ask.slotSize", key: "a", h: 99_999 });
    expect(el.style.getPropertyValue("height")).toBe("2000px");
    const bad = slot("Bad");
    fromShell({ type: "ask.slotSize", key: "Bad", h: 10 });
    expect(bad.style.getPropertyValue("height")).toBe("");
  });
});
