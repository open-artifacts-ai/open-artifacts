// Live version updates through the real router, Shell and bridge, with the
// R.events mock: swap when provably safe, otherwise the chip; restore; gone;
// a hello that is ahead of the shown version; embeds never show names.
import { R, viewerPath } from "@oa/shared";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setEmbedForTests } from "../src/embed";
import { fullPath } from "../src/viewer/paths";
import { arts, events, installHarness, mount, seen, server } from "./harness";

installHarness();
afterEach(() => setEmbedForTests(false));

const idOf = (t: string) =>
  (arts.find((a) => a.title === t) as { id: string }).id;
const OWNED = idOf("Landing page"); // v2 current
const SCRIPT = idOf("Parser script");
const POLL = idOf("Team poll"); // public

const frames = () => [...document.querySelectorAll("iframe")];
/** The frame with a src that isn't `not`. */
const frame = (not?: HTMLIFrameElement) =>
  waitFor(
    () => {
      const f = frames().find((x) => x.src && x !== not);
      if (!f) throw new Error("no loaded iframe");
      return f;
    },
    { timeout: 3_000 },
  );
const nonceOf = (f: HTMLIFrameElement) => /#oa=([\w-]{22})$/.exec(f.src)?.[1];
/** The frame's runtime posts `type` with its nonce. */
const post = (f: HTMLIFrameElement, type: "hello" | "interacted") => {
  const w = f.contentWindow as Window;
  vi.spyOn(w, "postMessage")
    .mockImplementation(() => {})
    .mockClear();
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data:
          type === "hello"
            ? { oa: 1, type, protocol: 1, kind: "html", nonce: nonceOf(f) }
            : { oa: 1, type, nonce: nonceOf(f) },
        origin: "null",
        source: w,
      }),
    );
  });
  return w.postMessage as unknown as ReturnType<typeof vi.fn>;
};
/** Mounted, loaded, said hello, and the events socket is open. */
const open = async (path: string, id = OWNED, sayHello = true) => {
  mount(path);
  const f = await frame();
  fireEvent.load(f);
  if (sayHello) post(f, "hello");
  await waitFor(() => expect(events.connections(id)).toBe(1));
  return f;
};
const api = (method: string, path: string, body?: unknown) =>
  act(() =>
    fetch(path, {
      method,
      headers: {
        "X-OA-Request": "1",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }).then((r) => {
      if (!r.ok) throw new Error(`${method} ${path}: ${r.status}`);
    }),
  );
const publish = (id = OWNED) =>
  api("POST", R.versions(id), { id, format: "html", content: "<p>next</p>" });
const LONG = { timeout: 3_000 };

describe("live versions: the safe swap", () => {
  it("untouched, following Current: preloads, swaps, says so quietly", async () => {
    const first = await open(viewerPath(OWNED));
    await publish();
    // The new version loads in a second, hidden frame first.
    const next = await frame(first);
    expect(next.closest("[data-preload]")?.getAttribute("data-preload")).toBe(
      "true",
    );
    expect(nonceOf(next)).not.toBe(nonceOf(first));
    fireEvent.load(next);
    expect(await screen.findByText("Updated to v3")).toBeTruthy();
    // Design (option C): a brief note, no Undo.
    expect(screen.queryByRole("button", { name: /^Undo/ })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Version: v3 · Current" }),
    ).toBeTruthy();
    // About 3 s, then the chip is back to normal.
    await waitFor(
      () => expect(screen.queryByText("Updated to v3")).toBeNull(),
      { timeout: 5_000 },
    );
    await waitFor(() => expect(frames()).toEqual([next]));
    await waitFor(() =>
      expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe(
        "Updated to version 3.",
      ),
    );
  });

  it("touched (runtime interacted): the chip, and the frame never reloads", async () => {
    const first = await open(viewerPath(OWNED));
    post(first, "interacted");
    await publish();
    const view = await screen.findByRole(
      "button",
      { name: "View version 3" },
      LONG,
    );
    expect(screen.getByText("v3 available")).toBeTruthy();
    expect(frames()).toEqual([first]);
    expect(screen.getAllByTestId("versions-dot").length).toBeGreaterThan(0);
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe(
      "Version 3 is available. View is in the title bar.",
    );
    fireEvent.click(view);
    const next = await frame(first);
    fireEvent.load(next);
    await waitFor(() => expect(frames()).toEqual([next]));
    expect(screen.queryByRole("button", { name: /View version/ })).toBeNull();
    expect(screen.queryByTestId("versions-dot")).toBeNull();
  });

  it("an interacted message without the nonce is ignored (still swaps)", async () => {
    const first = await open(viewerPath(OWNED));
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { oa: 1, type: "interacted", nonce: "x".repeat(22) },
          origin: "null",
          source: first.contentWindow,
        }),
      );
    });
    await publish();
    const next = await frame(first);
    fireEvent.load(next);
    expect(await screen.findByText("Updated to v3")).toBeTruthy();
  });

  it("no hello (no runtime): the chip", async () => {
    await open(viewerPath(OWNED), OWNED, false);
    await publish();
    expect(
      await screen.findByRole("button", { name: "View version 3" }, LONG),
    ).toBeTruthy();
  });

  it("the swapped-in frame scrolls to where the old one was", async () => {
    const first = await open(viewerPath(OWNED));
    // The shown frame reports its scroll position; scrolling isn't touching.
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            oa: 1,
            type: "scroll",
            top: 600,
            max: 2000,
            nonce: nonceOf(first),
          },
          origin: "null",
          source: first.contentWindow,
        }),
      );
    });
    await publish();
    const next = await frame(first);
    fireEvent.load(next);
    const sent = post(next, "hello");
    await waitFor(() =>
      expect(sent).toHaveBeenCalledWith(
        { oa: 1, type: "scroll.to", top: 600, max: 2000 },
        "*",
      ),
    );
    expect(await screen.findByText("Updated to v3")).toBeTruthy();
  });

  it("text selected or a field focused in the frame: the chip", async () => {
    const first = await open(viewerPath(OWNED));
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            oa: 1,
            type: "engaged",
            engaged: true,
            nonce: nonceOf(first),
          },
          origin: "null",
          source: first.contentWindow,
        }),
      );
    });
    await publish();
    expect(
      await screen.findByRole("button", { name: "View version 3" }, LONG),
    ).toBeTruthy();
    expect(frames()).toEqual([first]);
  });

  it("a first load never gets scroll.to, even after another artifact scrolled and swapped", async () => {
    const first = await open(viewerPath(OWNED));
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            oa: 1,
            type: "scroll",
            top: 1900,
            max: 2000,
            nonce: nonceOf(first),
          },
          origin: "null",
          source: first.contentWindow,
        }),
      );
    });
    await publish();
    const next = await frame(first);
    fireEvent.load(next);
    post(next, "hello");
    expect(await screen.findByText("Updated to v3")).toBeTruthy();
    // Another artifact, first load: its frame says hello and gets no scroll.to.
    const router = mount(viewerPath(SCRIPT));
    void router;
    const other = await frame(next);
    fireEvent.load(other);
    const sent = post(other, "hello");
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(
      sent.mock.calls.filter(
        (c) => (c[0] as { type: string }).type === "scroll.to",
      ),
    ).toEqual([]);
  });

  it("an open side panel doesn't block it: swaps", async () => {
    const first = await open(`${viewerPath(OWNED)}?panel=open&tab=versions`);
    await publish();
    const next = await frame(first);
    fireEvent.load(next);
    expect(await screen.findByText("Updated to v3")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /View version/ })).toBeNull();
  });

  it("focus inside the frame (window blur): touched", async () => {
    const first = await open(viewerPath(OWNED));
    first.focus();
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    await act(() => new Promise((r) => setTimeout(r, 10)));
    await publish();
    expect(
      await screen.findByRole("button", { name: "View version 3" }, LONG),
    ).toBeTruthy();
  });

  it("an explicit version never swaps or chips: Current is vN", async () => {
    const first = await open(viewerPath(OWNED, 1));
    expect(screen.getByRole("button", { name: "Current is v2" })).toBeTruthy();
    await publish();
    expect(
      await screen.findByRole("button", { name: "Current is v3" }, LONG),
    ).toBeTruthy();
    await act(() => new Promise((r) => setTimeout(r, 1_200)));
    expect(screen.queryByRole("button", { name: /View version/ })).toBeNull();
    expect(frames()).toEqual([first]);
  });

  it("a hello ahead of the shown version catches up (missed while away)", async () => {
    // The store is at v3, but the artifact read still says v2 (stale).
    const stale = { ...(arts.find((a) => a.id === OWNED) as object) };
    await publish();
    server.use(
      http.get(`*${R.artifact(OWNED)}`, () =>
        HttpResponse.json({ ...stale, currentVersion: 2 }),
      ),
    );
    const first = await open(viewerPath(OWNED));
    post(first, "interacted");
    expect(
      await screen.findByRole("button", { name: "View version 3" }, LONG),
    ).toBeTruthy();
  });
});

