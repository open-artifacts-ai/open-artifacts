import { fixtureMe, fixtureWorld } from "@oa/shared/provisioning/fixtures";
import { screen, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { http, json, renderApp, use } from "./harness";

const me = (o: Record<string, unknown> = {}) =>
  json({
    ...fixtureMe({
      principal: "admin",
      email: "leo@example.com",
      csrf: "c",
      tokenId: null,
      tokenKind: null,
      tokenExpiresAt: null,
    }),
    ...o,
  });

it("has the side nav, who is signed in and when the session ends", async () => {
  use(
    http.get("*/api/v1/me", () =>
      me({ sessionExpiresAt: Date.now() + 6 * 3_600_000 + 60_000 }),
    ),
  );
  renderApp("/installs");
  const nav = await screen.findByRole("navigation", { name: "Main" });
  expect(
    within(nav)
      .getAllByRole("link")
      .map((a) => a.textContent?.trim()),
  ).toEqual(["Installs", "Audit log", "Agent tokens"]);
  expect(await screen.findByText("leo@example.com")).toBeInTheDocument();
  expect(screen.getByText(/Signed in as/)).toBeInTheDocument();
  expect(screen.getByTestId("session-hint")).toHaveTextContent(
    "Session ends in 6 h",
  );
});

it("shows the Production banner on production only", async () => {
  use(http.get("*/api/v1/me", () => me({ env: "prod" })));
  const a = renderApp("/installs");
  expect(await screen.findByTestId("prod-banner")).toHaveTextContent(
    "Production. Changes here affect real workspaces.",
  );
  expect(screen.getByTestId("env-slot")).toHaveTextContent("Production");
  a.unmount();
  use(http.get("*/api/v1/me", () => me({ env: "staging" })));
  renderApp("/installs");
  await screen.findByRole("navigation", { name: "Main" });
  expect(screen.queryByTestId("prod-banner")).toBeNull();
});

it("warns when the provisioning token is expiring and when it is not working", async () => {
  use(
    http.get("*/api/v1/world", () =>
      json(
        fixtureWorld({
          provisioningToken: { status: "expiring", daysLeft: 24 },
        }),
      ),
    ),
  );
  const a = renderApp("/audit");
  expect(await screen.findByTestId("token-banner")).toHaveTextContent(
    "The provisioning token expires in 24 days. Roll it and paste it into Secrets Store before",
  );
  a.unmount();
  use(
    http.get("*/api/v1/world", () =>
      json(
        fixtureWorld({
          provisioningToken: { status: "invalid", daysLeft: null },
        }),
      ),
    ),
  );
  renderApp("/audit");
  expect(await screen.findByTestId("token-banner")).toHaveTextContent(
    "The provisioning token isn't working. Creates, upgrades, resumes and restores wait until it's replaced. Pausing and deleting still work.",
  );
});

it("shows no token banner when the token is fine", async () => {
  renderApp("/audit");
  await screen.findByRole("heading", { name: "Audit log" });
  expect(screen.queryByTestId("token-banner")).toBeNull();
});
