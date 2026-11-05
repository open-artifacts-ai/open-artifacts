// #1293: the bus pages: data layer, gate, Agents (sidebar), Settings ›
// Machines and the Settings › Connections rename.
import { type BusAgent, type Me, R } from "@oa/shared";
import { createHandlers, fixtures } from "@oa/shared/mocks";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { ApiClientError } from "../src/api/client";
import { BUS_POLL_MS, qk } from "../src/api/queries";
import { canUseBus } from "../src/bus/access";
import { dayTime, shortDate } from "../src/bus/format";
import {
  liveOn,
  machineStatus,
  machinesSummary,
  REVOKE_ONLY_LINE,
  revokeFailedLine,
  revokePartialLine,
} from "../src/bus/Machines";
import {
  buildRail,
  globalsFrom,
  globalsLine,
  inScope,
  listOf,
  parseNamespace,
  parseScope,
  scopeParam,
  shortName,
} from "../src/bus/namespaces";
import { pending, roleError } from "../src/bus/Roles";
import { addressesOf, togglePick } from "../src/bus/ShareNotices";
import { CONNECTIONS_INTRO } from "../src/settings/Agents";
import {
  calls,
  findVisibleToast,
  installHarness,
  lastClient,
  mount,
  server,
} from "./harness";

installHarness();

const M = fixtures.busMachines;
const [work, home, old] = M as [
  (typeof M)[number],
  (typeof M)[number],
  (typeof M)[number],
];
const A = fixtures.busAgents;
const OA = "github.com/open-artifacts-ai/open-artifacts";
const agentNamed = (n: string) => A.find((a) => a.name === n) as BusAgent;

/** The bus mocks, with `me` rewriting their /me. */
const withBus = (me?: (m: Me) => Me) => {
  server.use(...createHandlers({ bus: true }));
  if (me)
    server.use(
      http.get("*/api/v1/me", () =>
        HttpResponse.json(
          me({ ...fixtures.me, canConnect: true, busOn: true } satisfies Me),
        ),
      ),
    );
};
const primary = () => screen.findByRole("navigation", { name: "Primary" });
const settingsTabs = () =>
  screen.findByRole("navigation", { name: "Settings sections" });

// ---------------------------------------------------------------- units

describe("canUseBus", () => {
  it.each([
    [{ canConnect: true, busOn: true }, true],
    [{ canConnect: true, busOn: false }, false],
    [{ canConnect: false, busOn: true }, false],
    [{ canConnect: true }, false],
    [{ busOn: true }, false],
    [{}, false],
  ])("%j -> %s", (extra, want) => {
    expect(canUseBus({ ...fixtures.me, ...extra })).toBe(want);
  });
  it("null or undefined -> false", () => {
    expect(canUseBus(null)).toBe(false);
    expect(canUseBus(undefined)).toBe(false);
  });
});

