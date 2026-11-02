import type { CapReason, Me, Role } from "@oa/shared";
import { fixtures } from "@oa/shared/mocks";
import {
  act,
  cleanup,
  fireEvent,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it, vi } from "vitest";
import { qk } from "../src/api/queries";
import { useCanSetUpAgent } from "../src/settings/AgentSetupCard";
import {
  installHarness,
  lastClient,
  mount,
  mountHosted,
  page,
  server,
  wrapper,
} from "./harness";

installHarness();

const INSTRUCTION = () =>
  `Set up Open Artifacts for me: follow ${location.origin}/llms.txt\nSign in through the browser. Never ask me to paste a token into this chat.`;
const none = http.get("*/api/v1/artifacts", () => page([], null));
const empty = () => server.use(none);
const clipboard = () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
  return writeText;
};

describe("AgentSetupCard", () => {
  it("shows on Settings > Agents with the origin's llms.txt, and copies it", async () => {
    const writeText = clipboard();
    mount("/settings/agents");
    expect(
      await screen.findByRole("heading", { name: "Set up with an agent" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Paste this into any AI agent. It connects itself and asks you to approve it in your browser.",
      ),
    ).toBeInTheDocument();
    const field = screen.getByLabelText("Setup prompt");
    expect(field).toHaveValue(INSTRUCTION());
    expect(field).toHaveAttribute("readonly");
    // The URL ends its line: nothing after it can read as part of it.
    expect(INSTRUCTION().split("\n")[0]).toMatch(
      new RegExp(`${location.origin}/llms\\.txt$`),
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy setup prompt" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(INSTRUCTION()));
    expect(await screen.findByRole("button", { name: /Copied/ })).toBeTruthy();
  });

  it("a denied clipboard toasts the failure", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
      configurable: true,
    });
    mount("/settings/agents");
    fireEvent.click(
      await screen.findByRole("button", { name: "Copy setup prompt" }),
    );
    await screen.findByText(/couldn't copy/i);
  });

  it("shows in the empty Mine library, keeping the Settings link", async () => {
    empty();
    mount("/mine");
    await screen.findByText("Ask your agent to publish something");
    expect(await screen.findByLabelText("Setup prompt")).toHaveValue(
      INSTRUCTION(),
    );
    expect(screen.getByRole("link", { name: /agents/i })).toHaveAttribute(
      "href",
      "/settings/agents",
    );
  });

  it("not in a filtered empty state", async () => {
    empty();
    mount("/mine?format=markdown");
    await screen.findByText("No artifacts match these filters");
    expect(screen.queryByLabelText("Setup prompt")).toBeNull();
  });

  // The server's canConnect: consent, /mcp and POST /tokens refuse all of these.
  const asRole =
    (role: Role) =>
    (m: Me): Me => ({ ...m, user: { ...m.user, role } });
  const capped =
    (role: Role, cap: CapReason) =>
    (m: Me): Me => ({
      ...asRole(role)(m),
      auth: m.auth && { ...m.auth, readOnly: true, cap },
    });
  /** Fixtures' /me has no auth, as Access-only; give it one to cap. */
  const withAuth =
    (f: (m: Me) => Me) =>
    (m: Me): Me =>
      f({
        ...m,
        auth: { method: "code", readOnly: false, cap: null, expiresAt: null },
      });
  const meLoaded = async () => {
    await waitFor(() => expect(lastClient.getQueryData(qk.me)).toBeTruthy());
    await act(async () => {});
  };

  it.each([
    [
      "hosted",
      () => mountHosted("/mine", true, capped("guest", "guest"), [none]),
    ],
    [
      "Access-only, whose /me has no auth",
      () => {
        server.use(
          none,
          http.get("*/api/v1/me", () =>
            HttpResponse.json(asRole("guest")(fixtures.me)),
          ),
        );
        return mount("/mine");
      },
    ],
  ])("a guest never stays on Mine (%s)", async (_how, go) => {
    const router = go();
    await waitFor(() => expect(router.state.location.pathname).toBe("/shared"));
    expect(screen.queryByLabelText("Setup prompt")).toBeNull();
  });

  it.each([
    ["a restricted member", capped("member", "restricted")],
    [
      "a member in a code session outside the domains",
      capped("member", "guest"),
    ],
    [
      "an owner in a code session outside the domains",
      capped("owner", "guest"),
    ],
  ])("not for %s in the empty Mine library", async (_who, me) => {
    mountHosted("/mine", true, me, [none]);
    await screen.findByText("Ask your agent to publish something");
    await meLoaded();
    expect(screen.queryByLabelText("Setup prompt")).toBeNull();
  });

  // The rule itself, away from the redirects that keep guests off both screens.
  it.each<[string, (m: Me) => Me, boolean]>([
    ["owner", asRole("owner"), true],
    ["admin", asRole("admin"), true],
    ["member", asRole("member"), true],
    ["guest with no Me.auth (Access-only)", asRole("guest"), false],
    ["guest", withAuth(capped("guest", "guest")), false],
    ["restricted member", withAuth(capped("member", "restricted")), false],
    [
      "code session outside the domains",
      withAuth(capped("member", "guest")),
      false,
    ],
  ])("useCanSetUpAgent: %s", (_who, me, can) => {
    lastClient.setQueryData(qk.me, me(fixtures.me));
    const { result } = renderHook(useCanSetUpAgent, { wrapper });
    expect(result.current).toBe(can);
  });

  it.each([
    ["a restricted member", capped("member", "restricted")],
    [
      "a member in a code session outside the domains",
      capped("member", "guest"),
    ],
  ])("not for %s on Settings > Agents", async (_who, me) => {
    mountHosted("/settings/agents", true, me);
    await screen.findByRole("heading", { name: "Connected agents" });
    await meLoaded();
    expect(
      screen.queryByRole("heading", { name: "Set up with an agent" }),
    ).toBeNull();
  });

  it("a guest never reaches Settings > Agents", async () => {
    const router = mountHosted(
      "/settings/agents",
      true,
      capped("guest", "guest"),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe("/shared"));
    expect(screen.queryByLabelText("Setup prompt")).toBeNull();
  });

  it.each<[Role]>([["owner"], ["admin"], ["member"]])(
    "shows for an uncapped %s on both screens",
    async (role) => {
      mountHosted("/mine", true, asRole(role), [none]);
      expect(await screen.findByLabelText("Setup prompt")).toBeTruthy();
      cleanup();
      mountHosted("/settings/agents", true, asRole(role));
      expect(await screen.findByLabelText("Setup prompt")).toBeTruthy();
    },
  );

  it("hides with the MCP card when the instance has no MCP URL", async () => {
    const none_ = (m: Me): Me => ({
      ...m,
      instance: { ...m.instance, mcpUrl: "" },
    });
    mountHosted("/settings/agents", true, none_);
    await screen.findByRole("heading", { name: "Connected agents" });
    expect(screen.queryByRole("heading", { name: "MCP server" })).toBeNull();
    expect(screen.queryByLabelText("Setup prompt")).toBeNull();
  });

  it("has no em dash", () => {
    expect(INSTRUCTION()).not.toContain("—");
    expect(INSTRUCTION()).not.toContain("–");
  });
});
