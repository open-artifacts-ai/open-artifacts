// @vitest-environment jsdom
// #3024: "on" means a push can arrive: a subscription made with the server's
// current key, listed by the server.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SW_SCOPE, thisBrowserOn } from "../src/foryou/push";

const KEY =
  "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U";
const keyBytes = () =>
  Uint8Array.from(atob(KEY.replace(/-/g, "+").replace(/_/g, "/") + "="), (c) =>
    c.charCodeAt(0),
  ).buffer;
const OTHER = new Uint8Array(65).fill(7).buffer;

let key: ArrayBuffer;
beforeEach(() => {
  key = keyBytes();
  const reg = {
    scope: `${location.origin}${SW_SCOPE}`,
    pushManager: {
      getSubscription: async () => ({
        options: { applicationServerKey: key },
      }),
    },
  };
  vi.stubGlobal("PushManager", function PushManager() {});
  vi.stubGlobal("Notification", { permission: "granted" });
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { getRegistration: async () => reg },
  });
  localStorage.setItem(
    "oa.push.subscription.v2",
    JSON.stringify({ userId: "u1", id: "sub_1" }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  Reflect.deleteProperty(navigator, "serviceWorker");
});

describe("thisBrowserOn", () => {
  it("matching key and a listed row: on", async () => {
    expect(await thisBrowserOn(KEY, [{ id: "sub_1" }], "u1")).toBe(true);
  });
  it("a stale key: off", async () => {
    key = OTHER;
    expect(await thisBrowserOn(KEY, [{ id: "sub_1" }], "u1")).toBe(false);
  });
  it("the server deleted the row: off", async () => {
    expect(await thisBrowserOn(KEY, [], "u1")).toBe(false);
  });
  it("no key (fetch failed or push_unavailable): off", async () => {
    expect(await thisBrowserOn(null, [{ id: "sub_1" }], "u1")).toBe(false);
  });
});
