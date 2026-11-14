import { type CapReason, type Me, R, type Role } from "@oa/shared";
import { fixtures } from "@oa/shared/mocks";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { installHarness, mount, mountHosted, server } from "./harness";

installHarness();
const primary = () => screen.findByRole("navigation", { name: "Primary" });
const asCaller =
  (role: Role, cap: CapReason | null = null) =>
  (me: Me): Me => ({
    ...me,
    user: { ...me.user, role },
    auth: me.auth && { ...me.auth, readOnly: cap !== null, cap },
  });
const emptyRoster = (hasMachine: boolean) => {
  server.use(
    http.get("*/api/v1/me", () =>
      HttpResponse.json({ ...fixtures.me, canConnect: true, busOn: true }),
    ),
    http.get(`*${R.busAgents}`, () =>
      HttpResponse.json({ agents: [], live: true }),
    ),
    http.get(`*${R.busMachines}`, () =>
      HttpResponse.json({ machines: hasMachine ? fixtures.busMachines : [] }),
    ),
  );
};

describe("agent setup and messaging entries", () => {
  it.each<Role>(["owner", "admin", "member"])(
    "%s can find setup even with artifacts already in the library",
    async (role) => {
      const router = mountHosted("/", true, asCaller(role));
      const nav = await primary();
      const connect = await within(nav).findByRole("link", {
        name: "Connect agents",
      });
      expect(connect).toHaveAttribute("href", "/settings/connections");
      fireEvent.click(connect);
      await waitFor(() =>
        expect(router.state.location.pathname).toBe("/settings/connections"),
      );
      expect(await screen.findByLabelText("Setup prompt")).toBeVisible();
      expect(
        await screen.findByRole("heading", { name: "MCP server" }),
      ).toBeVisible();
      expect(
        within(nav).getByRole("link", { name: "Connect agents" }),
      ).toHaveAttribute("aria-current", "page");
      expect(nav.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
      expect(
        within(nav).getByRole("link", { name: /^Settings/ }),
      ).not.toHaveAttribute("aria-current");
    },
  );

  it("guests see neither setup nor messaging entries", async () => {
    mountHosted("/shared", true, asCaller("guest", "guest"));
    const nav = await primary();
    expect(
      within(nav).queryByRole("link", { name: "Connect agents" }),
    ).toBeNull();
    expect(
      within(nav).queryByRole("link", { name: "Agent messaging" }),
    ).toBeNull();
  });

  it("a capped caller keeps a revoke-only Connections entry", async () => {
    mountHosted(
      "/settings/connections",
      true,
      asCaller("member", "restricted"),
    );
    expect(
      await screen.findByText(
        "You can't connect new agents. You can revoke these.",
      ),
    ).toBeVisible();
    const nav = await primary();
    expect(
      within(nav).queryByRole("link", { name: "Connect agents" }),
    ).toBeNull();
    expect(
      within(nav).getByRole("link", { name: "Connections" }),
    ).toHaveAttribute("aria-current", "page");
    expect(nav.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
    expect(screen.queryByLabelText("Setup prompt")).toBeNull();
    expect(screen.queryByRole("button", { name: "Create token" })).toBeNull();
  });

  it("a capped caller with nothing to revoke has no connection entry", async () => {
    const router = mountHosted(
      "/settings/connections",
      true,
      asCaller("member", "restricted"),
      [
        http.get("*/api/v1/tokens", () => HttpResponse.json([])),
        http.get("*/api/v1/oauth-clients", () => HttpResponse.json([])),
      ],
    );
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/settings/profile"),
    );
    const nav = await primary();
    expect(
      within(nav).queryByRole("link", { name: "Connect agents" }),
    ).toBeNull();
    expect(within(nav).queryByRole("link", { name: "Connections" })).toBeNull();
    expect(
      within(nav).getByRole("link", { name: /^Settings/ }),
    ).toHaveAttribute("aria-current", "page");
  });

  it("plan-locked setup stays readable with its existing disabled controls", async () => {
    mountHosted("/settings/connections", true, asCaller("owner", "plan"));
    const nav = await primary();
    expect(
      await within(nav).findByRole("link", { name: "Connect agents" }),
    ).toBeVisible();
    expect(await screen.findByLabelText("Setup prompt")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Copy setup prompt" }),
    ).toBeDisabled();
  });

  it("a no-machine messaging deep link explains the task and recovers to setup", async () => {
    emptyRoster(false);
    const router = mount("/agents");
    expect(
      await screen.findByRole("heading", { name: "Agent messaging", level: 1 }),
    ).toBeVisible();
    expect(
      screen.getByText(
        "Let your running agents discover and message each other across machines. Only you see this page.",
      ),
    ).toBeVisible();
    expect(
      await screen.findByRole("link", { name: "Go to Machines" }),
    ).toHaveAttribute("href", "/settings/machines");
    fireEvent.click(
      screen.getByRole("link", { name: "Connect an agent to your library" }),
    );
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/settings/connections"),
    );
    expect(await screen.findByLabelText("Setup prompt")).toBeVisible();
  });

  it("an existing machine with no sessions does not ask for machine pairing again", async () => {
    emptyRoster(true);
    mount("/agents");
    expect(await screen.findByText("No agents running")).toBeVisible();
    expect(screen.queryByText("Connect a machine first.")).toBeNull();
    expect(screen.queryByRole("link", { name: "Go to Machines" })).toBeNull();
  });
});
