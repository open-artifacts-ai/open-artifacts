import { parseArtifactMessage } from "@oa/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntime } from "../src/index.js";
import * as schemas from "../src/schemas.js";

const N = "AbCdEfGhIjKlMnOpQrSt_-";
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

let parent: { postMessage: ReturnType<typeof vi.fn> };
let ctl: AbortController;
const realParent = window.parent;
const interacted = () =>
  parent.postMessage.mock.calls
    .map((c) => c[0] as { type: string })
    .filter((m) => m.type === "interacted");
const start = () =>
  createRuntime({ loadSchemas: async () => schemas, signal: ctl.signal });
const scrollTo = (y: number) => {
  Object.defineProperty(window, "scrollY", { value: y, configurable: true });
  window.dispatchEvent(new Event("scroll"));
};

beforeEach(() => {
  ctl = new AbortController();
  parent = { postMessage: vi.fn() };
  Object.defineProperty(window, "parent", {
    value: parent,
    configurable: true,
  });
});
afterEach(() => {
  ctl.abort();
  Object.defineProperty(window, "parent", {
    value: realParent,
    configurable: true,
  });
  Object.defineProperty(window, "scrollY", { value: 0, configurable: true });
  delete (window as unknown as Record<string, unknown>).__oaShellNonce;
  history.replaceState(null, "", "/");
});

describe("oa:interacted", () => {
  it("posts once on the first pointerdown, with the nonce and no payload", async () => {
    delete (window as unknown as Record<string, unknown>).__oaShellNonce;
    history.replaceState(null, "", `/p#oa=${N}`);
    start();
    await flush();
    expect(interacted()).toEqual([]);
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    await flush();
    expect(interacted()).toEqual([{ oa: 1, type: "interacted", nonce: N }]);
    expect(parseArtifactMessage(interacted()[0])).not.toBeNull();
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    window.dispatchEvent(new Event("keydown"));
    scrollTo(500);
    await flush();
    expect(interacted()).toHaveLength(1);
  });

  it.each(["keydown", "input", "change"])("posts on %s", async (type) => {
    start();
    window.dispatchEvent(new Event(type));
    await flush();
    expect(interacted()).toHaveLength(1);
  });

  it("scrolling never counts: live versions keep swapping while you read", async () => {
    start();
    scrollTo(10);
    scrollTo(500);
    const el = document.createElement("div");
    document.body.append(el);
    Object.defineProperty(el, "scrollTop", { value: 400, configurable: true });
    el.dispatchEvent(new Event("scroll"));
    await flush();
    expect(interacted()).toHaveLength(0);
    el.remove();
  });

  it("no-ops without a shell", async () => {
    Object.defineProperty(window, "parent", {
      value: window,
      configurable: true,
    });
    const post = vi.spyOn(window, "postMessage");
    start();
    window.dispatchEvent(new Event("pointerdown"));
    await flush();
    expect(post).not.toHaveBeenCalled();
    post.mockRestore();
  });
});