describe("live versions: restore", () => {
  it("held: vN restored as vM · View", async () => {
    const first = await open(viewerPath(OWNED));
    post(first, "interacted");
    await api("POST", R.restoreVersion(OWNED, 1));
    expect(
      await screen.findByRole("button", { name: "View version 3" }, LONG),
    ).toBeTruthy();
    expect(screen.getByText("v1 restored as v3")).toBeTruthy();
  });

  it("swapped: announced as Restored vN as vM; the picker reads vM · Current", async () => {
    const first = await open(viewerPath(OWNED));
    await api("POST", R.restoreVersion(OWNED, 1));
    const next = await frame(first);
    fireEvent.load(next);
    // Design: the note says "Restored v1" (no Undo); the announcement says more.
    const pill = await screen.findAllByText("Restored v1");
    expect(pill[0]?.closest(".oa-lchip")?.textContent).not.toContain("Undo");
    expect(screen.queryByText("Updated", { exact: true })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Version: v3 · Current" }),
    ).toBeTruthy();
    await waitFor(() =>
      expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe(
        "Restored v1 as v3.",
      ),
    );
  });
});

const GUIDE = idOf("Onboarding guide"); // team, viewer access
const NEUTRAL = "This artifact is no longer available to you.";
/** The banner's copy, not the announcer's. */
const BANNER = { selector: ".oa-lgone span" };
/** No call for `id` after `from` (artifact, versions, content URL, data). */
const callsFor = (id: string, from: number) =>
  seen.slice(from).filter((u) => u.pathname.includes(`/artifacts/${id}`));

