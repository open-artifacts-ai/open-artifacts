// #2590 (Design): what a signed-in guest doesn't get on a shared page: Share,
// agent mentions and their hint, Decisions and Resolve. A member keeps them.
import { fixtures } from "@oa/shared/mocks";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installHarness, mount, server } from "./harness";
import { FIRST_LOAD_MS } from "./timeouts";

type Opts = { iframe: HTMLIFrameElement; url: string; onHello: () => void };
const opts: Opts[] = [];
// Like the real bridge, the mock loads the frame (Shell ignores earlier loads).
vi.mock("../src/viewer/bridge", async () => {
  const { loadArtifactFrame } = await import("../src/viewer/frame");
  return {
    createBridge: (o: Opts) => {
      loadArtifactFrame(o.iframe, o.url);
      opts.push(o);
      return {
        dispose: () => {},
        requestThumbnail: () => {},
        setTheme: () => {},
        setArtifact: () => {},
        scrollTo: () => {},
        setCommentsMode: () => {},
        setComments: () => {},
        focusComment: () => {},
        commentOnSelection: () => {},
        clearSelection: () => {},
      };
    },
  };
});

installHarness();

const LANDING = "Cd5fGhJkLm6nPqRs"; // seeded with comments

beforeEach(() => {
  opts.length = 0;
  vi.spyOn(window, "matchMedia").mockImplementation(
    (q: string) =>
      ({
        matches: q === "(min-width: 960px)",
        media: q,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
});
afterEach(() => vi.restoreAllMocks());

const asGuest = () =>
  server.use(
    http.get("*/api/v1/me", () =>
      HttpResponse.json({
        ...fixtures.me,
        user: { ...fixtures.me.user, role: "guest" },
      }),
    ),
  );

/** The comments column, opened. */
const column = async () => {
  const b = await screen.findByRole(
    "button",
    { name: /^Comments/ },
    { timeout: FIRST_LOAD_MS },
  );
  if (!screen.queryByRole("complementary", { name: "Comments" }))
    fireEvent.click(b);
  const c = await screen.findByRole(
    "complementary",
    { name: "Comments" },
    { timeout: FIRST_LOAD_MS },
  );
  await within(c).findByText("Can we tighten this headline?", undefined, {
    timeout: FIRST_LOAD_MS,
  });
  return c;
};

describe("a guest on a shared page (#2590)", () => {
  it("has no Share button", async () => {
    asGuest();
    mount(`/a/${LANDING}`);
    await column();
    expect(screen.queryByRole("button", { name: "Share" })).toBeNull();
  });

  it("can't mention agents: no @ hint, no menu, no owners-only note", async () => {
    asGuest();
    mount(`/a/${LANDING}`);
    const c = await column();
    const box = within(c).getByRole("textbox", {
      name: "Comment on the whole page",
    });
    expect(box).toHaveAttribute("placeholder", "Comment on the whole page");
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: "@" } });
    expect(within(c).queryByRole("listbox")).toBeNull();
    expect(
      within(c).queryByText("Only the owner and editors can wake agents."),
    ).toBeNull();
  });

  it("gets no Decisions and no Resolve", async () => {
    asGuest();
    mount(`/a/${LANDING}`);
    const c = await column();
    expect(within(c).queryByRole("tab", { name: /Decisions/ })).toBeNull();
    expect(within(c).queryByRole("button", { name: "Resolve" })).toBeNull();
  });
});

describe("a member keeps them", () => {
  it("Share, the @ hint, Decisions and Resolve", async () => {
    mount(`/a/${LANDING}`);
    const c = await column();
    expect(screen.getByRole("button", { name: "Share" })).toBeInTheDocument();
    expect(
      within(c).getByRole("textbox", { name: "Comment on the whole page" }),
    ).toHaveAttribute(
      "placeholder",
      "Add a comment. Type @ to mention an agent or a person.",
    );
    expect(
      within(c).getByRole("tab", { name: /Decisions/ }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        within(c).getAllByRole("button", { name: "Resolve" }).length,
      ).toBeGreaterThan(0),
    );
  });
});
