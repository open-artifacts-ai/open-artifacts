// Two submits in one tick (a fast double Enter or click) must send one request:
// `isPending` only turns true on a later render, so a guard on it alone lets
// both through. Each case fires both inside one act(), with no timers.
import { type Me, R, viewerPath } from "@oa/shared";
import { fixtures } from "@oa/shared/mocks";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it, vi } from "vitest";
import { installHarness, mount, server } from "./harness";

vi.mock("../src/viewer/bridge", () => ({
  createBridge: () => ({
    dispose: vi.fn(),
    requestThumbnail: vi.fn(),
    setTheme: vi.fn(),
    setArtifact: vi.fn(),
  }),
}));

installHarness();

/** Counts requests by "METHOD /path". */
const track = () => {
  const out: string[] = [];
  server.events.on("request:start", ({ request }) => {
    out.push(`${request.method} ${new URL(request.url).pathname}`);
  });
  return (key: string) => out.filter((k) => k === key).length;
};
const twice = (fn: () => void) =>
  act(() => {
    fn();
    fn();
  });
const OWNED = (
  fixtures.artifacts.find((a) => a.title === "Landing page") as { id: string }
).id;
const needsName = (over: Partial<Me> = {}): Me => ({
  ...fixtures.me,
  displayName: null,
  suggestedName: "Ada Lovelace",
  needsDisplayName: true,
  ...over,
});
const serveMe = (me: Me) =>
  server.use(http.get(`*${R.me}`, () => HttpResponse.json(me)));

describe("one request per submit", () => {
  it("display-name dialog", async () => {
    serveMe(needsName());
    const count = track();
    mount("/");
    const field = (await screen.findByLabelText("Your name")) as HTMLElement;
    fireEvent.change(field, { target: { value: "Ada L." } });
    const form = field.closest("form") as HTMLFormElement;
    twice(() => fireEvent.submit(form));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(count(`PATCH ${R.me}`)).toBe(1);
  });

  it("Settings → Profile save", async () => {
    serveMe(needsName({ needsDisplayName: false }));
    const count = track();
    mount("/settings/profile");
    const field = await screen.findByLabelText("Display name");
    fireEvent.change(field, { target: { value: "Ada L." } });
    const form = field.closest("form") as HTMLFormElement;
    twice(() => fireEvent.submit(form));
    await screen.findByText("Display name saved");
    expect(count(`PATCH ${R.me}`)).toBe(1);
  });

  it("Details save", async () => {
    const count = track();
    mount(`${viewerPath(OWNED)}?panel=open&tab=details`);
    const title = await screen.findByRole("textbox", { name: "Title" });
    fireEvent.change(title, { target: { value: "Renamed once" } });
    const form = title.closest("form") as HTMLFormElement;
    twice(() => fireEvent.submit(form));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save" })).toBeDisabled(),
    );
    expect(count(`PATCH ${R.artifact(OWNED)}`)).toBe(1);
  });

  it("Details delete", async () => {
    const count = track();
    const router = mount(`${viewerPath(OWNED)}?panel=open&tab=details`);
    fireEvent.click(
      await screen.findByRole("button", { name: "Delete artifact" }),
    );
    const confirm = within(await screen.findByRole("alertdialog")).getByRole(
      "button",
      { name: "Delete" },
    );
    twice(() => fireEvent.click(confirm));
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(count(`DELETE ${R.artifact(OWNED)}`)).toBe(1);
  });

  it("Versions restore", async () => {
    const count = track();
    // Restore sits on the viewed row.
    const router = mount(`${viewerPath(OWNED, 1)}?panel=open&tab=versions`);
    await screen.findByText("Initial version");
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    const confirm = await screen.findByRole("button", {
      name: "Restore version",
    });
    twice(() => fireEvent.click(confirm));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(viewerPath(OWNED, 3)),
    );
    expect(count(`POST ${R.restoreVersion(OWNED, 1)}`)).toBe(1);
  });
});
