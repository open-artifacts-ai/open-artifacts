// The viewer shell with the real bridge: every intentional load (first load,
// Reload, a version switch) gets a fresh nonce and a bridge that keeps answering.
import { viewerPath } from "@oa/shared";
import { fixtures } from "@oa/shared/mocks";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installHarness, mount } from "./harness";

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
});
