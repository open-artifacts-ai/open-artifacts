// The viewer shell with the real bridge: every intentional load (first load,
// Reload, a version switch) gets a fresh nonce and a bridge that keeps answering.
import { viewerPath } from "@oa/shared";
import { fixtures } from "@oa/shared/mocks";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ANNOUNCE_HEAL_MS, MINT_RETRY_MS } from "../src/viewer/Shell";
import { installHarness, mount, server } from "./harness";

installHarness();
afterEach(() => vi.useRealTimers());

const OWNED = (
  fixtures.artifacts.find((a) => a.title === "Landing page") as { id: string }
).id;

const frame = () =>
  waitFor(() => {
    const f = document.querySelector("iframe");
    if (!f?.src) throw new Error("no loaded iframe");
    return f;
  });
const nonceOf = (f: HTMLIFrameElement) => /#oa=([\w-]{22})$/.exec(f.src)?.[1];
/** The frame's runtime posts hello; returns the shell's replies to it. */
const hello = (f: HTMLIFrameElement, nonce: string | undefined) => {
  const w = f.contentWindow as Window;
  const spy = vi.spyOn(w, "postMessage").mockImplementation(() => {});
  const ev = new MessageEvent("message", {
    data: { oa: 1, type: "hello", protocol: 1, kind: "html", nonce },
    origin: "null",
    source: w,
  });
  act(() => {
    window.dispatchEvent(ev);
  });
  const types = spy.mock.calls.map((c) => (c[0] as { type: string }).type);
  spy.mockRestore();
  return types;
};
/** The frame's load event for the shell's own src assignment. */
const loaded = (f: HTMLIFrameElement) => fireEvent.load(f);

const reloaded = (old: HTMLIFrameElement) =>
  waitFor(() => {
    const f = document.querySelector("iframe");
    if (!f || f === old || !f.src) throw new Error("not reloaded");
    return f;
  });

