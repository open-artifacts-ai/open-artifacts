// The renavigation notice (#306): the artifact frame left the page the shell
// loaded, so live data is off until Reload. Only for artifacts with a capability.
import { viewerPath } from "@oa/shared";
import { fixtures } from "@oa/shared/mocks";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { installClock, settle } from "./clock";
import { installHarness, mount } from "./harness";

installHarness();

const idOf = (title: string) =>
  (fixtures.artifacts.find((a) => a.title === title) as { id: string }).id;
const LIVE = idOf("Team poll"); // capabilities.db
const PLAIN = idOf("Landing page"); // no capability
const COPY =
  "Live data is off on this page because it opened from a link inside the artifact. Reload to go back to the first page and reconnect.";

const frame = (not?: HTMLIFrameElement) =>
  waitFor(() => {
    const f = document.querySelector("iframe");
    if (!f?.src || f === not) throw new Error("no loaded iframe");
    return f;
  });
const notice = () => screen.queryByText(COPY);
/** The shell's own load, then `n` loads it didn't start. */
const navigate = (f: HTMLIFrameElement, n = 1) => {
  for (let i = 0; i < n; i++) fireEvent.load(f);
};

// A clock, not the wall (test/clock.ts).
installClock();

describe("renavigation notice", () => {
  it("shows for an artifact with a capability, as a polite status", async () => {
    mount(viewerPath(LIVE));
    const f = await frame();
    fireEvent.load(f); // ours
    expect(notice()).toBeNull();
    navigate(f);
    const n = await screen.findByText(COPY);
    expect(n.closest('[role="status"]')).not.toBeNull();
    expect(screen.queryByText(/hasn't responded yet/)).toBeNull();
  });

  it("never shows for an artifact without one", async () => {
    mount(viewerPath(PLAIN));
    const f = await frame();
    fireEvent.load(f);
    navigate(f, 2);
    await settle(50);
    expect(notice()).toBeNull();
  });

  it("stays hidden after Dismiss until the next navigation", async () => {
    mount(viewerPath(LIVE));
    const f = await frame();
    fireEvent.load(f);
    navigate(f);
    await screen.findByText(COPY);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(notice()).toBeNull();
    navigate(f);
    expect(await screen.findByText(COPY)).toBeTruthy();
  });

  it("Reload loads the entry page with a fresh nonce and clears it", async () => {
    mount(viewerPath(LIVE));
    const first = await frame();
    const src = first.src;
    fireEvent.load(first);
    navigate(first);
    await screen.findByText(COPY);
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    const second = await frame(first);
    expect(notice()).toBeNull();
    const [base, nonce] = second.src.split("#oa=");
    expect(base).toBe(src.split("#oa=")[0]);
    expect(nonce).toMatch(/^[\w-]{22}$/);
    expect(nonce).not.toBe(src.split("#oa=")[1]);
    fireEvent.load(second); // ours: no notice
    await settle(50);
    expect(notice()).toBeNull();
    navigate(second);
    expect(await screen.findByText(COPY)).toBeTruthy();
  });
});
