// #1293: the bus data layer, its gate, and the placeholder pages.
import { type Me, R } from "@oa/shared";
import { createHandlers, fixtures } from "@oa/shared/mocks";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { BUS_POLL_MS, qk } from "../src/api/queries";
import { canUseBus } from "../src/bus/access";
import { addressesOf, togglePick } from "../src/bus/LiveAgents";
import { machineStatus } from "../src/bus/Machines";
import { calls, installHarness, lastClient, mount, server } from "./harness";

installHarness();

const [live, never, revoked] = fixtures.busMachines as [
  (typeof fixtures.busMachines)[number],
  (typeof fixtures.busMachines)[number],
  (typeof fixtures.busMachines)[number],
];
const [claude, pi] = fixtures.busAgents as [
  (typeof fixtures.busAgents)[number],
  (typeof fixtures.busAgents)[number],
];

/** The bus mocks, with `me` rewriting their /me. */
const withBus = (me?: (m: Me) => Me) => {
  const hs = createHandlers({ bus: true });
  server.use(...hs);
  if (me) {
    const base = {
      ...fixtures.me,
      canConnect: true,
      busOn: true,
    } satisfies Me;
    server.use(http.get("*/api/v1/me", () => HttpResponse.json(me(base))));
  }
};

const primary = () => screen.findByRole("navigation", { name: "Primary" });

describe("canUseBus", () => {
  const me = fixtures.me;
  it.each([
    [{ canConnect: true, busOn: true }, true],
    [{ canConnect: true, busOn: false }, false],
    [{ canConnect: false, busOn: true }, false],
    [{ canConnect: true }, false],
    [{ busOn: true }, false],
    [{}, false],
  ])("%j -> %s", (extra, want) => {
    expect(canUseBus({ ...me, ...extra })).toBe(want);
  });
  it("null or undefined -> false", () => {
    expect(canUseBus(null)).toBe(false);
    expect(canUseBus(undefined)).toBe(false);
  });
});

describe("helpers", () => {
  it("machineStatus: Revoked wins, then Unknown, Live, Offline", () => {
    expect(machineStatus(live)).toBe("Live");
    expect(machineStatus(never)).toBe("Offline");
    expect(machineStatus(revoked)).toBe("Revoked");
    expect(machineStatus({ ...live, connected: null })).toBe("Unknown");
    expect(machineStatus({ ...live, revokedAt: live.createdAt })).toBe(
      "Revoked",
    );
  });
  it("addressesOf: one per (namespace, name), in order", () => {
    expect(addressesOf([claude, pi, { ...claude, id: "other" }])).toEqual([
      { namespace: claude.namespace, name: claude.name },
      { namespace: pi.namespace, name: pi.name },
    ]);
  });
  it("togglePick: adds once, removes by address", () => {
    const a = { namespace: "n", name: "a" };
    const b = { namespace: "n", name: "b" };
    expect(togglePick([a], a, true)).toEqual([a]);
    expect(togglePick([a], b, true)).toEqual([a, b]);
    expect(togglePick([a, b], { ...a }, false)).toEqual([b]);
  });
});

describe("gate: no nav links and Not found unless canConnect and busOn", () => {
  const denied: [string, ((m: Me) => Me) | null][] = [
    ["bus off (default mocks)", null],
    ["busOn false", (m) => ({ ...m, busOn: false })],
    [
      "canConnect false (capped or guest)",
      (m) => ({ ...m, canConnect: false }),
    ],
    [
      "older server (neither field)",
      ({ canConnect: _c, busOn: _b, ...m }) => m,
    ],
  ];
  for (const [name, me] of denied)
    for (const path of ["/machines", "/agents"])
      it(`${name}: ${path}`, async () => {
        if (me) withBus(me);
        const seen = calls("GET");
        mount(path);
        expect(
          await screen.findByRole("heading", { name: "Page not found" }),
        ).toBeInTheDocument();
        const nav = await primary();
        expect(
          within(nav).queryByRole("link", { name: "Machines" }),
        ).toBeNull();
        expect(within(nav).queryByRole("link", { name: "Agents" })).toBeNull();
        // The page asks nothing of the bus.
        expect(seen.filter((c) => c.path.startsWith("/api/v1/bus/"))).toEqual(
          [],
        );
      });

  it("allowed: both nav links show", async () => {
    withBus();
    mount("/");
    const nav = await primary();
    expect(
      await within(nav).findByRole("link", { name: "Machines" }),
    ).toHaveAttribute("href", "/machines");
    expect(within(nav).getByRole("link", { name: "Agents" })).toHaveAttribute(
      "href",
      "/agents",
    );
  });
});

