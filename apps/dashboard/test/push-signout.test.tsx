// @vitest-environment jsdom
// Axe M1 (#2677): signing out turns browser notifications off for this
// browser, best effort and bounded, so sign-out never fails or hangs on it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api/client";
import { forgetThisBrowser, SW_SCOPE } from "../src/foryou/push";

const unsubscribe = vi.fn();
const order: string[] = [];

beforeEach(() => {
  order.length = 0;
  unsubscribe.mockReset().mockImplementation(async () => {
    order.push("unsubscribe");
    return true;
  });
  const reg = {
    scope: `${location.origin}${SW_SCOPE}`,
    pushManager: { getSubscription: async () => ({ unsubscribe }) },
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
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  Reflect.deleteProperty(navigator, "serviceWorker");
});

describe("forgetThisBrowser", () => {
  it("deletes this browser's subscription on the server, then unsubscribes it", async () => {
    const send = vi.spyOn(api, "send").mockImplementation(async (m, p) => {
      order.push(`${m} ${p}`);
      return undefined as never;
    });
    await forgetThisBrowser();
    expect(order).toEqual([
      "DELETE /api/v1/me/push/subscriptions/sub_1",
      "unsubscribe",
    ]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("oa.push.subscription.v2")).toBeNull();
  });

  it("a failing delete still unsubscribes, and never throws", async () => {
    vi.spyOn(api, "send").mockRejectedValue(new Error("500"));
    await expect(forgetThisBrowser()).resolves.toBeUndefined();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("a failing unsubscribe never throws", async () => {
    vi.spyOn(api, "send").mockResolvedValue(undefined as never);
    unsubscribe.mockRejectedValue(new Error("no"));
    await expect(forgetThisBrowser()).resolves.toBeUndefined();
  });

  it("a hung delete and a hung unsubscribe each give up after the step time", async () => {
    vi.useFakeTimers();
    let aborted = false;
    vi.spyOn(api, "send").mockImplementation(
      (_m, _p, _b, _s, signal) =>
        new Promise(() => {
          signal?.addEventListener("abort", () => {
            aborted = true;
          });
        }),
    );
    unsubscribe.mockReturnValue(new Promise(() => {}));
    let done = false;
    void forgetThisBrowser(1000).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(aborted).toBe(true);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(done).toBe(true);
  });

  it("with no stored id, only the browser's own subscription goes", async () => {
    localStorage.clear();
    const send = vi.spyOn(api, "send");
    await forgetThisBrowser();
    expect(send).not.toHaveBeenCalled();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("a browser without push: nothing to do, no error", async () => {
    Reflect.deleteProperty(navigator, "serviceWorker");
    localStorage.clear();
    await expect(forgetThisBrowser()).resolves.toBeUndefined();
  });
});
