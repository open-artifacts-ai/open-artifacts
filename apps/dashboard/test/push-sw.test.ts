// #2512 slice 3: the service worker (public/sw.js), run against a fake
// worker global: a push shows the server's text with no buttons, and a click
// opens only a same-origin path.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const SRC = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
const ORIGIN = "https://app.example.com";

function worker(windows: { url: string }[] = []) {
  const on: Record<string, (e: unknown) => void> = {};
  const shown: { title: string; options: Record<string, unknown> }[] = [];
  const opened: string[] = [];
  const posted: unknown[] = [];
  const wins = windows.map((w) => ({
    ...w,
    focus: vi.fn(async () => {}),
    postMessage: (m: unknown) => posted.push(m),
  }));
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (t: string, f: (e: unknown) => void) => {
      on[t] = f;
    },
    skipWaiting: () => {},
    registration: {
      showNotification: async (
        title: string,
        options: Record<string, unknown>,
      ) => void shown.push({ title, options }),
    },
    clients: {
      claim: async () => {},
      matchAll: async () => wins,
      openWindow: async (u: string) => void opened.push(u),
    },
  };
  new Function("self", SRC)(self);
  const run = async (type: string, e: object) => {
    let p: Promise<unknown> = Promise.resolve();
    on[type]?.({ ...e, waitUntil: (x: Promise<unknown>) => (p = x) });
    await p;
  };
  return { run, shown, opened, posted, wins };
}
const push = (payload: unknown) => ({
  data: { json: () => payload },
});
const click = (href: unknown) => ({
  notification: { close: vi.fn(), data: { href } },
});

describe("sw.js", () => {
  it("shows the server's text, its link, and no buttons", async () => {
    const w = worker();
    await w.run(
      "push",
      push({
        v: 1,
        title: "OA Manager is waiting for your answer",
        body: "Ship the landing with the waitlist?",
        href: "/a/Cd5fGhJkLm6nPqRs?comment=c1",
        tag: "ask:c1",
      }),
    );
    expect(w.shown).toHaveLength(1);
    const n = w.shown[0];
    expect(n?.title).toBe("OA Manager is waiting for your answer");
    expect(n?.options.body).toBe("Ship the landing with the waitlist?");
    expect(n?.options.data).toEqual({
      href: "/a/Cd5fGhJkLm6nPqRs?comment=c1",
    });
    expect(n?.options).not.toHaveProperty("actions");
  });

  it("an unreadable push still shows the lock-screen line, linking home", async () => {
    const w = worker();
    await w.run("push", {
      data: {
        json: () => {
          throw new Error("x");
        },
      },
    });
    expect(w.shown[0]?.title).toBe("An agent is waiting for your answer");
    expect(w.shown[0]?.options.data).toEqual({ href: "/" });
  });

  it("a link off this origin is never kept", async () => {
    for (const href of [
      "https://evil.example/a",
      "//evil.example/a",
      "/\\evil.example",
      "javascript:alert(1)",
      "/a\nb",
    ]) {
      const w = worker();
      await w.run("push", push({ v: 1, title: "t", body: "", href, tag: "x" }));
      expect(w.shown[0]?.options.data).toEqual({ href: "/" });
    }
  });

  it("a click opens the item's path, in an open window if there is one", async () => {
    const none = worker();
    await none.run("notificationclick", click("/a/X1?comment=c1"));
    expect(none.opened).toEqual(["/a/X1?comment=c1"]);
    const open = worker([{ url: `${ORIGIN}/library` }]);
    await open.run("notificationclick", click("/a/X1"));
    expect(open.opened).toEqual([]);
    expect(open.wins[0]?.focus).toHaveBeenCalled();
    expect(open.posted).toEqual([{ oa: "notification-open", href: "/a/X1" }]);
  });

  it("a click on a foreign link opens home instead", async () => {
    const w = worker();
    await w.run("notificationclick", click("https://evil.example/"));
    expect(w.opened).toEqual(["/"]);
  });
});
