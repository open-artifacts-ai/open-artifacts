import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fixtureAudit } from "@oa/shared/provisioning/fixtures";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { auditEntries, FIXTURE_IDS, tokens } from "../src/mocks/fixtures";
import { AUDIT_ACTIONS, actionPhrase, detailLine } from "../src/pages/Audit";
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
  expect(screen.getByTestId("count")).toHaveTextContent(/^12 times$/);
  expect(
    within(screen.getByRole("table")).getByText(/couldn't sign in/),
  ).toBeInTheDocument();
});

it("a refused call: the verb says so, its code is the detail, and no raw action or chip", async () => {
  use(
    http.get("*/api/v1/audit", () =>
      json({
        items: [
          fixtureAudit({
            id: "adm:9",
            action: "authz.refused",
            outcome: "refused",
            code: "forbidden",
            installId: null,
            jobId: null,
            detail: { route: "R20", surface: "http" },
          }),
        ],
        nextCursor: null,
      }),
    ),
  );
  renderApp("/audit");
  await screen.findAllByRole("row");
  const row = screen.getAllByRole("row")[1] as HTMLElement;
  const cells = within(row).getAllByRole("cell");
  expect(cells[2]).toHaveTextContent(/^was refused$/);
  expect(cells[4]).toHaveTextContent(/^forbidden$/);
  expect(row).not.toHaveTextContent("authz.refused");
  expect(row).toHaveAttribute("data-outcome", "refused");
});

it("the two relabelled actions read as Design's copy", () => {
  expect(actionPhrase("job.failed")).toBe("had a job fail");
  expect(actionPhrase("oauth.client_expired")).toBe(
    "had an agent client expire",
  );
});

