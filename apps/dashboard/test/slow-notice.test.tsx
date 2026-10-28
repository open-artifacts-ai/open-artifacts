import { type Me, R, viewerPath } from "@oa/shared";
import { fixtures } from "@oa/shared/mocks";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordCpuLimit } from "../src/api/client";
import { qk } from "../src/api/queries";
import { loadArtifactFrame } from "../src/viewer/frame";
import { installHarness, lastClient, mount, server } from "./harness";

type Opts = { onHello?: () => void; iframe: HTMLIFrameElement; url: string };
const createBridge = vi.fn((_: Opts) => ({
  dispose: vi.fn(),
  requestThumbnail: vi.fn(),
  setTheme: vi.fn(),
  setArtifact: vi.fn(),
}));
/** When set, the mock bridge doesn't load the frame (it stays at about:blank). */
const hold = { load: false };
// Like the real bridge, the mock loads the frame (Shell ignores earlier loads).
vi.mock("../src/viewer/bridge", async () => {
  const { loadArtifactFrame } = await import("../src/viewer/frame");
  return {
    createBridge: (o: Opts) => {
      if (!hold.load) loadArtifactFrame(o.iframe, o.url);
      return createBridge(o);
    },
  };
});

installHarness();
beforeEach(() => {
  createBridge.mockClear();
  hold.load = false;
});
afterEach(() => vi.useRealTimers());

const ID = (
  fixtures.artifacts.find((a) => a.title === "Landing page") as { id: string }
).id;
const GENERIC =
  "This artifact hasn't responded yet. If it looks wrong, reload it.";
const CPU =
  /This artifact may have hit your instance's CPU limit\. Reloading usually works\./;
const UPSELL = /Workers Paid raises the limit\./;

const frame = () =>
  waitFor(() => {
    const f = document.querySelector("iframe");
    if (!f) throw new Error("no iframe");
    return f;
  });
/** The frame loads; timers are fake from here on. */
const loaded = async () => {
  const f = await frame();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  fireEvent.load(f);
  return f;
};
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
const hello = () => act(() => createBridge.mock.calls.at(-1)?.[0].onHello?.());
const text = () =>
  document.querySelector(".oa-vnotice-text")?.textContent ?? null;
const usage = (hits: number, plan?: "free" | "paid") =>
  server.use(
    http.get(`*${R.usage}`, () =>
      HttpResponse.json({
        available: true,
        plan: plan ?? "free",
        date: new Date().toISOString().slice(0, 10),
        metrics: [{ key: "cpu_limit_hits", used: hits, limit: 0 }],
      }),
    ),
  );
/** The usage query has its answer (fake timers would stall msw's response). */
const usageLanded = () =>
  waitFor(() => expect(lastClient.getQueryData(qk.usage)).toBeDefined());
const asMember = () =>
  server.use(
    http.get(`*${R.me}`, () =>
      HttpResponse.json({
        ...fixtures.me,
        user: { ...fixtures.me.user, role: "member" },
      }),
    ),
  );
/** Click Reload, let the new frame load and stay silent for 8 s. */
const reloadAndWait = async () => {
  const before = document.querySelector("iframe");
  fireEvent.click(screen.getByRole("button", { name: "Reload" }));
  expect(text()).toBeNull();
  await advance(0);
  const f = document.querySelector("iframe") as HTMLIFrameElement;
  expect(f).not.toBe(before); // a fresh frame, not the old document
  fireEvent.load(f);
  await advance(8_000);
};

