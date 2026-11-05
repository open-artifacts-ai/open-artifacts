// The runtime tells the shell when the reader is mid-task in the frame (text
// selected, or a field focused), so a live swap waits: and when that ends.
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
const engaged = () =>
  parent.postMessage.mock.calls
    .map((c) => c[0] as { type: string; engaged?: boolean })
    .filter((m) => m.type === "engaged")
    .map((m) => m.engaged);

beforeEach(async () => {
  delete (window as unknown as Record<string, unknown>).__oaShellNonce;
  history.replaceState(null, "", `/p#oa=${N}`);
  ctl = new AbortController();
  parent = { postMessage: vi.fn() };
  Object.defineProperty(window, "parent", {
    value: parent,
    configurable: true,
  });
  document.body.innerHTML =
    '<p id="t">some text</p><input id="i"><textarea id="a"></textarea><div id="e" contenteditable="true">x</div><button id="b">b</button>';
  createRuntime({ loadSchemas: async () => schemas, signal: ctl.signal });
  await flush();
});
afterEach(() => {
  ctl.abort();
  (document.activeElement as HTMLElement | null)?.blur();
  getSelection()?.removeAllRanges();
  document.body.innerHTML = "";
  Object.defineProperty(window, "parent", {
    value: realParent,
    configurable: true,
  });
});

describe("engaged", () => {
  it.each(["i", "a", "e"])(
    "focusing #%s reports engaged, leaving it clears",
    async (id) => {
      (document.getElementById(id) as HTMLElement).focus();
      await flush();
      (document.getElementById(id) as HTMLElement).blur();
      // Leaving is checked once focus has landed (a task later).
      await new Promise((r) => setTimeout(r, 0));
      await flush();
      expect(engaged()).toEqual([true, false]);
    },
  );

  it("a button's focus isn't engaged", async () => {
    (document.getElementById("b") as HTMLElement).focus();
    await flush();
    expect(engaged()).toEqual([]);
  });

  it("a non-empty selection is engaged; collapsing it clears", async () => {
    const r = document.createRange();
    r.selectNodeContents(document.getElementById("t") as HTMLElement);
    getSelection()?.addRange(r);
    document.dispatchEvent(new Event("selectionchange"));
    await flush();
    getSelection()?.removeAllRanges();
    document.dispatchEvent(new Event("selectionchange"));
    await flush();
    expect(engaged()).toEqual([true, false]);
  });

  it("reports changes only, with the nonce", async () => {
    (document.getElementById("i") as HTMLElement).focus();
    document.dispatchEvent(new Event("selectionchange"));
    await flush();
    const msgs = parent.postMessage.mock.calls
      .map((c) => c[0] as { type: string })
      .filter((m) => m.type === "engaged");
    expect(msgs).toEqual([{ oa: 1, type: "engaged", engaged: true, nonce: N }]);
  });
});