it("a row with no target marks the cell, so phones drop its dash", async () => {
  use(
    http.get("*/api/v1/audit", () =>
      json({
        items: [
          fixtureAudit({ installId: null }),
          fixtureAudit({ id: "api:2" }),
        ],
        nextCursor: null,
      }),
    ),
  );
  renderApp("/audit");
  await screen.findAllByRole("row");
  const [none, some] = screen.getAllByRole("row").slice(1) as HTMLElement[];
  expect(within(none as HTMLElement).getAllByRole("cell")[3]).toHaveClass(
    "oa-audit-none",
  );
  expect(within(some as HTMLElement).getAllByRole("cell")[3]).not.toHaveClass(
    "oa-audit-none",
  );
  const css = readFileSync(resolve(__dirname, "../src/styles.css"), "utf8");
  expect(css).toMatch(/\.oa-audit td\.oa-audit-none \{\s*display: none;/);
});

it("the job rows read as sentences, and a refused job keeps its code", async () => {
  use(
    http.get("*/api/v1/audit", () =>
      json({
        items: [
          fixtureAudit({ action: "job.accepted", detail: { kind: "create" } }),
          fixtureAudit({
            id: "api:2",
            action: "job.refused",
            outcome: "refused",
            code: "slug_taken",
            jobId: null,
            detail: null,
          }),
        ],
        nextCursor: null,
      }),
    ),
  );
  renderApp("/audit");
  await screen.findAllByRole("row");
  const [ok, refused] = screen.getAllByRole("row").slice(1) as HTMLElement[];
  expect(ok).toHaveTextContent("started a job on");
  expect(refused).toHaveTextContent("had a job refused on");
  expect(refused).toHaveTextContent("refused: slug_taken");
  expect(screen.getByRole("table")).not.toHaveTextContent("job.");
});

it("a job says on only when it has a target; other verbs never do", async () => {
  const none = { installId: null, jobId: null, detail: null };
  use(
    http.get("*/api/v1/audit", () =>
      json({
        items: [
          fixtureAudit({ ...none, action: "job.refused", id: "api:1" }),
          fixtureAudit({ ...none, action: "job.replayed", id: "api:2" }),
          fixtureAudit({ action: "job.replayed", id: "api:3", detail: null }),
          fixtureAudit({ action: "session.logout", id: "api:4", detail: null }),
        ],
        nextCursor: null,
      }),
    ),
  );
  renderApp("/audit");
  await screen.findAllByRole("row");
  const verbs = screen
    .getAllByRole("row")
    .slice(1)
    .map((r) => within(r).getAllByRole("cell")[2]?.textContent);
  expect(verbs).toEqual([
    "had a job refused",
    "replayed a job",
    "replayed a job on",
    "signed out",
  ]);
});

it("the chip sits in Detail, first, so the Action cell reads whole", async () => {
  use(
    http.get("*/api/v1/audit", () =>
      json({
        items: [
          fixtureAudit({
            action: "job.refused",
            outcome: "refused",
            code: "job_in_progress",
            detail: { note: "try later" },
            jobId: null,
          }),
          fixtureAudit({
            id: "api:2",
            action: "job.failed",
            outcome: "error",
            code: "cf_error",
            detail: null,
            jobId: null,
          }),
        ],
        nextCursor: null,
      }),
    ),
  );
  renderApp("/audit");
  await screen.findAllByRole("row");
  const [one, two] = screen
    .getAllByRole("row")
    .slice(1)
    .map((r) => within(r).getAllByRole("cell"));
  expect(one?.[2]).toHaveTextContent(/^had a job refused on$/);
  expect(one?.[4]).toHaveTextContent(/^refused: job_in_progress try later$/);
  expect(two?.[2]).toHaveTextContent(/^had a job fail on$/);
  expect(two?.[4]).toHaveTextContent(/^error: cf_error$/);
});

it("another refused action keeps its chip and code", async () => {
  use(
    http.get("*/api/v1/audit", () =>
      json({ items: [auditEntries[1]], nextCursor: null }),
    ),
  );
  renderApp("/audit");
  await screen.findAllByRole("row");
  const row = screen.getAllByRole("row")[1] as HTMLElement;
  expect(within(row).getByText("forbidden")).toHaveClass("oa-code");
  expect(row).toHaveTextContent("refused: forbidden");
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
  await within(await screen.findByRole("table")).findByText("started a job on");
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await within(screen.getByRole("table")).findByText(/couldn't sign in/);
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
  fireEvent.click(await screen.findByRole("option", { name: "started a job" }));
  await waitFor(() =>
    expect(router.state.location.search).toEqual({
      actor: tokenActor,
      action: "job.accepted",
    }),
  );
  await waitFor(() =>
    expect(
      seen.some(
        (s) =>
          s.path.includes(`actor=${encodeURIComponent(tokenActor)}`) &&
          s.path.includes("action=job.accepted"),
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
  renderApp("/audit?action=upgrade.start&actor=someone%40example.com");
  // The mock filters as R17 does (#1188): nothing matches, so no rows to wait on.
  await waitFor(() =>
    expect(seen.some((s) => s.path.startsWith("/api/v1/audit"))).toBe(true),
  );
  // A step row isn't offered, but its label still reads in the select.
  expect(screen.getByRole("combobox", { name: "Action" })).toHaveTextContent(
    "started an upgrade",
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

// #1136: the provisioner's step rows and the counted anonymous refusals.
const step = (
  n: number,
  action: string,
  actor = "job:01JD7Z9W5Q8X3N4M2K1H0G9F8A",
) =>
  fixtureAudit({
    id: `prov:${n}`,
    source: "provision",
    actor: { kind: "system", label: actor },
    action,
    outcome: action.includes("failed") ? "error" : "ok",
    detail: null,
  });
const refusal = (n: number, action: string, bucket: string, code: string) =>
  fixtureAudit({
    id: `agg:${n}`,
    source: "refusals",
    actor: { kind: "system", label: "anonymous" },
    action,
    outcome: "refused",
    code,
    count: 3,
    installId: null,
    jobId: null,
    detail: { bucket },
  });
const actionCells = async () => {
  await screen.findAllByRole("row");
  return screen
    .getAllByRole("row")
    .slice(1)
    .map((r) => {
      const c = within(r).getAllByRole("cell");
      return [c[1]?.textContent, c[2]?.textContent];
    });
};

it("step rows read as past-tense sentences, never raw names; the Scheduler is the actor", async () => {
  use(
    http.get("*/api/v1/audit", () =>
      json({
        items: [
          step(1, "upgrade.held"),
          step(2, "delete.revoke_pending"),
          step(3, "owner-token.lost_lease"),
          step(4, "suspend.hosts"),
          step(5, "oauth_copy.counts"),
          step(6, "fleet.halted", "system:scheduler"),
        ],
        nextCursor: null,
      }),
    ),
  );
  renderApp("/audit");
  const cells = await actionCells();
  expect(cells.map((c) => c[1])).toEqual([
    "held an upgrade",
    "waited to revoke Google access",
    "lost its lock",
    "took the install offline",
    "counted agent sign-ins to move",
    "halted the fleet rollout",
  ]);
  expect(cells[5]?.[0]).toBe("Scheduler");
});

it("a counted refusal reads its bucket's reason; an unmapped bucket reads plain", async () => {
  use(
    http.get("*/api/v1/audit", () =>
      json({
        items: [
          refusal(1, "auth.refused", "auth", "unauthenticated"),
          refusal(2, "csrf.refused", "csrf", "csrf_failed"),
          refusal(3, "pre.refused", "pre", "forbidden"),
          refusal(4, "oauth_register.refused", "oauth_register", "forbidden"),
          refusal(5, "rate_limited", "signin", "rate_limited"),
          refusal(6, "signin.refused", "signin", "unauthenticated"),
          refusal(7, "slug.refused", "slug", "forbidden"),
        ],
        nextCursor: null,
      }),
    ),
  );
  renderApp("/audit");
  const cells = await actionCells();
  expect(cells.map((c) => c[1]?.replace(/ 3 times$/, ""))).toEqual([
    "were refused (not signed in)",
    "were refused (failed cross-site check)",
    "were refused (too many requests)",
    "were refused (agent registration)",
    "were rate limited",
    "couldn't sign in",
    "were refused",
  ]);
  expect(cells[0]?.[0]).toBe("Anonymous callers");
  expect(screen.getByRole("table")).not.toHaveTextContent(
    /\b(auth|slug|pre)\.refused\b/,
  );
});

it("the Action filter adds only Design's step and refusal options", async () => {
  renderApp("/audit");
  await screen.findAllByRole("row");
  fireEvent.click(screen.getByRole("combobox", { name: "Action" }));
  const options = (await screen.findAllByRole("option")).map(
    (o) => o.textContent,
  );
  for (const label of [
    "held an upgrade",
    "flagged an upgrade for a forward fix",
    "rolled back to an unhealthy version",
    "forced the lock open",
    "halted the fleet rollout",
    "recorded an unclean install",
    "couldn't revoke Google access",
    "couldn't sign everyone out",
    "were refused (not signed in)",
    "were refused (too many requests)",
    "were refused (failed cross-site check)",
    "were refused (agent sign-in)",
    "were refused (agent registration)",
    "were rate limited",
  ])
    expect(options).toContain(label);
  // Steps job.done and job.failed sum up stay out.
  for (const label of [
    "started an upgrade",
    "lost its lock",
    "deleted the install",
  ])
    expect(options).not.toContain(label);
  expect(options).toHaveLength(AUDIT_ACTIONS.length + 1);
});

it("labels are past tense, and every lock op reads the same", () => {
  expect(actionPhrase("delete.revoke_pending")).toBe(
    "waited to revoke Google access",
  );
  expect(actionPhrase("owner_token.lost_lease")).toBe("lost its lock");
  expect(actionPhrase("owner-token.aborted")).toBe("stopped partway");
  expect(actionPhrase("oauth_store.mode_live")).toBe(
    "switched where agent sign-ins are stored",
  );
});