describe("namespaces", () => {
  it("parseNamespace: github drops its host, another host keeps it, one segment is a folder", () => {
    expect(parseNamespace(OA)).toEqual({
      kind: "repo",
      ns: OA,
      owner: "open-artifacts-ai",
      repo: "open-artifacts",
    });
    expect(parseNamespace("gitlab.com/acme/tools/cli")).toMatchObject({
      owner: "gitlab.com/acme",
      repo: "tools/cli",
    });
    expect(parseNamespace("notes")).toEqual({ kind: "folder", ns: "notes" });
  });
  it("shortName: the repo, or owner/repo when another owner has that repo name", () => {
    const a = "github.com/acme/web";
    const b = "github.com/beta/web";
    expect(shortName(a, [a])).toBe("web");
    expect(shortName(a, [a, b])).toBe("acme/web");
    expect(shortName("notes", [a, "notes"])).toBe("notes");
  });
  it("buildRail: orgs A to Z with live counts, folders with their machines, global agents once under Everywhere", () => {
    const r = buildRail(A);
    expect(r.all).toEqual({ total: A.length, live: 6 });
    expect(r.orgs.map((o) => [o.owner, o.total])).toEqual([
      ["leourbina", 1],
      ["open-artifacts-ai", 4],
    ]);
    expect(
      r.orgs[1]?.namespaces.map((n) => [n.label, n.total, n.live]),
    ).toEqual([
      ["open-artifacts", 3, 2],
      ["open-bus", 1, 1],
    ]);
    const notes = r.folders.namespaces.find((n) => n.ns === "notes");
    expect(notes?.machines).toEqual(["home-desktop", "leo-work"]);
    expect(r.folders.namespaces.map((n) => n.ns)).toEqual(["notes"]);
    expect(r.global.total).toBe(1);
    // The global agent's home (open-artifacts) doesn't count it.
    expect(agentNamed("memory")).toMatchObject({ global: true, namespace: OA });
    const counted = [
      ...r.orgs.flatMap((o) => o.namespaces),
      ...r.folders.namespaces,
    ].reduce((n, x) => n + x.total, 0);
    expect(counted).toBe(A.length - 1);
  });
  it("scopes round-trip through ?in= and filter agents", () => {
    for (const s of ["org:leourbina", `ns:${OA}`, "folders", "global"])
      expect(scopeParam(parseScope(s))).toBe(s);
    expect(parseScope("org:")).toEqual({ kind: "all" });
    expect(parseScope(undefined)).toEqual({ kind: "all" });
    const pi = agentNamed("pi-2");
    expect(inScope(pi, { kind: "folders" })).toBe(true);
    expect(inScope(pi, { kind: "org", owner: "leourbina" })).toBe(false);
    const mem = agentNamed("memory");
    expect(inScope(mem, { kind: "global" })).toBe(true);
    expect(inScope(mem, { kind: "all" })).toBe(true);
    expect(inScope(mem, { kind: "ns", ns: OA })).toBe(false);
    expect(inScope(mem, { kind: "org", owner: "open-artifacts-ai" })).toBe(
      false,
    );
  });
  it("globalsLine: exact copy, singular and plural; none is empty", () => {
    expect(globalsLine(0)).toBe("");
    expect(globalsLine(1)).toBe(
      "1 global agent started here is listed under Everywhere.",
    );
    expect(globalsLine(3)).toBe(
      "3 global agents started here are listed under Everywhere.",
    );
    expect(globalsFrom(A, OA)).toBe(1);
    expect(globalsFrom(A, "notes")).toBe(0);
  });
  it("listOf joins with and", () => {
    expect(listOf(["a"])).toBe("a");
    expect(listOf(["a", "b"])).toBe("a and b");
    expect(listOf(["a", "b", "c"])).toBe("a, b and c");
  });
});

describe("format", () => {
  const now = Date.parse("2026-11-05T15:00:00");
  it("dayTime: today at a time, else a short date at a time", () => {
    expect(dayTime("2026-11-05T09:41:00", now)).toBe("today at 9:41 AM");
    expect(dayTime("2026-11-02T18:10:00", now)).toBe("Nov 2 at 6:10 PM");
  });
  it("shortDate: the year only when it isn't this one", () => {
    expect(shortDate("2026-10-21T10:00:00", now)).toBe("Oct 21");
    expect(shortDate("2025-10-21T10:00:00", now)).toBe("Oct 21, 2025");
  });
});

describe("machines helpers", () => {
  it("machineStatus: Revoked wins, then Unknown, Live, Offline", () => {
    expect(machineStatus(work)).toBe("Live");
    expect(machineStatus(home)).toBe("Offline");
    expect(machineStatus(old)).toBe("Revoked");
    expect(machineStatus({ ...work, connected: null })).toBe("Unknown");
  });
  it("liveOn: live agents on the machine; unknown is null; revoked is 0", () => {
    expect(liveOn(work, A)).toBe(
      A.filter((a) => a.machineId === work.id && a.state === "live").length,
    );
    expect(liveOn(home, A)).toBe(0);
    expect(liveOn(work, undefined)).toBeNull();
    expect(liveOn({ ...work, connected: null }, A)).toBeNull();
    expect(liveOn(old, A)).toBe(0);
  });
  it("machinesSummary counts live machines only", () => {
    expect(machinesSummary(M)).toBe("1 live");
  });
});

describe("share-notice helpers", () => {
  it("addressesOf: one per address, with every machine it runs on", () => {
    const a = agentNamed("planner");
    const twin = { ...a, id: "x", machineLabel: "home-desktop" };
    expect(addressesOf([a, twin])).toEqual([
      {
        namespace: a.namespace,
        name: a.name,
        machines: ["leo-work", "home-desktop"],
      },
    ]);
  });
  it("togglePick: adds once (the address only), removes by address", () => {
    const a = { namespace: "n", name: "a" };
    const b = { namespace: "n", name: "b" };
    expect(togglePick([a], a, true)).toEqual([a]);
    expect(togglePick([a], { ...b, machines: ["m"] } as never, true)).toEqual([
      a,
      b,
    ]);
    expect(togglePick([a, b], { ...a }, false)).toEqual([b]);
  });
});

