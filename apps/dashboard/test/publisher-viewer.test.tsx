// #2610 part 1, the agreed contract (item 2): guests and signed-out viewers
// get no agent anywhere (no lastAgent, and agent: null on every version). The
// title bar, its sheet and the Versions panel then show the person only.
import { R, viewerPath } from "@oa/shared";
import { createHandlers, fixtures } from "@oa/shared/mocks";
import { fireEvent, screen, within } from "@testing-library/react";
import { getResponse, HttpResponse, http } from "msw";
import { describe, expect, it, vi } from "vitest";
import { events, installHarness, mount, server } from "./harness";
import { FIRST_LOAD_MS } from "./timeouts";

vi.mock("../src/viewer/bridge", () => ({
  createBridge: () => ({
    dispose: vi.fn(),
    requestThumbnail: vi.fn(),
    setTheme: vi.fn(),
    setArtifact: vi.fn(),
  }),
}));

installHarness();

const DRAFT = (
  fixtures.artifacts.find((a) => a.title === "Shared draft") as { id: string }
).id; // Bob's agent published it

/** As the server answers a guest: the role, and no agent anywhere. */
const asGuestWithoutAgent = () => {
  const base = createHandlers({ events });
  server.use(
    http.get(`*${R.me}`, () =>
      HttpResponse.json({
        ...fixtures.me,
        user: { ...fixtures.me.user, role: "guest" },
      }),
    ),
    http.get(`*${R.artifact(DRAFT)}`, async ({ request }) => {
      const res = await getResponse(base, request);
      if (!res?.ok) return res;
      return HttpResponse.json({
        ...((await res.json()) as object),
        lastAgent: null,
      });
    }),
    http.get("*/api/v1/artifacts/:id/versions", async ({ request }) => {
      const res = await getResponse(base, request);
      if (!res?.ok) return res;
      const list = (await res.json()) as object[];
      return HttpResponse.json(list.map((v) => ({ ...v, agent: null })));
    }),
  );
};

describe("a guest, with the agent absent from the response", () => {
  it("the title bar and its sheet name the person only", async () => {
    asGuestWithoutAgent();
    mount(viewerPath(DRAFT));
    const picture = await screen.findByRole(
      "button",
      { name: /^Published by Bob Builder, / },
      { timeout: FIRST_LOAD_MS },
    );
    expect(document.querySelector("[data-publisher]")).not.toHaveTextContent(
      "Claude Code",
    );
    fireEvent.click(picture);
    const sheet = await screen.findByText("Published by Bob Builder");
    expect(sheet.closest("[data-publisher-sheet]")).not.toHaveTextContent(
      /agent|Claude Code/,
    );
  });

  it("the Versions panel's rows name the person only", async () => {
    asGuestWithoutAgent();
    mount(`${viewerPath(DRAFT)}?panel=open&tab=versions`);
    const list = await screen.findByRole(
      "list",
      { name: "Versions" },
      { timeout: FIRST_LOAD_MS },
    );
    const row = within(list).getAllByRole("button")[0] as HTMLElement;
    expect(row).toHaveTextContent("Bob Builder");
    expect(row).not.toHaveTextContent("Claude Code");
    expect(row.querySelector('[data-avatar="agent"]')).toBeNull();
  });
});

describe("a member, where the server sends the agent", () => {
  it("the title bar names the agent and whose it is", async () => {
    mount(viewerPath(DRAFT));
    expect(
      await screen.findByRole(
        "button",
        { name: /^Published by Claude Code, Bob's agent, / },
        { timeout: FIRST_LOAD_MS },
      ),
    ).toBeInTheDocument();
  });
});
