import { emptyWorld, fixtureWorld } from "@oa/shared/provisioning/fixtures";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { fmtClock } from "../src/components/labels";
import { SEARCH_DELAY_MS } from "../src/pages/Installs";
import { http, json, renderApp, seen, use } from "./harness";

it("lists installs with state, release, sign-in and health, and six tiles from the world", async () => {
  renderApp("/installs");
  const row = (await screen.findAllByRole("link", { name: "leo" }))[0].closest(
    "tr",
  );
  expect(row).not.toBeNull();
  const r = within(row as HTMLElement);
  expect(r.getByTestId("state")).toHaveTextContent("Active");
  expect(r.getByText("1.42.0")).toBeInTheDocument();
  expect(r.getByText("Team")).toBeInTheDocument();
  expect(r.getByText("Google · 1 domain")).toBeInTheDocument();
  expect(r.getByText("OK")).toBeInTheDocument();
  expect(r.getByText("leo.open-artifacts.app")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Create install" })).toHaveAttribute(
    "href",
    "/installs/new",
  );
  await screen.findByTestId("tile-active");
  expect(screen.getByTestId("tile-active")).toHaveTextContent("2");
  expect(screen.getByTestId("tile-creating")).toHaveTextContent("0");
  expect(screen.getByTestId("tile-paused")).toHaveTextContent(
    "Paused · Deleting",
  );
  expect(screen.getByTestId("tile-attention")).toHaveTextContent("2");
  expect(screen.getByTestId("tile-token")).toHaveTextContent("340 days left");
  const at = fixtureWorld().prodClean?.at ?? 0;
  expect(screen.getByTestId("tile-prodclean")).toHaveTextContent(
    `${fmtClock(at)} passed`,
  );
  expect(screen.getByText("3 installs on staging.")).toBeInTheDocument();
});

it("shows a failed create and its attention badges in the table", async () => {
  renderApp("/installs");
  const row = (
    await screen.findAllByRole("link", { name: "broken" })
  )[0].closest("tr");
  const r = within(row as HTMLElement);
  expect(r.getByTestId("state")).toHaveTextContent("Create failed");
  expect(r.getByTestId("state")).toHaveTextContent("prod_dirty");
  // The state cell already says it failed: no second chip for the same thing.
  expect(r.getByTestId("state")).not.toHaveTextContent(/job failed/i);
  const acme = (
    await screen.findAllByRole("link", { name: "acme" })
  )[0].closest("tr");
  expect(within(acme as HTMLElement).getByTestId("state")).toHaveTextContent(
    "Routing mismatch",
  );
});

it("shows an upgrade target from args.version", async () => {
  const w = fixtureWorld();
  const job = { ...w.jobs.recent[0], args: { version: "1.43.0" } };
  use(
    http.get("*/api/v1/world", () =>
      json({ ...w, jobs: { ...w.jobs, recent: [job] } }),
    ),
    http.get("*/api/v1/installs", () =>
      json({ items: [w.installs.items[0]], nextCursor: null }),
    ),
  );
  renderApp("/installs");
  const row = (await screen.findAllByRole("link", { name: "leo" }))[0].closest(
    "tr",
  );
  await waitFor(() =>
    expect(within(row as HTMLElement).getByTestId("state")).toHaveTextContent(
      "to 1.43.0",
    ),
  );
});

it("sorts the page by a column", async () => {
  renderApp("/installs");
  await screen.findAllByRole("link", { name: "leo" });
  const slugs = () =>
    screen
      .getAllByRole("row")
      .slice(1)
      .map((tr) => within(tr).getAllByRole("link")[0].textContent);
  fireEvent.click(screen.getByRole("button", { name: "Install" }));
  expect(slugs()).toEqual(["acme", "broken", "leo"]);
  fireEvent.click(screen.getByRole("button", { name: /^Install/ }));
  expect(slugs()).toEqual(["leo", "broken", "acme"]);
  expect(screen.getByRole("columnheader", { name: /Install/ })).toHaveAttribute(
    "aria-sort",
    "descending",
  );
});

it("says there are no installs yet when there are none", async () => {
  use(
    http.get("*/api/v1/installs", () => json({ items: [], nextCursor: null })),
    http.get("*/api/v1/world", () => json(emptyWorld("staging"))),
  );
  renderApp("/installs");
  expect(await screen.findByText("No installs yet")).toBeInTheDocument();
  expect(
    screen.getByText(
      "Create the first one. It runs as a job, and nothing is reachable until every check passes.",
    ),
  ).toBeInTheDocument();
});

it("searches on the server and says so when nothing matches", async () => {
  renderApp("/installs");
  await screen.findAllByRole("link", { name: "leo" });
  fireEvent.change(screen.getByLabelText("Search slug"), {
    target: { value: "zzz" },
  });
  expect(await screen.findByText("No installs match.")).toBeInTheDocument();
  expect(seen.some((s) => s.path.includes("q=zzz"))).toBe(true);
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

/** Two pages: "first" with a next cursor, then "second". */
const twoPages = () => {
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
};

it("pages with the cursor from the API", async () => {
  twoPages();
  renderApp("/installs");
  await screen.findByRole("link", { name: "first" });
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await screen.findByRole("link", { name: "second" });
  expect(seen.some((s) => s.path.includes("cursor=c2"))).toBe(true);
  expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Previous" }));
  await screen.findByRole("link", { name: "first" });
});

// Root cause of a CI flake: the search debounce used to reset the cursor stack
// when it first fired (300 ms after mount) even though nothing had been typed,
// so a Next click made in that window was undone. Drive the timer, don't race it.
it("keeps page 2 when the unchanged search debounce fires after Next", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    twoPages();
    renderApp("/installs");
    await screen.findByRole("link", { name: "first" });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByRole("link", { name: "second" });
    // Let the debounce fire. If it reset the cursor, page 1 is requested again
    // (the request is logged when the fetch starts, inside this act).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SEARCH_DELAY_MS * 3);
    });
    const pageOne = seen.filter(
      (r) =>
        r.path.startsWith("/api/v1/installs?") && !r.path.includes("cursor="),
    );
    expect(pageOne).toHaveLength(1);
    expect(screen.getByRole("link", { name: "second" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "first" })).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

it("going back to page 1 after typing a search resets the cursor", async () => {
  twoPages();
  renderApp("/installs");
  await screen.findByRole("link", { name: "first" });
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await screen.findByRole("link", { name: "second" });
  fireEvent.change(screen.getByLabelText("Search slug"), {
    target: { value: "f" },
  });
  await screen.findByRole("link", { name: "first" });
  expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
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
  expect(await screen.findByText("No installs yet")).toBeInTheDocument();
  await waitFor(() =>
    expect(screen.queryByText("Couldn't load installs")).toBeNull(),
  );
});
