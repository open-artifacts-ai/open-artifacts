import { fireEvent, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { auditEntries, FIXTURE_IDS } from "../src/mocks/fixtures";
import { http, json, renderApp, seen, use } from "./harness";

it("lists entries of each outcome; aggregated refusals show a count", async () => {
  use(
    http.get("*/api/v1/audit", () =>
      json({ items: auditEntries, nextCursor: null }),
    ),
  );
  renderApp("/audit");
  const items = await screen.findAllByRole("listitem");
  expect(items.map((i) => i.getAttribute("data-outcome"))).toEqual([
    "ok",
    "refused",
    "error",
  ]);
  expect(screen.getByTestId("count")).toHaveTextContent("x12");
  expect(screen.getByText("install.purge")).toBeInTheDocument();
});

it("filters by install id from the query string", async () => {
  renderApp(`/audit?installId=${FIXTURE_IDS.leo}`);
  await screen.findAllByRole("listitem");
  expect(
    seen.some((s) => s.path.includes(`installId=${FIXTURE_IDS.leo}`)),
  ).toBe(true);
  expect(screen.getByLabelText("Install id")).toHaveValue(FIXTURE_IDS.leo);
});

it("applies a typed filter and clears it", async () => {
  const { router } = renderApp("/audit");
  await screen.findAllByRole("listitem");
  fireEvent.change(screen.getByLabelText("Install id"), {
    target: { value: FIXTURE_IDS.acme },
  });
  fireEvent.click(screen.getByRole("button", { name: "Filter" }));
  await screen.findByRole("link", { name: "Clear filter" });
  expect(router.state.location.search).toEqual({ installId: FIXTURE_IDS.acme });
  fireEvent.click(screen.getByRole("link", { name: "Clear filter" }));
  await screen.findByRole("button", { name: "Filter" });
  expect(screen.queryByRole("link", { name: "Clear filter" })).toBeNull();
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
  await screen.findByText("install.upgrade");
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await screen.findByText("install.purge");
  expect(seen.some((s) => s.path.includes("cursor=c2"))).toBe(true);
});

it("says when there are no entries", async () => {
  use(http.get("*/api/v1/audit", () => json({ items: [], nextCursor: null })));
  renderApp("/audit");
  expect(await screen.findByText("No audit entries.")).toBeInTheDocument();
});