describe("roles helpers", () => {
  it("roleError maps each 409 reason, a 400, and anything else", () => {
    const e = (reason: string) =>
      new ApiClientError("conflict", "x", 409, { reason });
    expect(roleError(e("name_taken"))).toMatch(/taken/);
    expect(roleError(e("agent_not_open"))).toMatch(/isn't open/);
    expect(roleError(e("role_limit"))).toMatch(/most roles/);
    expect(roleError(e("no_bus"))).toBe("Connect a machine first.");
    expect(roleError(new ApiClientError("bad_request", "x", 400))).toMatch(
      /lowercase/,
    );
    expect(roleError(new Error("boom"))).toBe("That didn't save. Try again.");
  });
  it("pending: only pending proposals whose link still works", () => {
    const p = fixtures
      .busRoleProposals[0] as (typeof fixtures.busRoleProposals)[number];
    const now = Date.parse(p.createdAt);
    expect(pending([p], now)).toHaveLength(1);
    expect(pending([p], Date.parse(p.expiresAt) + 1)).toHaveLength(0);
    expect(pending([{ ...p, status: "applied" }], now)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- gate

const guest = (m: Me): Me => ({
  ...m,
  canConnect: false,
  user: { ...m.user, role: "guest" },
});
const capped = (m: Me): Me => ({ ...m, canConnect: false });

describe("gate: nothing unless canConnect and busOn (capped: revoke-only Machines)", () => {
  const denied: [string, ((m: Me) => Me) | null][] = [
    ["bus off (default mocks)", null],
    ["busOn false", (m) => ({ ...m, busOn: false })],
    [
      "older server (neither field)",
      ({ canConnect: _c, busOn: _b, ...m }) => m,
    ],
  ];
  for (const path of ["/agents", "/agents/roles", "/settings/machines"])
    it(`a guest: ${path} is Not found and asks nothing of the bus`, async () => {
      withBus(guest);
      const seen = calls("GET");
      mount(path);
      expect(
        await screen.findByRole("heading", { name: "Page not found" }),
      ).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "Agents" })).toBeNull();
      expect(screen.queryByRole("link", { name: "Machines" })).toBeNull();
      expect(seen.filter((c) => c.path.startsWith("/api/v1/bus/"))).toEqual([]);
    });

  for (const path of ["/agents", "/agents/roles"])
    it(`a capped member: ${path} is Not found and asks nothing of the bus`, async () => {
      withBus(capped);
      const seen = calls("GET");
      mount(path);
      expect(
        await screen.findByRole("heading", { name: "Page not found" }),
      ).toBeInTheDocument();
      const nav = await primary();
      expect(within(nav).queryByRole("link", { name: "Agents" })).toBeNull();
      expect(
        seen.filter(
          (c) => c.path.startsWith("/api/v1/bus/") && c.path !== R.busMachines,
        ),
      ).toEqual([]);
    });

  it("a capped member with no machine left: no Machines tab, and Not found", async () => {
    withBus(capped);
    server.use(
      http.get(`*${R.busMachines}`, () =>
        HttpResponse.json({ machines: [old] }),
      ),
    );
    mount("/settings/machines");
    expect(
      await screen.findByRole("heading", { name: "Page not found" }),
    ).toBeInTheDocument();
    const tabs = await settingsTabs();
    await within(tabs).findByRole("link", { name: "Profile" });
    expect(within(tabs).queryByRole("link", { name: "Machines" })).toBeNull();
  });

  for (const [name, me] of denied) {
    for (const path of ["/agents", "/agents/roles", "/settings/machines"])
      it(`${name}: ${path} is Not found and asks nothing of the bus`, async () => {
        if (me) withBus(me);
        const seen = calls("GET");
        mount(path);
        expect(
          await screen.findByRole("heading", { name: "Page not found" }),
        ).toBeInTheDocument();
        const nav = await primary();
        expect(within(nav).queryByRole("link", { name: "Agents" })).toBeNull();
        expect(screen.queryByRole("link", { name: "Machines" })).toBeNull();
        expect(seen.filter((c) => c.path.startsWith("/api/v1/bus/"))).toEqual(
          [],
        );
      });
    it(`${name}: no Machines tab in Settings`, async () => {
      if (me) withBus(me);
      mount("/settings/profile");
      const tabs = await settingsTabs();
      expect(
        await within(tabs).findByRole("link", { name: "Profile" }),
      ).toBeInTheDocument();
      expect(within(tabs).queryByRole("link", { name: "Machines" })).toBeNull();
    });
  }

  it("allowed: an Agents sidebar link, and Machines right after Connections in Settings", async () => {
    withBus();
    mount("/settings/profile");
    const nav = await primary();
    const agentsLink = await within(nav).findByRole("link", { name: "Agents" });
    expect(agentsLink).toHaveAttribute("href", "/agents");
    // Design's icon: Lucide "radio" at 16px with a 1.5px stroke.
    const svg = agentsLink.querySelector("svg.lucide-radio");
    expect(svg).not.toBeNull();
    expect(svg).toHaveAttribute("width", "16");
    expect(within(nav).queryByRole("link", { name: "Machines" })).toBeNull();
    const tabs = await settingsTabs();
    await within(tabs).findByRole("link", { name: "Machines" });
    const names = within(tabs)
      .getAllByRole("link")
      .map((l) => l.textContent);
    expect(names.indexOf("Machines")).toBe(names.indexOf("Connections") + 1);
    expect(
      within(tabs).getByRole("link", { name: "Machines" }),
    ).toHaveAttribute("href", "/settings/machines");
  });
});

// ---------------------------------------------------------------- Connections

describe("Settings › Connections (formerly Agents)", () => {
  it("is the tab's name, with Design's intro line", async () => {
    mount("/settings/connections");
    const tabs = await settingsTabs();
    expect(
      await within(tabs).findByRole("link", { name: "Connections" }),
    ).toHaveAttribute("aria-current", "page");
    expect(within(tabs).queryByRole("link", { name: "Agents" })).toBeNull();
    expect(await screen.findByText(CONNECTIONS_INTRO)).toBeInTheDocument();
    expect(CONNECTIONS_INTRO).toBe(
      "Connect an agent, and see the apps and tokens that act as you. Revoke any you don't recognize.",
    );
  });
  it("the old /settings/agents redirects, keeping its hash", async () => {
    const router = mount("/settings/agents#created-token");
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/settings/connections"),
    );
    expect(router.state.location.hash).toBe("created-token");
    expect(
      await screen.findByRole("heading", { name: "Personal access tokens" }),
    ).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------- Machines

describe("Settings › Machines", () => {
  const table = () => screen.findByRole("table", { name: "Your machines" });
  const n = liveOn(work, A) as number;

  it("lists machines: status, live agents, Last used (Never), revoked rows with a date and no Revoke", async () => {
    withBus();
    mount("/settings/machines");
    const rows = () =>
      within(screen.getByRole("table", { name: "Your machines" }))
        .getAllByRole("row")
        .slice(1);
    await table();
    await waitFor(() =>
      expect(rows()[0]).toHaveTextContent(`${work.label}Live${n}`),
    );
    expect(rows()[1]).toHaveTextContent(`${home.label}OfflineNoneNever`);
    expect(rows()[2]).toHaveTextContent(/old-laptopRevoked \w+ \d+/);
    expect(
      screen.queryByRole("button", { name: `Revoke ${old.label}` }),
    ).toBeNull();
    expect(screen.getByText("1 live")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Connect a machine" }),
    ).toHaveAttribute("href", "/bus/approve");
  });

  it("polls every BUS_POLL_MS", async () => {
    withBus();
    mount("/settings/machines");
    await table();
    const q = lastClient.getQueryCache().find({ queryKey: qk.busMachines });
    expect(BUS_POLL_MS).toBe(10_000);
    const opts = q?.options as { refetchInterval?: unknown } | undefined;
    expect(opts?.refetchInterval).toBe(BUS_POLL_MS);
  });

  it("Revoke: the dialog names its live agents; Revoke sends DELETE, toasts, and the row reloads revoked", async () => {
    withBus();
    const sent = calls("DELETE");
    mount("/settings/machines");
    const t = await table();
    await waitFor(() =>
      expect(within(t).getAllByRole("row")[1]).toHaveTextContent(
        `${work.label}Live${n}`,
      ),
    );
    fireEvent.click(
      screen.getByRole("button", { name: `Revoke ${work.label}` }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent(`Revoke "${work.label}"?`);
    expect(dialog).toHaveTextContent(
      `Its connection closes at once and its ${n} live agents leave the list. Messages to them are refused. This can't be undone.`,
    );
    expect(
      within(dialog).getByRole("button", { name: "Cancel" }),
    ).toHaveFocus();
    fireEvent.click(within(dialog).getByRole("button", { name: "Revoke" }));
    await waitFor(() =>
      expect(sent.map((c) => c.path)).toEqual([R.busMachine(work.id)]),
    );
    await findVisibleToast(`${work.label} revoked.`);
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: `Revoke ${work.label}` }),
      ).toBeNull(),
    );
  });

  /** DELETE answers 500; `revokes` says whether it revoked first (the list then shows it). */
  const failingRevoke = (revokes: boolean) => {
    const rows = M.map((m) => ({ ...m }));
    server.use(
      http.get(`*${R.busMachines}`, () =>
        HttpResponse.json({ machines: rows }),
      ),
      http.delete(`*${R.busMachines}/:id`, ({ params }) => {
        const row = rows.find((m) => m.id === params.id);
        if (revokes && row) {
          row.revokedAt = new Date().toISOString();
          row.connected = false;
        }
        return HttpResponse.json(
          {
            error: {
              code: "internal",
              message:
                "The machine is revoked, but its connection could not be closed yet. Try again.",
            },
          },
          { status: 500 },
        );
      }),
    );
  };
  const revokeWork = async () => {
    mount("/settings/machines");
    await table();
    fireEvent.click(
      await screen.findByRole("button", { name: `Revoke ${work.label}` }),
    );
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Revoke",
      }),
    );
  };

  const MAYBE = `${work.label} may not be revoked yet, and its connection may still be open. Try again.`;

  it("the failed-revoke copy: Design's line, and the partial line", () => {
    expect(revokeFailedLine("leo-work")).toBe(
      "leo-work may not be revoked yet, and its connection may still be open. Try again.",
    );
    expect(revokePartialLine("leo-work")).toBe(
      "leo-work is revoked and can't reconnect, but its open connection didn't close. Try again to close it.",
    );
  });

  it("a 500 after the revoke landed (the reloaded list shows it revoked): the partial alert, and Try again reopens the dialog", async () => {
    withBus();
    failingRevoke(true);
    await revokeWork();
    expect(
      await screen.findByText(revokePartialLine(work.label)),
    ).toBeInTheDocument();
    expect(screen.queryByText(MAYBE)).toBeNull();
    expect(
      screen.queryByRole("button", { name: `Revoke ${work.label}` }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("alertdialog")).toHaveTextContent(
      `Revoke "${work.label}"?`,
    );
  });

  it("a 500 that revoked nothing: Design's notice with Try again, never 'is revoked'", async () => {
    withBus();
    failingRevoke(false);
    await revokeWork();
    expect(await screen.findByText(MAYBE)).toBeInTheDocument();
    expect(screen.queryByText(/is revoked and can't reconnect/)).toBeNull();
    expect(
      within(screen.getByRole("table", { name: "Your machines" })).getAllByRole(
        "row",
      )[1],
    ).toHaveTextContent(`${work.label}Live`);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("alertdialog")).toHaveTextContent(
      `Revoke "${work.label}"?`,
    );
  });

  it("a 4xx revoke that revoked nothing: the same notice, no toast", async () => {
    withBus();
    server.use(
      http.delete(`*${R.busMachines}/:id`, () =>
        HttpResponse.json(
          { error: { code: "not_found", message: "Not found" } },
          { status: 404 },
        ),
      ),
    );
    await revokeWork();
    expect(await screen.findByText(MAYBE)).toBeInTheDocument();
    expect(screen.queryByText(/Couldn't revoke/)).toBeNull();
  });

  it("a capped member: revoke-only, with the capped line, no Connect, no live agents, and no agents request", async () => {
    withBus(capped);
    const seen = calls("GET");
    const sent = calls("DELETE");
    mount("/settings/machines");
    const t = await table();
    expect(screen.getByText(REVOKE_ONLY_LINE)).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Connect a machine" }),
    ).toBeNull();
    expect(
      within(t)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).not.toContain("Live agents");
    const tabs = await settingsTabs();
    expect(
      await within(tabs).findByRole("link", { name: "Machines" }),
    ).toHaveAttribute("aria-current", "page");
    fireEvent.click(
      screen.getByRole("button", { name: `Revoke ${work.label}` }),
    );
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Revoke",
      }),
    );
    await waitFor(() =>
      expect(sent.map((c) => c.path)).toEqual([R.busMachine(work.id)]),
    );
    await findVisibleToast(`${work.label} revoked.`);
    expect(seen.some((c) => c.path === R.busAgents)).toBe(false);
  });

  it("live status unknown: the warning, Unknown, and a dash for live agents", async () => {
    withBus();
    server.use(
      http.get(`*${R.busMachines}`, () =>
        HttpResponse.json({ machines: [{ ...work, connected: null }] }),
      ),
      http.get(`*${R.busAgents}`, () =>
        HttpResponse.json({ agents: [], live: false }),
      ),
    );
    mount("/settings/machines");
    expect(
      await screen.findByText(
        "Live status isn't available right now. Reload to try again.",
      ),
    ).toBeInTheDocument();
    const row = within(await table()).getAllByRole("row")[1] as HTMLElement;
    expect(row).toHaveTextContent(`${work.label}Unknown—`);
  });

  it("empty: No machines yet, with the connect steps", async () => {
    withBus();
    server.use(
      http.get(`*${R.busMachines}`, () => HttpResponse.json({ machines: [] })),
    );
    mount("/settings/machines");
    expect(await screen.findByText("No machines yet")).toBeInTheDocument();
    // Design's line, exactly; nothing comes before it, so no leading "Or".
    expect(
      screen.getByText(
        (_, el) =>
          el?.tagName === "LI" &&
          el.textContent ===
            `Ask any AI agent to set up the Open Artifacts bus client and connect it to ${location.host}.`,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/oa-bus|say yes when it asks/)).toBeNull();
    expect(screen.getByRole("link", { name: "Enter a code" })).toHaveAttribute(
      "href",
      "/bus/approve",
    );
    expect(
      screen.queryByRole("link", { name: "Connect a machine" }),
    ).toBeNull();
  });

  it("a failed load: the error with Retry, which asks again", async () => {
    withBus();
    let calls = 0;
    server.use(
      http.get(`*${R.busMachines}`, () => {
        calls++;
        return HttpResponse.json(
          { error: { code: "internal", message: "boom" } },
          { status: 500 },
        );
      }),
    );
    mount("/settings/machines");
    expect(
      await screen.findByText("Couldn't load your machines."),
    ).toBeInTheDocument();
    const before = calls;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(calls).toBeGreaterThan(before));
  });
});

