import { viewerPath } from "@oa/shared";
import { fixtures } from "@oa/shared/mocks";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installHarness, mount, mountHosted, server, wait } from "./harness";

vi.mock("../src/viewer/bridge", () => ({
  createBridge: () => ({
    dispose: vi.fn(),
    requestThumbnail: vi.fn(),
    setTheme: vi.fn(),
    setArtifact: vi.fn(),
  }),
}));

installHarness();

const PUBLIC = (
  fixtures.artifacts.find((a) => a.title === "Q4 report") as { id: string }
).id;
const COPY = "Shared with you on Open Artifacts. Publish your own, free.";
const frame = () =>
  waitFor(() => {
    if (!document.querySelector("iframe")) throw new Error("no iframe");
  });
const anonymous = (hosted: boolean) =>
  server.use(
    http.get("*/api/v1/me", () =>
      HttpResponse.json(
        { error: { code: "unauthorized", message: "no" } },
        { status: 401 },
      ),
    ),
    http.get("*/auth/providers", () =>
      HttpResponse.json({
        mode: "direct",
        providers: [],
        hosted,
      }),
    ),
  );
const nudge = () => screen.queryByText(COPY);

describe("sign-up nudge in the viewer (#1564)", () => {
  beforeEach(() => localStorage.clear());

  it("a signed-out viewer of a public link on a hosted install sees it", async () => {
    anonymous(true);
    mount(viewerPath(PUBLIC));
    expect(await screen.findByText(COPY)).toBeVisible();
    expect(screen.getByRole("link", { name: "Get started" })).toHaveAttribute(
      "href",
      "https://open-artifacts.com",
    );
  });

  it("a signed-out viewer on a self-hosted install does not", async () => {
    anonymous(false);
    mount(viewerPath(PUBLIC));
    await frame();
    await wait(50);
    expect(nudge()).toBeNull();
  });

  it("a guest on a hosted install sees it", async () => {
    mountHosted(viewerPath(PUBLIC), true, (m) => ({
      ...m,
      user: { ...m.user, role: "guest" },
    }));
    expect(await screen.findByText(COPY)).toBeVisible();
  });

  it("a member on a hosted install does not", async () => {
    mountHosted(viewerPath(PUBLIC));
    await frame();
    await wait(50);
    expect(nudge()).toBeNull();
  });

  it("dismissing hides it, and it stays hidden after a reload", async () => {
    anonymous(true);
    const first = mount(viewerPath(PUBLIC));
    await screen.findByText(COPY);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(nudge()).toBeNull();
    first.history.destroy();
    document.body.innerHTML = "";
    mount(viewerPath(PUBLIC));
    await frame();
    await wait(50);
    expect(nudge()).toBeNull();
  });

  it("blocked storage still renders it, and dismissing hides it for the session", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    anonymous(true);
    mount(viewerPath(PUBLIC));
    await screen.findByText(COPY);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(nudge()).toBeNull();
    vi.restoreAllMocks();
  });
});