describe("viewer shell: per-load nonce", () => {
  it("Reload loads a fresh frame with a fresh nonce; its bridge answers after load", async () => {
    mount(viewerPath(OWNED));
    const first = await frame();
    const n1 = nonceOf(first);
    expect(n1).toBeDefined();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    loaded(first);
    // No hello: the slow notice offers Reload.
    await act(() => vi.advanceTimersByTimeAsync(8_000));
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    vi.useRealTimers();
    const second = await waitFor(() => {
      const f = document.querySelector("iframe");
      if (!f || f === first || !f.src) throw new Error("not reloaded");
      return f;
    });
    const n2 = nonceOf(second);
    expect(n2).toBeDefined();
    expect(n2).not.toBe(n1);
    loaded(second); // ours: must not dispose the bridge
    expect(hello(second, n1)).toEqual([]);
    expect(hello(second, n2)).toContain("welcome");
  });

  it("a version switch loads with a fresh nonce; its bridge answers after load", async () => {
    const router = mount(viewerPath(OWNED));
    const first = await frame();
    const n1 = nonceOf(first);
    loaded(first);
    expect(hello(first, n1)).toContain("welcome");
    await act(() => router.navigate({ to: viewerPath(OWNED, 1) as string }));
    const second = await waitFor(() => {
      const f = document.querySelector("iframe");
      if (!f || f === first || !f.src) throw new Error("not switched");
      return f;
    });
    const n2 = nonceOf(second);
    expect(n2).toBeDefined();
    expect(n2).not.toBe(n1);
    loaded(second);
    expect(hello(second, n1)).toEqual([]);
    expect(hello(second, n2)).toContain("welcome");
  });

  it("a load the shell didn't start (renavigation) leaves the frame without a bridge", async () => {
    mount(viewerPath(OWNED));
    const f = await frame();
    const n = nonceOf(f);
    loaded(f);
    loaded(f); // the artifact navigated its own frame
    expect(hello(f, n)).toEqual([]);
  });

  it("a renavigation while the signed URL is fresh keeps the frame (#2686)", async () => {
    mount(viewerPath(OWNED));
    const f = await frame();
    loaded(f);
    loaded(f); // the artifact navigated its own frame
    await new Promise((r) => setTimeout(r, 50));
    expect(document.querySelector("iframe")).toBe(f);
  });

  it("a renavigation after the frozen URL expired reloads with a newly fetched URL, even while the shell's own URL is fresh (#2686)", async () => {
    mount(viewerPath(OWNED));
    const first = await frame();
    const n1 = nonceOf(first);
    loaded(first);
    // The hook refetches before expiry: the shell's own URL is fresh again
    // while the one the frame holds (frozen at its first load) is long dead.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 700_000);
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await new Promise((r) => setTimeout(r, 100));
    loaded(first); // the frame asks for its expired URL on its own
    vi.useRealTimers();
    const second = await reloaded(first);
    expect(nonceOf(second)).not.toBe(n1);
    loaded(second); // Reload's own load is expected: no further reload
    await new Promise((r) => setTimeout(r, 50));
    expect(document.querySelector("iframe")).toBe(second);
    expect(hello(second, nonceOf(second))).toContain("welcome");
  });

  it("a restored frame's announce reloads even while the shell's own URL is fresh (#2959)", async () => {
    // The discard case (review of #2960): the shell loads from scratch and
    // holds a freshly minted URL, while Chrome restores the frame on the URL it
    // held before, so the announce arrives under a fresh shell URL. No clock
    // trick: this is a fresh mount within the URL's lifetime.
    mount(viewerPath(OWNED));
    const first = await frame();
    const n1 = nonceOf(first);
    loaded(first);
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { oa: 1, type: "expired" },
          origin: "null",
          source: first.contentWindow,
        }),
      );
    });
    const second = await reloaded(first);
    expect(nonceOf(second)).toBeDefined();
    expect(nonceOf(second)).not.toBe(n1);
    loaded(second);
    expect(hello(second, nonceOf(second))).toContain("welcome");
  });

  it("an expiry announce from another window reloads nothing (#2959)", async () => {
    mount(viewerPath(OWNED));
    const first = await frame();
    loaded(first);
    act(() => {
      // Not the artifact frame: another window cannot ask for a reload.
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { oa: 1, type: "expired" },
          origin: "null",
          source: window,
        }),
      );
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(document.querySelector("iframe")).toBe(first);
  });

  it("a second announce inside the bound is dropped, and one past it heals (#2959)", async () => {
    mount(viewerPath(OWNED));
    const first = await frame();
    loaded(first);
    const announce = (f: HTMLIFrameElement) =>
      act(() => {
        window.dispatchEvent(
          new MessageEvent("message", {
            data: { oa: 1, type: "expired" },
            origin: "null",
            source: f.contentWindow,
          }),
        );
      });
    announce(first);
    const second = await reloaded(first);
    // The load of the replacement frame ends the reload (#2686): the bound, not
    // a reload in flight, is what has to stop the next announce.
    loaded(second);
    announce(second);
    await new Promise((r) => setTimeout(r, 50));
    expect(document.querySelector("iframe")).toBe(second);
    // Past the bound it heals again (a tab restored twice in one session).
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + ANNOUNCE_HEAL_MS + 1_000);
    announce(second);
    vi.useRealTimers();
    const third = await reloaded(second);
    loaded(third);
    expect(hello(third, nonceOf(third))).toContain("welcome");
  });

  it("a burst of announces in one tick reloads the frame once (#2959)", async () => {
    mount(viewerPath(OWNED));
    const first = await frame();
    loaded(first);
    vi.useFakeTimers({ toFake: ["Date"] });
    const send = () =>
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { oa: 1, type: "expired" },
          origin: "null",
          source: first.contentWindow,
        }),
      );
    act(() => {
      send();
      send();
      send();
    });
    vi.useRealTimers();
    const second = await reloaded(first);
    loaded(second);
    // The burst was one heal: the replacement frame is the one we then hold,
    // and the shell did not start a second reload for it.
    await new Promise((r) => setTimeout(r, 50));
    expect(document.querySelector("iframe")).toBe(second);
  });

  it("a second renavigation after expiry, with the bridge already disposed, reloads too (#2686)", async () => {
    mount(viewerPath(OWNED));
    const first = await frame();
    loaded(first);
    loaded(first); // first renavigation, URL still fresh: bridge disposed, no reload
    await new Promise((r) => setTimeout(r, 50));
    expect(document.querySelector("iframe")).toBe(first);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 700_000);
    loaded(first);
    vi.useRealTimers();
    await reloaded(first);
  });

  it("a tab restored with no load event heals a frame that never said hello (#2959)", async () => {
    mount(viewerPath(OWNED));
    const first = await frame();
    const n1 = nonceOf(first);
    loaded(first); // no hello: the shell already suspects this frame
    // The URL ages out while the tab is away, and the restore gives the shell
    // neither a load it didn't start nor the expiry page's announce (a frame
    // restored from the back/forward cache runs no script again).
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 700_000);
    act(() => {
      window.dispatchEvent(
        new PageTransitionEvent("pageshow", { persisted: true }),
      );
    });
    await new Promise((r) => setTimeout(r, 100));
    vi.useRealTimers();
    const second = await reloaded(first);
    expect(nonceOf(second)).not.toBe(n1);
    loaded(second);
    expect(hello(second, nonceOf(second))).toContain("welcome");
  });

  it("a wake leaves a frame that said hello alone (#2959)", async () => {
    mount(viewerPath(OWNED));
    const first = await frame();
    loaded(first);
    expect(hello(first, nonceOf(first))).toContain("welcome");
    // Its document is alive: an old URL only matters for the next navigation.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 700_000);
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
    });
    await new Promise((r) => setTimeout(r, 100));
    vi.useRealTimers();
    expect(document.querySelector("iframe")).toBe(first);
  });

  it("a heal whose mint fails keeps the frame and retries instead of reloading the stale URL (#2959)", async () => {
    mount(viewerPath(OWNED));
    const first = await frame();
    loaded(first);
    // The mint fails once: reloading the frame now would put the expiry page
    // back (the URL it holds is stale by definition here).
    let failing = true;
    server.use(
      http.get("*/api/v1/artifacts/:id/content-url", () => {
        if (!failing) return undefined;
        failing = false;
        return HttpResponse.error();
      }),
    );
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { oa: 1, type: "expired" },
          origin: "null",
          source: first.contentWindow,
        }),
      );
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(document.querySelector("iframe")).toBe(first);
    // The retry (MINT_RETRY_MS later) mints again and replaces the frame.
    const second = await waitFor(
      () => {
        const f = document.querySelector("iframe");
        if (!f || f === first || !f.src) throw new Error("not reloaded");
        return f;
      },
      { timeout: MINT_RETRY_MS + 2_000 },
    );
    loaded(second);
    expect(hello(second, nonceOf(second))).toContain("welcome");
  });
});