describe("/machines", () => {
  it("lists every machine with its status and Last used (Never when unused); revoked rows have no Revoke", async () => {
    withBus();
    mount("/machines");
    const list = await screen.findByRole("list", { name: "Your machines" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining(`${live.label} · Live`),
      expect.stringContaining(`${never.label} · Offline · Last used Never`),
      expect.stringContaining(`${revoked.label} · Revoked`),
    ]);
    expect(
      screen.queryByRole("button", { name: `Revoke ${revoked.label}` }),
    ).toBeNull();
  });

  it("polls every BUS_POLL_MS", async () => {
    withBus();
    mount("/machines");
    await screen.findByRole("list", { name: "Your machines" });
    const q = lastClient.getQueryCache().find({ queryKey: qk.busMachines });
    expect(BUS_POLL_MS).toBe(10_000);
    const opts = q?.options as { refetchInterval?: unknown } | undefined;
    expect(opts?.refetchInterval).toBe(BUS_POLL_MS);
  });

  it("Revoke confirms, sends DELETE, and the row reloads as Revoked", async () => {
    withBus();
    const sent = calls("DELETE");
    mount("/machines");
    fireEvent.click(
      await screen.findByRole("button", { name: `Revoke ${live.label}` }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent(`Revoke "${live.label}"?`);
    fireEvent.click(within(dialog).getByRole("button", { name: "Revoke" }));
    await waitFor(() =>
      expect(sent.map((c) => c.path)).toEqual([R.busMachine(live.id)]),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: `Revoke ${live.label}` }),
      ).toBeNull(),
    );
  });

  it("Cancel sends nothing", async () => {
    withBus();
    const sent = calls("DELETE");
    mount("/machines");
    fireEvent.click(
      await screen.findByRole("button", { name: `Revoke ${live.label}` }),
    );
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(sent).toEqual([]);
  });

  it("empty: No machines yet", async () => {
    withBus();
    server.use(
      http.get(`*${R.busMachines}`, () => HttpResponse.json({ machines: [] })),
    );
    mount("/machines");
    expect(await screen.findByText("No machines yet")).toBeInTheDocument();
  });

  it("a failed load says so, and Retry asks again", async () => {
    withBus();
    let n = 0;
    server.use(
      http.get(`*${R.busMachines}`, () => {
        n++;
        return HttpResponse.json(
          { error: { code: "internal", message: "boom" } },
          { status: 500 },
        );
      }),
    );
    mount("/machines");
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(screen.getByText(/Couldn't load your machines/)).toBeInTheDocument();
    await waitFor(() => expect(n).toBeGreaterThan(1));
  });
});

describe("/agents", () => {
  it("lists live agents with namespace, machine and state", async () => {
    withBus();
    mount("/agents");
    const list = await screen.findByRole("list", { name: "Live agents" });
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((r) => r.textContent),
    ).toEqual([
      `${claude.name} · ${claude.namespace} · ${claude.machineLabel} · Live`,
      `${pi.name} · ${pi.namespace} · ${pi.machineLabel} · Live`,
    ]);
  });

  it("share notices: none picked by default; checking one PUTs that address", async () => {
    withBus();
    const sent = calls("PUT");
    mount("/agents");
    const box = await screen.findByRole("checkbox", {
      name: `${claude.name} · ${claude.namespace}`,
    });
    expect(box).not.toBeChecked();
    fireEvent.click(box);
    await waitFor(() =>
      expect(sent.map((c) => [c.path, c.body])).toEqual([
        [
          R.shareNotices,
          { agents: [{ namespace: claude.namespace, name: claude.name }] },
        ],
      ]),
    );
    await waitFor(() => expect(box).toBeChecked());
  });

  it("a picked address with no running agent shows not running, with Remove", async () => {
    withBus();
    const gone = { namespace: "notes", name: "old" };
    const kept = { namespace: claude.namespace, name: claude.name };
    server.use(
      http.get(`*${R.shareNotices}`, () =>
        HttpResponse.json({ agents: [kept, gone] }),
      ),
    );
    const sent = calls("PUT");
    mount("/agents");
    expect(
      await screen.findByText(/old · notes · not running/),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Notes to agents that aren't running are dropped."),
    ).toBeInTheDocument();
    // The running pick shows checked in the picker, not repeated.
    expect(
      screen.getByRole("checkbox", {
        name: `${claude.name} · ${claude.namespace}`,
      }),
    ).toBeChecked();
    expect(screen.queryByText(/claude · .* · not running/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove old · notes" }));
    await waitFor(() =>
      expect(sent.map((c) => c.body)).toEqual([{ agents: [kept] }]),
    );
  });

  it("the bus couldn't be asked (live false): says so", async () => {
    withBus();
    server.use(
      http.get(`*${R.busAgents}`, () =>
        HttpResponse.json({ agents: [], live: false }),
      ),
    );
    mount("/agents");
    expect(
      await screen.findByText("Couldn't reach your bus just now."),
    ).toBeInTheDocument();
    expect(screen.getByText("No agents running")).toBeInTheDocument();
  });
});