describe("viewer slow notice", () => {
  it("the frame's initial about:blank load (before loadArtifactFrame) arms nothing", async () => {
    hold.load = true;
    mount(viewerPath(ID));
    await waitFor(() => expect(createBridge).toHaveBeenCalled());
    const f = await loaded(); // about:blank: no loadArtifactFrame yet
    expect(f.getAttribute("src")).toBeNull();
    await advance(10_000);
    expect(text()).toBeNull();
    // The bridge's own load does arm it.
    const o = createBridge.mock.calls.at(-1)?.[0] as Opts;
    loadArtifactFrame(o.iframe, o.url);
    fireEvent.load(f);
    await advance(8_000);
    expect(text()).toBe(GENERIC);
  });

  it("appears 8 s after load without hello, above the frame, frame kept", async () => {
    usage(0);
    mount(viewerPath(ID));
    await loaded();
    await advance(7_999);
    expect(text()).toBeNull();
    await advance(1);
    expect(text()).toBe(GENERIC);
    // Non-blocking: the frame is still there, after the notice.
    const n = document.querySelector(".oa-vnotice") as HTMLElement;
    const f = document.querySelector("iframe") as HTMLIFrameElement;
    expect(
      n.compareDocumentPosition(f) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Learn more/ })).toBeNull();
  });

  it("never shows when hello arrives first", async () => {
    mount(viewerPath(ID));
    await frame();
    await hello();
    await loaded();
    await advance(10_000);
    expect(text()).toBeNull();
  });

  it("hello within the 8 s cancels it", async () => {
    mount(viewerPath(ID));
    await loaded();
    await advance(5_000);
    await hello();
    await advance(5_000);
    expect(text()).toBeNull();
  });

  it("a late hello hides it", async () => {
    mount(viewerPath(ID));
    await loaded();
    await advance(8_000);
    expect(text()).toBe(GENERIC);
    await hello();
    expect(text()).toBeNull();
  });

  it("Dismiss hides it", async () => {
    mount(viewerPath(ID));
    await loaded();
    await advance(8_000);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(text()).toBeNull();
  });

  it("stays dismissed when the frame loads again", async () => {
    mount(viewerPath(ID));
    const f = await loaded();
    await advance(8_000);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    // The artifact navigates its own frame: a new load, still no hello.
    fireEvent.load(f);
    await advance(10_000);
    expect(text()).toBeNull();
  });

  it("CPU variant after a recent cpu_limit error", async () => {
    recordCpuLimit();
    mount(viewerPath(ID));
    await loaded();
    await advance(8_000);
    expect(text()).toMatch(CPU);
    expect(text()).not.toMatch(UPSELL);
    expect(
      screen.getByRole("link", { name: /Learn more/ }).getAttribute("href"),
    ).toBe(
      "https://open-artifacts.com/docs/self-hosting-costs/#hitting-the-cpu-limit",
    );
  });

  it("CPU variant when usage shows hits today", async () => {
    usage(1);
    mount(viewerPath(ID));
    const f = await frame();
    // Let the owner's usage request land before faking timers.
    await usageLanded();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.load(f);
    await advance(8_000);
    expect(text()).toMatch(CPU);
  });

  it("after 2 reloads the CPU variant offers Workers Paid (owners and admins)", async () => {
    recordCpuLimit();
    mount(viewerPath(ID));
    await loaded();
    await advance(8_000);
    await reloadAndWait();
    expect(text()).toMatch(CPU);
    expect(text()).not.toMatch(UPSELL);
    await reloadAndWait();
    expect(text()).toMatch(UPSELL);
    expect(
      screen.getByRole("link", { name: /See plans/ }).getAttribute("href"),
    ).toBe("https://dash.cloudflare.com/?to=/:account/workers/plans");
  });

  it("members keep the base CPU copy: no upsell text, no plan link", async () => {
    asMember();
    recordCpuLimit();
    mount(viewerPath(ID));
    await loaded();
    await advance(8_000);
    await reloadAndWait();
    await reloadAndWait();
    expect(text()).toMatch(CPU);
    expect(text()).not.toMatch(UPSELL);
    expect(screen.queryByRole("link", { name: /See plans/ })).toBeNull();
  });

  it("a double click on Reload counts once", async () => {
    recordCpuLimit();
    mount(viewerPath(ID));
    await loaded();
    await advance(8_000);
    const b = screen.getByRole("button", { name: "Reload" });
    // Both clicks land before React re-renders, as a fast double click can.
    act(() => {
      b.click();
      b.click();
    });
    await advance(0);
    fireEvent.load(document.querySelector("iframe") as HTMLIFrameElement);
    await advance(8_000);
    expect(text()).toMatch(CPU);
    expect(text()).not.toMatch(UPSELL); // one reload so far, not two
    await reloadAndWait();
    expect(text()).toMatch(UPSELL);
  });

  it("the generic variant never mentions plans, however many reloads", async () => {
    mount(viewerPath(ID));
    await loaded();
    await advance(8_000);
    await reloadAndWait();
    await reloadAndWait();
    expect(text()).toBe(GENERIC);
  });

  it("Workers Paid: the 30-second line, no Learn more, no upsell after reloads (#279)", async () => {
    // The plan comes from Me.
    server.use(
      http.get(`*${R.me}`, () =>
        HttpResponse.json({
          ...fixtures.me,
          instance: { ...fixtures.me.instance, plan: "paid" },
        }),
      ),
    );
    usage(1, "paid");
    mount(viewerPath(ID));
    const f = await frame();
    await usageLanded();
    await waitFor(() =>
      expect(lastClient.getQueryData<Me>(qk.me)?.instance.plan).toBe("paid"),
    );
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.load(f);
    await advance(8_000);
    expect(text()).toBe(
      "This request hit Cloudflare's 30-second CPU limit. Try again.",
    );
    expect(screen.queryByRole("link", { name: /Learn more/ })).toBeNull();
    await reloadAndWait();
    await reloadAndWait();
    expect(text()).not.toMatch(UPSELL);
    expect(screen.queryByRole("link", { name: /See plans/ })).toBeNull();
  });

  it("explicit Free keeps the Free CPU copy", async () => {
    usage(1, "free");
    mount(viewerPath(ID));
    const f = await frame();
    await usageLanded();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.load(f);
    await advance(8_000);
    expect(text()).toMatch(CPU);
  });
});
