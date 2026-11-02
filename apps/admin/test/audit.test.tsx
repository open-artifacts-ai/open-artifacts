import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { auditEntries, FIXTURE_IDS, tokens } from "../src/mocks/fixtures";
import { detailLine } from "../src/pages/Audit";
import { http, json, renderApp, seen, use } from "./harness";

it("lists entries of each outcome; aggregated refusals show a count", async () => {
  use(
    http.get("*/api/v1/audit", () =>
      json({ items: auditEntries, nextCursor: null }),
    ),
  );
  renderApp("/audit");
  await screen.findAllByRole("row");
  const items = screen.getAllByRole("row").slice(1);
  expect(items.map((i) => i.getAttribute("data-outcome"))).toEqual([
    "ok",
    "refused",
    "error",
  ]);
  expect(screen.getByTestId("count")).toHaveTextContent("x12");
  expect(
    within(screen.getByRole("table")).getByText(/deleted for good/),
  ).toBeInTheDocument();
});

it("filters by install id from the query string", async () => {
  renderApp(`/audit?installId=${FIXTURE_IDS.leo}`);
  await screen.findAllByRole("row");
  expect(
    seen.some((s) => s.path.includes(`installId=${FIXTURE_IDS.leo}`)),
  ).toBe(true);
  expect(screen.getByLabelText("Install")).toHaveValue(FIXTURE_IDS.leo);
});

it("applies a typed filter and clears it", async () => {
  const { router } = renderApp("/audit");
  await screen.findAllByRole("row");
  // Three controls, no Filter button: Enter in the Install search applies it.
  expect(screen.queryByRole("button", { name: "Filter" })).toBeNull();
  const install = screen.getByRole("searchbox", { name: "Install" });
  fireEvent.change(install, { target: { value: FIXTURE_IDS.acme } });
  fireEvent.submit(install);
  await screen.findByRole("link", { name: "Clear filter" });
  expect(router.state.location.search).toEqual({ installId: FIXTURE_IDS.acme });
  fireEvent.click(screen.getByRole("link", { name: "Clear filter" }));
  await waitFor(() =>
    expect(screen.queryByRole("link", { name: "Clear filter" })).toBeNull(),
  );
  expect(install).toHaveValue("");
});

it("pages with the cursor", async () => {
  use(
    http.get("*/api/v1/audit", ({ request }) =>
      new URL(request.url).searchParams.get("cursor")
        ? json({ items: [auditEntries[1]], nextCursor: null })
        : json({ items: [auditEntries[0]], nextCursor: "c2" }),
    ),
  );
  renderApp("/audit");
  await within(await screen.findByRole("table")).findByText(
    "started an upgrade of",
  );
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await within(screen.getByRole("table")).findByText(/deleted for good/);
  expect(seen.some((s) => s.path.includes("cursor=c2"))).toBe(true);
});

it("says when there are no entries", async () => {
  use(http.get("*/api/v1/audit", () => json({ items: [], nextCursor: null })));
  renderApp("/audit");
  expect(await screen.findByText("No audit entries.")).toBeInTheDocument();
});

it("filters by actor and action, and keeps both in the URL", async () => {
  use(http.get("*/api/v1/tokens", () => json({ items: tokens })));
  const { router } = renderApp("/audit");
  await screen.findAllByRole("row");
  const actor = screen.getByRole("combobox", { name: "Actor" });
  expect(actor).toHaveTextContent("Any actor");
  fireEvent.click(actor);
  // You, the Scheduler and each agent token (by id) are offered.
  expect(
    await screen.findByRole("option", { name: "Scheduler" }),
  ).toBeInTheDocument();
  fireEvent.click(await screen.findByRole("option", { name: "token: ci" }));
  const tokenActor = `token:${FIXTURE_IDS.token}`;
  await waitFor(() =>
    expect(
      seen.some((s) =>
        s.path.includes(`actor=${encodeURIComponent(tokenActor)}`),
      ),
    ).toBe(true),
  );
  fireEvent.click(screen.getByRole("combobox", { name: "Action" }));
  fireEvent.click(
    await screen.findByRole("option", { name: "started an upgrade of" }),
  );
  await waitFor(() =>
    expect(router.state.location.search).toEqual({
      actor: tokenActor,
      action: "install.upgrade",
    }),
  );
  await waitFor(() =>
    expect(
      seen.some(
        (s) =>
          s.path.includes(`actor=${encodeURIComponent(tokenActor)}`) &&
          s.path.includes("action=install.upgrade"),
      ),
    ).toBe(true),
  );
  fireEvent.click(screen.getByRole("link", { name: "Clear filter" }));
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Actor" })).toHaveTextContent(
      "Any actor",
    ),
  );
  expect(screen.getByRole("combobox", { name: "Action" })).toHaveTextContent(
    "Any action",
  );
});

it("shows an actor and an action from the URL that are not in the lists", async () => {
  renderApp("/audit?action=token.mint&actor=someone%40example.com");
  await screen.findAllByRole("row");
  expect(screen.getByRole("combobox", { name: "Action" })).toHaveTextContent(
    "token.mint",
  );
  expect(screen.getByRole("combobox", { name: "Actor" })).toHaveTextContent(
    "someone@example.com",
  );
  expect(seen.some((s) => s.path.includes("actor=someone%40example.com"))).toBe(
    true,
  );
});

it("Target shows the install's slug in a link, and Detail is a plain line, never JSON", async () => {
  use(
    http.get("*/api/v1/audit", () =>
      json({
        items: [
          {
            ...auditEntries[0],
            detail: {
              kind: "upgrade",
              args: { version: "0.77.1" },
              route: "R6",
              admin: "me@example.com",
            },
          },
        ],
        nextCursor: null,
      }),
    ),
  );
  renderApp("/audit");
  const table = await screen.findByRole("table");
  const target = await within(table).findByRole("link", { name: "leo" });
  expect(target).toHaveAttribute("href", `/installs/${FIXTURE_IDS.leo}`);
  const row = within(table).getAllByRole("row")[1];
  expect(row).toHaveTextContent(/to 0\.77\.1 · job 01JD7Z…/);
  expect(row.textContent).not.toMatch(/[{}"]/);
  expect(row.textContent).not.toContain("me@example.com");
});

it("Target falls back to the install id when the install can't be read", async () => {
  use(
    http.get("*/api/v1/installs/:id", () =>
      json({ error: { code: "not_found", message: "No." } }, 404),
    ),
  );
  renderApp("/audit");
  const table = await screen.findByRole("table");
  expect(
    await within(table).findByRole("link", { name: FIXTURE_IDS.leo }),
  ).toBeInTheDocument();
});

it("detailLine reads the fields people read and drops the rest", () => {
  expect(detailLine(null)).toBe("");
  expect(
    detailLine({
      kind: "create",
      args: { tier: "team", auth: { providers: ["google"], domains: [] } },
    }),
  ).toBe("Team, Google");
  expect(detailLine({ kind: "upgrade", args: { version: "0.77.1" } })).toBe(
    "to 0.77.1",
  );
  expect(
    detailLine({
      kind: "suspend",
      args: { reason: "Billing hold" },
      route: "R8",
    }),
  ).toBe("Billing hold");
  expect(
    detailLine({ surface: "mcp", tool: "check_slug", client: "Claude Code" }),
  ).toBe("via MCP · Claude Code");
  expect(detailLine({ stage: "auth_time" })).toBe("auth_time");
  expect(detailLine({ tokenId: "x", admin: "a@b.c", nested: { a: 1 } })).toBe(
    "",
  );
});
