import { fireEvent, screen, waitFor, within } from "@testing-library/react";
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
  fireEvent.change(screen.getByLabelText("Install"), {
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
  const { router } = renderApp("/audit");
  await screen.findAllByRole("row");
  fireEvent.change(screen.getByLabelText("Actor"), {
    target: { value: "Leo" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Filter" }));
  await waitFor(() =>
    expect(seen.some((s) => s.path.includes("actor=Leo"))).toBe(true),
  );
  fireEvent.change(screen.getByLabelText("Action"), {
    target: { value: "install.upgrade" },
  });
  await waitFor(() =>
    expect(
      seen.some(
        (s) =>
          s.path.includes("actor=Leo") &&
          s.path.includes("action=install.upgrade"),
      ),
    ).toBe(true),
  );
  expect(router.state.location.search).toEqual({
    actor: "Leo",
    action: "install.upgrade",
  });
  fireEvent.click(screen.getByRole("link", { name: "Clear filter" }));
  await waitFor(() => expect(screen.getByLabelText("Actor")).toHaveValue(""));
  expect(screen.getByLabelText("Action")).toHaveValue("");
});
