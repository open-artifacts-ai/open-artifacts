// @vitest-environment jsdom
// #3024: the server's push key can change (it is derived from SESSION_SECRET).
// A browser subscription made with another key never gets a push, so turning
// on replaces it instead of reusing it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api/client";
import { SW_SCOPE, turnOn } from "../src/foryou/push";

// 65 bytes, base64url: the server's current key (and the same bytes as an ArrayBuffer).
const KEY =
  "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U";
const keyBytes = () => {
  const b = atob(KEY.replace(/-/g, "+").replace(/_/g, "/") + "===".slice(0, 0));
  return Uint8Array.from(b, (c) => c.charCodeAt(0)).buffer;
};
const OTHER = new Uint8Array(65).fill(7).buffer;

const mkSub = (endpoint: string, key: ArrayBuffer | null) => ({
  endpoint,
  options: { applicationServerKey: key },
  toJSON: () => ({ endpoint, keys: { p256dh: "p", auth: "a" } }),
  unsubscribe: vi.fn(async () => true),
});

let existing: ReturnType<typeof mkSub> | null;
const fresh = mkSub("https://push.example.com/new", keyBytes());
const subscribe = vi.fn();
const send = vi.fn();

beforeEach(() => {
  subscribe.mockReset().mockResolvedValue(fresh);
  send
    .mockReset()
    .mockImplementation(async (m: string) =>
      m === "POST" ? { id: "sub_new" } : undefined,
    );
  vi.spyOn(api, "send").mockImplementation(send);
  const reg = {
    scope: `${location.origin}${SW_SCOPE}`,
    active: {},
    installing: null,
    waiting: null,
    pushManager: { getSubscription: async () => existing, subscribe },
  };
  vi.stubGlobal("PushManager", function PushManager() {});
  vi.stubGlobal("Notification", {
    permission: "granted",
    requestPermission: async () => "granted",
  });
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { register: async () => reg },
  });
  localStorage.setItem(
    "oa.push.subscription.v2",
    JSON.stringify({ userId: "u1", id: "sub_old" }),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  Reflect.deleteProperty(navigator, "serviceWorker");
});

describe("turnOn with an existing browser subscription (#3024)", () => {
  it("another key: unsubscribed, replaced, the new endpoint posted, the old row removed", async () => {
    existing = mkSub("https://push.example.com/old", OTHER);
    expect(await turnOn(KEY, "Chrome", "u1")).toBe("sub_new");
    expect(existing.unsubscribe).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledTimes(1);
    const post = send.mock.calls.find((c) => c[0] === "POST");
    expect(post?.[2]).toMatchObject({
      endpoint: "https://push.example.com/new",
    });
    expect(send.mock.calls.map((c) => [c[0], c[1]])).toContainEqual([
      "DELETE",
      expect.stringContaining("sub_old"),
    ]);
  });

  it("a null key counts as another key", async () => {
    existing = mkSub("https://push.example.com/old", null);
    await turnOn(KEY, "Chrome", "u1");
    expect(existing.unsubscribe).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it("the same key: reused, no unsubscribe, no subscribe, no DELETE", async () => {
    existing = mkSub("https://push.example.com/old", keyBytes());
    await turnOn(KEY, "Chrome", "u1");
    expect(existing.unsubscribe).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
    expect(send.mock.calls.some((c) => c[0] === "DELETE")).toBe(false);
    expect(send.mock.calls.find((c) => c[0] === "POST")?.[2]).toMatchObject({
      endpoint: "https://push.example.com/old",
    });
  });
});
