import { emptyWorld } from "@oa/shared/provisioning/fixtures";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { http, json, renderApp, seen, use } from "./harness";

it("lists installs with state and version, and the header strip from the world", async () => {
  renderApp("/installs");
  const row = (await screen.findByRole("link", { name: "leo" })).closest("tr");
  expect(row).not.toBeNull();
  expect(within(row as HTMLElement).getByText("active")).toBeInTheDocument();
  expect(within(row as HTMLElement).getByText("1.42.0")).toBeInTheDocument();
  expect(screen.getAllByRole("link", { name: "broken" })).not.toHaveLength(0);
  expect(screen.getByRole("link", { name: "Create install" })).toHaveAttribute(
    "href",
    "/installs/new",
  );
  const tiles = await screen.findByTestId("tile-installs");
  expect(tiles).toHaveTextContent("3 installs");
  expect(screen.getByTestId("tile-jobs")).toHaveTextContent("1 failed in 24 h");
  expect(screen.getByTestId("tile-attention")).toHaveTextContent(
    "2 need attention",
  );
  expect(screen.getByTestId("tile-token")).toHaveTextContent("340 days left");
  expect(screen.getByTestId("tile-scheduler")).toHaveTextContent("running");
  expect(screen.getByTestId("tile-prodclean")).toHaveTextContent("clean");
  expect(
    await screen.findByText(/job failed \(prod_dirty\)/),
  ).toBeInTheDocument();
});

it("says there are no instances yet when there are none", async () => {
  use(
    http.get("*/api/v1/installs", () => json({ items: [], nextCursor: null })),
    http.get("*/api/v1/world", () => json(emptyWorld("staging"))),
  );
  renderApp("/installs");
  expect(await screen.findByText("No installs yet.")).toBeInTheDocument();
});

it("filters by state and says so when nothing matches", async () => {
  renderApp("/installs");
  await screen.findByRole("link", { name: "leo" });
  fireEvent.change(screen.getByLabelText("State"), {
    target: { value: "suspended" },
  });
  expect(await screen.findByText("No installs match.")).toBeInTheDocument();
  expect(seen.some((s) => s.path.includes("state=suspended"))).toBe(true);
});

it("pages with the cursor from the API", async () => {
  use(
    http.get("*/api/v1/installs", ({ request }) => {
      const c = new URL(request.url).searchParams.get("cursor");
      const mk = (slug: string, id: string) => ({
        id,
        slug,
        appHost: `${slug}.x`,
        contentHost: `${slug}.y`,
        state: "active",
        servingMode: "serving",
        version: "1.42.0",
        tier: null,
        auth: { providers: ["google"], domainCount: 1 },
        health: "ok",
        source: "admin",
        activeJobId: null,
        createdAt: 1_790_000_000_000,
      });
      return c
        ? json({ items: [mk("second", "isecond00002")], nextCursor: null })
        : json({ items: [mk("first", "ifirst000001")], nextCursor: "c2" });
    }),
  );
  renderApp("/installs");
  await screen.findByRole("link", { name: "first" });
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await screen.findByRole("link", { name: "second" });
  expect(seen.some((s) => s.path.includes("cursor=c2"))).toBe(true);
  expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Previous" }));
  await screen.findByRole("link", { name: "first" });
});

it("shows a load error with retry", async () => {
  let fail = true;
  use(
    http.get("*/api/v1/installs", () =>
      fail
        ? json({ error: { code: "internal", message: "x" } }, 500)
        : json({ items: [], nextCursor: null }),
    ),
  );
  renderApp("/installs");
  expect(await screen.findByText("Couldn't load installs")).toBeInTheDocument();
  fail = false;
  const alert = screen.getByText("Couldn't load installs").closest("div");
  fireEvent.click(
    within(alert as HTMLElement).getByRole("button", { name: "Retry" }),
  );
  expect(await screen.findByText("No installs yet.")).toBeInTheDocument();
  await waitFor(() =>
    expect(screen.queryByText("Couldn't load installs")).toBeNull(),
  );
});
