// Design's ruling for capped members on Settings > Agents: revoke only, a card
// only with rows, and no Agents tab with nothing to revoke.
import type { CapReason, Me, Role } from "@oa/shared";
import { fixtures } from "@oa/shared/mocks";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { installHarness, mountHosted, server } from "./harness";

installHarness();

const AGENTS_LINE = "You can't connect new agents. You can revoke these.";
const TOKENS_LINE = "You can't create new tokens. You can revoke these.";
const capped =
  (role: Role = "member", cap: CapReason = "restricted") =>
  (m: Me): Me => ({
    ...m,
    user: { ...m.user, role },
    auth: m.auth && { ...m.auth, readOnly: true, cap },
  });
const noTokens = http.get("*/api/v1/tokens", () => HttpResponse.json([]));
const noAgents = http.get("*/api/v1/oauth-clients", () =>
  HttpResponse.json([]),
);
const tab = (name: string) =>
  within(
    screen.getByRole("navigation", { name: "Settings sections" }),
  ).queryByRole("link", { name });

describe("capped caller on Settings > Agents", () => {
  it("with rows: each card's line, Revoke, no Create token or label control", async () => {
    mountHosted("/settings/agents", true, capped());
    await screen.findByText(AGENTS_LINE);
    expect(await screen.findByText(TOKENS_LINE)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create token" })).toBeNull();
    expect(screen.getByRole("button", { name: "Revoke laptop" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /label/i })).toBeNull();
    expect(tab("Agents")).not.toBeNull();
  });

  it("no tokens: that card goes, with no empty line; the tab stays", async () => {
    mountHosted("/settings/agents", true, capped(), [noTokens]);
    await screen.findByText(AGENTS_LINE);
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: "Personal access tokens" }),
      ).toBeNull(),
    );
    expect(screen.queryByText(/No tokens/)).toBeNull();
    expect(tab("Agents")).not.toBeNull();
  });

  it("no agents: that card goes, with no empty line; the tab stays", async () => {
    mountHosted("/settings/agents", true, capped(), [noAgents]);
    await screen.findByText(TOKENS_LINE);
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: "Connected agents" }),
      ).toBeNull(),
    );
    expect(screen.queryByText(/No agents connected/)).toBeNull();
    expect(tab("Agents")).not.toBeNull();
  });

  it.each<[string, (m: Me) => Me, string]>([
    ["a restricted member, from Agents", capped(), "/settings/agents"],
    ["a restricted member, from Members", capped(), "/settings/members"],
    ["a capped owner", capped("owner", "guest"), "/settings/agents"],
  ])("both empty: no tab, and Profile (%s)", async (_who, me, from) => {
    const router = mountHosted(from, true, me, [noTokens, noAgents]);
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/settings/profile"),
    );
    await waitFor(() => expect(tab("Agents")).toBeNull());
    expect(tab("Profile")).not.toBeNull();
  });

  it("a card that failed to load stays, so its error shows", async () => {
    mountHosted("/settings/agents", true, capped(), [
      noAgents,
      http.get("*/api/v1/tokens", () =>
        HttpResponse.json(
          { error: { code: "internal", message: "x" } },
          { status: 403 },
        ),
      ),
    ]);
    expect(await screen.findByText("Couldn't load tokens.")).toBeTruthy();
    expect(tab("Agents")).not.toBeNull();
  });

  it("revoking the last row leaves for Profile", async () => {
    const list = [...fixtures.tokens];
    const router = mountHosted("/settings/agents", true, capped(), [
      noAgents,
      http.get("*/api/v1/tokens", () => HttpResponse.json(list)),
      http.delete("*/api/v1/tokens/:id", () => {
        list.pop();
        return new HttpResponse(null, { status: 204 });
      }),
    ]);
    fireEvent.click(
      await screen.findByRole("button", { name: "Revoke laptop" }),
    );
    const dlg = await screen.findByRole("alertdialog");
    fireEvent.click(within(dlg).getByRole("button", { name: "Revoke" }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/settings/profile"),
    );
  });
});

describe("uncapped caller on Settings > Agents: no change", () => {
  it("empty cards keep their lines and Create token; no revoke-only line", async () => {
    mountHosted("/settings/agents", true, undefined, [noTokens, noAgents]);
    await screen.findByText("No agents connected yet.");
    expect(await screen.findByText(/^No tokens\./)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create token" })).toBeTruthy();
    expect(screen.queryByText(AGENTS_LINE)).toBeNull();
    expect(screen.queryByText(TOKENS_LINE)).toBeNull();
    expect(tab("Agents")).not.toBeNull();
  });
});