describe("live versions: gone", () => {
  it("deleted, the owner: You deleted this artifact, frame kept, nothing fetched", async () => {
    const first = await open(viewerPath(OWNED));
    await api("DELETE", R.artifact(OWNED));
    expect(
      await screen.findByText("You deleted this artifact.", BANNER),
    ).toBeTruthy();
    const after = seen.length;
    expect(frames()).toEqual([first]);
    expect(screen.queryByText("Page not found")).toBeNull();
    expect(screen.getByRole("button", { name: "Restore" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Share" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByRole("button", { name: /^Version: v/ })).toHaveProperty(
      "disabled",
      true,
    );
    expect(events.connections(OWNED)).toBe(0);
    // The bridge is gone: no welcome, and a data call goes nowhere.
    const replies = post(first, "hello");
    expect(replies).not.toHaveBeenCalled();
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            oa: 1,
            type: "call",
            id: "c1",
            method: "storage.get",
            params: { key: "k" },
            nonce: nonceOf(first),
          },
          origin: "null",
          source: first.contentWindow,
        }),
      );
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await act(() => new Promise((r) => setTimeout(r, 200)));
    expect(callsFor(OWNED, after)).toEqual([]);
    expect(frames()).toEqual([first]);
  });

  it("deleted, the owner: Restore brings it back live", async () => {
    const first = await open(viewerPath(OWNED));
    const before = nonceOf(first);
    await api("DELETE", R.artifact(OWNED));
    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
    await waitFor(() =>
      expect(
        screen.queryByText("You deleted this artifact.", BANNER),
      ).toBeNull(),
    );
    await waitFor(() => expect(events.connections(OWNED)).toBe(1));
    // A fresh load of the frame, with a fresh nonce.
    await waitFor(() =>
      expect(nonceOf(frames()[0] as HTMLIFrameElement)).not.toBe(before),
    );
  });

  it("deleted, not the owner: the neutral copy, no Restore", async () => {
    await open(viewerPath(GUIDE), GUIDE);
    act(() => {
      events.emitGone(GUIDE, "deleted");
    });
    expect(await screen.findByText(NEUTRAL, BANNER)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Restore" })).toBeNull();
    expect(screen.queryByText("You deleted this artifact.", BANNER)).toBeNull();
  });

  it("changed, then 404: the neutral copy", async () => {
    await open(viewerPath(GUIDE), GUIDE);
    server.use(
      http.get(`*${R.artifact(GUIDE)}`, () =>
        HttpResponse.json(
          { error: { code: "not_found", message: "Not found" } },
          { status: 404 },
        ),
      ),
    );
    act(() => {
      events.emitGone(GUIDE, "changed");
    });
    expect(await screen.findByText(NEUTRAL, BANNER)).toBeTruthy();
    expect(frames()).toHaveLength(1);
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(events.connections(GUIDE)).toBe(0);
  });

  it("changed, then hello: carries on, no notice, the data bridge stays", async () => {
    const first = await open(viewerPath(OWNED));
    // A capability change: the mock emits gone "changed".
    await api("PATCH", R.artifact(OWNED), { capabilities: { db: true } });
    await waitFor(() => expect(events.connections(OWNED)).toBe(1));
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(screen.queryByText(NEUTRAL, BANNER)).toBeNull();
    expect(screen.queryByText("You deleted this artifact.", BANNER)).toBeNull();
    // Still the same frame, and its bridge still answers.
    expect(frames()).toEqual([first]);
    expect(post(first, "hello")).toHaveBeenCalled();
  });

  it("/full: No longer available · Exit", async () => {
    const first = await open(fullPath(OWNED));
    await api("DELETE", R.artifact(OWNED));
    expect(
      await screen.findByRole("link", { name: "No longer available · Exit" }),
    ).toBeTruthy();
    expect(frames()).toEqual([first]);
  });
});

describe("live versions: embed", () => {
  it("collapsed pill opens /a/<id> in a new tab; never a name", async () => {
    setEmbedForTests(true);
    const first = await open(fullPath(POLL), POLL);
    post(first, "interacted");
    act(() => {
      events.emitVersion(POLL, {
        version: 2,
        by: { kind: "agent", name: "Secret Agent" },
      });
    });
    const pill = await screen.findByRole(
      "link",
      { name: "Version 2 available, open Team poll in a new tab" },
      LONG,
    );
    expect(pill.getAttribute("data-open")).toBe("false");
    expect(pill.getAttribute("target")).toBe("_blank");
    expect(pill.getAttribute("rel")).toBe("noopener");
    expect(pill.getAttribute("href")).toBe(
      `${location.origin}${viewerPath(POLL)}`,
    );
    expect(document.body.textContent).not.toContain("Secret Agent");
  });
});

describe("live versions: the socket", () => {
  it("never sends a frame", async () => {
    const send = vi.spyOn(WebSocket.prototype, "send");
    const first = await open(viewerPath(OWNED));
    post(first, "interacted");
    await publish();
    await screen.findByRole("button", { name: "View version 3" }, LONG);
    expect(send).not.toHaveBeenCalled();
  });
});