// ---------------------------------------------------------------- Agents

describe("Agents › Agents (the roster)", () => {
  const roster = () => screen.findByRole("table", { name: "Agents" });
  const rail = () => screen.findByRole("complementary", { name: "Namespaces" });

  it("the rail groups by org A to Z, then Other folders (with machines), then global", async () => {
    withBus();
    mount("/agents");
    const r = await rail();
    const links = within(r)
      .getAllByRole("link")
      .map((l) => l.textContent ?? "");
    expect(links[0]).toBe(`All agents${A.length}`);
    expect(links.indexOf("leourbina1")).toBeGreaterThan(0);
    expect(links.indexOf("leourbina1")).toBeLessThan(
      links.indexOf("open-artifacts-ai4"),
    );
    expect(links.indexOf("open-artifacts-ai4")).toBeLessThan(
      links.findIndex((t) => t.startsWith("Other folders")),
    );
    expect(links.at(-1)).toBe("global1");
    // Listed once, under Everywhere: no rail row of its own elsewhere.
    expect(links.filter((t) => t.startsWith("memory"))).toEqual([]);
    const notes = within(r).getByRole("link", { name: /^notes/ });
    expect(notes).toHaveTextContent("2 machines");
    expect(notes).toHaveTextContent("on home-desktop and leo-work");
  });

  it("all agents: name with its short namespace, badge, what the agent says, machine", async () => {
    withBus();
    mount("/agents");
    const rows = within(await roster())
      .getAllByRole("row")
      .slice(1);
    expect(rows).toHaveLength(A.length);
    const m = agentNamed("oa-manager");
    expect(rows[0]).toHaveTextContent(
      `${m.name} · open-artifactsLive${m.statusLabel}${m.machineLabel}`,
    );
    expect(
      screen.getByText("Live agents receive at once.", { exact: false }),
    ).toBeInTheDocument();
  });

  it("an org in the rail scopes the roster and its summary", async () => {
    withBus();
    mount("/agents");
    fireEvent.click(
      within(await rail()).getByRole("link", { name: "open-artifacts-ai4" }),
    );
    expect(
      await screen.findByRole("heading", { name: "open-artifacts-ai" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("2 namespaces · 3 live, 1 queued"),
    ).toBeInTheDocument();
    expect(
      within(await roster())
        .getAllByRole("row")
        .slice(1),
    ).toHaveLength(4);
  });

  it("a global agent's home namespace leaves it out and says where it is", async () => {
    withBus();
    mount(`/agents?in=${encodeURIComponent(`ns:${OA}`)}`);
    const rows = within(await roster())
      .getAllByRole("row")
      .slice(1);
    expect(rows.map((r) => r.textContent)).not.toContainEqual(
      expect.stringContaining("memory"),
    );
    expect(rows).toHaveLength(3);
    expect(
      screen.getByText(
        "1 global agent started here is listed under Everywhere.",
      ),
    ).toBeInTheDocument();
  });

  it("two global agents from one namespace: the plural line", async () => {
    withBus();
    const mem = agentNamed("memory");
    server.use(
      http.get(`*${R.busAgents}`, () =>
        HttpResponse.json({
          agents: [...A, { ...mem, id: "BaZ9nPqRsTu4vWxY", name: "memory-2" }],
          live: true,
        }),
      ),
    );
    mount(`/agents?in=${encodeURIComponent(`ns:${OA}`)}`);
    expect(
      await screen.findByText(
        "2 global agents started here are listed under Everywhere.",
      ),
    ).toBeInTheDocument();
    const r = await rail();
    expect(
      within(r).getByRole("link", { name: "global2" }),
    ).toBeInTheDocument();
  });

  it("Live and Queued filter the rows", async () => {
    withBus();
    mount("/agents");
    await roster();
    fireEvent.click(screen.getByRole("radio", { name: /^Queued/ }));
    await waitFor(() =>
      expect(
        within(screen.getByRole("table", { name: "Agents" }))
          .getAllByRole("row")
          .slice(1)
          .map((r) => r.textContent),
      ).toEqual(
        A.filter((a) => a.state === "queued").map((a) =>
          expect.stringContaining(a.name),
        ),
      ),
    );
  });

  it("Find a namespace filters the rail", async () => {
    withBus();
    mount("/agents");
    const r = await rail();
    fireEvent.change(
      within(r).getByRole("searchbox", { name: "Find a namespace" }),
      { target: { value: "bus" } },
    );
    expect(
      within(r).getByRole("link", { name: "open-bus1" }),
    ).toBeInTheDocument();
    expect(within(r).queryByRole("link", { name: "jobs-paris1" })).toBeNull();
    expect(within(r).queryByRole("link", { name: /^notes/ })).toBeNull();
  });

  it("live status down: the warning, nothing listed", async () => {
    withBus();
    server.use(
      http.get(`*${R.busAgents}`, () =>
        HttpResponse.json({ agents: [], live: false }),
      ),
    );
    mount("/agents");
    expect(
      await screen.findByText(
        "Live status isn't available right now. Reload to try again.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Agents" })).toBeNull();
  });

  it("no machine yet: Connect a machine first, with a link to Machines", async () => {
    withBus();
    server.use(
      http.get(`*${R.busAgents}`, () =>
        HttpResponse.json({ agents: [], live: true }),
      ),
      http.get(`*${R.busMachines}`, () => HttpResponse.json({ machines: [] })),
    );
    mount("/agents");
    expect(
      await screen.findByText("Connect a machine first."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Go to Machines" }),
    ).toHaveAttribute("href", "/settings/machines");
  });

  it("machines but nothing running: No agents running", async () => {
    withBus();
    server.use(
      http.get(`*${R.busAgents}`, () =>
        HttpResponse.json({ agents: [], live: true }),
      ),
    );
    mount("/agents");
    expect(await screen.findByText("No agents running")).toBeInTheDocument();
  });
});

describe("Agents › Namespaces", () => {
  it("lists each namespace with its org or its folder's machines", async () => {
    withBus();
    mount("/agents/namespaces");
    const t = await screen.findByRole("table", { name: "Namespaces" });
    expect(
      within(t).getByRole("link", { name: "open-artifacts" }),
    ).toHaveAttribute(
      "href",
      `/agents/namespaces?ns=${encodeURIComponent(OA)}`,
    );
    expect(t).toHaveTextContent("notesFolder on home-desktop and leo-work");
  });

  it("a repo namespace: full path, and its roles as sentences", async () => {
    withBus();
    mount(`/agents/namespaces?ns=${encodeURIComponent(OA)}`);
    expect(await screen.findByText(OA)).toBeInTheDocument();
    expect(
      screen.getByText("in open-artifacts-ai · 3 agents, 2 live"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "1 global agent started here is listed under Everywhere.",
      ),
    ).toBeInTheDocument();
    const roles = screen.getByRole("region", {
      name: "Roles in this namespace",
    });
    await waitFor(() =>
      expect(roles).toHaveTextContent("manager points at oa-manager."),
    );
  });

  it("a folder name on two machines: the shared-namespace warning, no rename command", async () => {
    withBus();
    mount("/agents/namespaces?ns=notes");
    expect(
      await screen.findByText(
        /on 2 machines share this namespace, so their agents can see each other/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("on home-desktop and leo-work"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Give this folder its own name/)).toBeNull();
    expect(screen.queryByText(/listed under Everywhere/)).toBeNull();
  });
});

describe("Agents › Roles and access", () => {
  it("a pending proposal waits, pointing at the agent's link (no confirm here yet)", async () => {
    withBus();
    mount("/agents/roles");
    const w = await screen.findByRole("region", { name: "Waiting for you" });
    expect(w).toHaveTextContent(
      "Point manager in open-artifacts at oa-design (now oa-manager).",
    );
    expect(w).toHaveTextContent(
      "Open the link the agent gave you to confirm it.",
    );
    expect(within(w).queryByRole("button")).toBeNull();
  });

  it("roles show holder or Vacant; Remove confirms, then DELETEs", async () => {
    withBus();
    const sent = calls("DELETE");
    mount("/agents/roles");
    const t = await screen.findByRole("table", { name: "Roles" });
    expect(t).toHaveTextContent("manageroa-manageropen-artifacts");
    expect(t).toHaveTextContent("reviewerVacantopen-bus");
    fireEvent.click(screen.getByRole("button", { name: "Remove reviewer" }));
    const d = await screen.findByRole("alertdialog");
    fireEvent.click(within(d).getByRole("button", { name: "Remove" }));
    const id = fixtures.busRoles[1]?.id as string;
    await waitFor(() =>
      expect(sent.map((c) => c.path)).toEqual([R.busRole(id)]),
    );
  });

  it("Change holder PUTs the role at an agent open there", async () => {
    withBus();
    const sent = calls("PUT");
    mount("/agents/roles");
    fireEvent.click(
      await screen.findByRole("button", { name: "Change holder of manager" }),
    );
    const d = await screen.findByRole("dialog", {
      name: "Change holder of manager",
    });
    fireEvent.click(within(d).getByRole("combobox", { name: "Held by" }));
    fireEvent.click(
      await screen.findByRole("option", { name: "oa-design on leo-work" }),
    );
    fireEvent.click(within(d).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(sent.map((c) => c.body)).toEqual([
        {
          namespace: OA,
          name: "manager",
          agentId: agentNamed("oa-design").id,
        },
      ]),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("a refused PUT shows its plain line and keeps the dialog open", async () => {
    withBus();
    server.use(
      http.put(`*${R.busRoles}`, () =>
        HttpResponse.json(
          {
            error: {
              code: "conflict",
              message: "x",
              details: { reason: "name_taken" },
            },
          },
          { status: 409 },
        ),
      ),
    );
    mount("/agents/roles");
    fireEvent.click(
      await screen.findByRole("button", { name: "Change holder of manager" }),
    );
    const d = await screen.findByRole("dialog");
    fireEvent.click(within(d).getByRole("combobox", { name: "Held by" }));
    fireEvent.click(
      await screen.findByRole("option", { name: "oa-design on leo-work" }),
    );
    fireEvent.click(within(d).getByRole("button", { name: "Save" }));
    expect(await within(d).findByRole("alert")).toHaveTextContent(
      "That name is taken in this namespace. Pick another.",
    );
  });
});

describe("Agents › Share notices", () => {
  const card = () => screen.findByRole("region", { name: "Share notices" });

  it("none picked by default; ticking then Save PUTs the address, and the count follows", async () => {
    withBus();
    const sent = calls("PUT");
    mount("/agents/share-notices");
    const c = await card();
    expect(c).toHaveTextContent("0 of 10 picked");
    const save = within(c).getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    const m = agentNamed("oa-manager");
    fireEvent.click(
      within(c).getByRole("checkbox", { name: `${m.name} · open-artifacts` }),
    );
    expect(c).toHaveTextContent("1 of 10 picked");
    fireEvent.click(save);
    await waitFor(() =>
      expect(sent.map((x) => [x.path, x.body])).toEqual([
        [
          R.shareNotices,
          { agents: [{ namespace: m.namespace, name: m.name }] },
        ],
      ]),
    );
    await findVisibleToast("Share notices saved.");
  });

  it("a picked address not running: not running, Remove, and the dropped line", async () => {
    withBus();
    server.use(
      http.get(`*${R.shareNotices}`, () =>
        HttpResponse.json({ agents: [{ namespace: "notes", name: "old" }] }),
      ),
    );
    mount("/agents/share-notices");
    const c = await card();
    expect(await within(c).findByText(/old · notes/)).toBeInTheDocument();
    expect(c).toHaveTextContent(
      "Notes to agents that aren't running are dropped.",
    );
    fireEvent.click(
      within(c).getByRole("button", { name: "Remove old · notes" }),
    );
    expect(c).toHaveTextContent("0 of 10 picked");
    expect(within(c).getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("at 10 picked the other boxes disable", async () => {
    withBus();
    const ten = Array.from({ length: 10 }, (_, i) => ({
      namespace: "notes",
      name: `p${i}`,
    }));
    server.use(
      http.get(`*${R.shareNotices}`, () => HttpResponse.json({ agents: ten })),
    );
    mount("/agents/share-notices");
    const c = await card();
    await waitFor(() =>
      expect(c).toHaveTextContent(
        "10 of 10 picked. Remove one to pick another.",
      ),
    );
    for (const box of within(c).getAllByRole("checkbox"))
      expect(box).toBeDisabled();
  });

  it("live status down: remove-only, with the line", async () => {
    withBus();
    server.use(
      http.get(`*${R.busAgents}`, () =>
        HttpResponse.json({ agents: [], live: false }),
      ),
      http.get(`*${R.shareNotices}`, () =>
        HttpResponse.json({
          agents: [{ namespace: "notes", name: "planner" }],
        }),
      ),
    );
    mount("/agents/share-notices");
    const c = await card();
    expect(
      await within(c).findByText("Running agents can't be listed right now."),
    ).toBeInTheDocument();
    expect(within(c).queryByRole("checkbox")).toBeNull();
    expect(
      within(c).getByRole("button", { name: "Remove planner · notes" }),
    ).toBeInTheDocument();
  });
});
