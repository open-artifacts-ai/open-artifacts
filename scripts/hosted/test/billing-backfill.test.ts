// SS1e: `oa:hosted billing-backfill` against provision's in-memory Cloudflare.
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { type Env, platformNames, TRIAL_MS } from "@oa/provision";
import { describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.ts";
import { ACTOR, NOW, PUB, world } from "./world.ts";

const G = vi.hoisted(() => ({
  RELEASE_PUBKEY: { staging: "", prod: "" } as Record<string, string>,
}));
vi.mock("../../../packages/provision/src/internal/gates.ts", async (orig) => {
  const m = (await orig()) as Record<string, unknown>;
  return {
    ...m,
    PROD_UNLOCKED: true,
    FLOOR_MIN_SEQ: { staging: 1, prod: 1 },
    get RELEASE_PUBKEY() {
      return G.RELEASE_PUBKEY;
    },
  };
});
G.RELEASE_PUBKEY = { staging: PUB, prod: PUB };

const BILLING_SQL = readFileSync(
  new URL("../../../apps/billing/migrations/0001_init.sql", import.meta.url),
  "utf8",
);

type Row = { id: string; slug: string; state: string; vars: string | null };
const ROWS: Row[] = [
  { id: "iaaaaaaaaaa1", slug: "free1", state: "active", vars: "{}" },
  {
    id: "iaaaaaaaaaa2",
    slug: "team1",
    state: "active",
    vars: '{"TIER":"team"}',
  },
  {
    id: "iaaaaaaaaaa3",
    slug: "biz1",
    state: "active",
    vars: '{"TIER":"business","AUTH_PROVIDERS":"email"}',
  },
  {
    id: "iaaaaaaaaaa4",
    slug: "trial1",
    state: "active",
    vars: '{"TIER":"trial"}',
  },
  { id: "iaaaaaaaaaa5", slug: "gone1", state: "deleted", vars: "{}" },
  { id: "iaaaaaaaaaa6", slug: "new1", state: "creating", vars: null },
  // Already has a row (a trial started from the dashboard): never touched.
  {
    id: "iaaaaaaaaaa7",
    slug: "had1",
    state: "active",
    vars: '{"TIER":"team"}',
  },
];
const EXISTING = {
  install_id: "iaaaaaaaaaa7",
  tier: "trial",
  status: "past_due",
  trial_ends_at: 123,
  grace_until: 456,
  stripe_customer_id: "cus_x",
  stripe_subscription_id: "sub_x",
  version: 9,
  last_read_at: 7,
  updated_at: 8,
  last_event_created: 10,
  last_invoice_created: 11,
};

function backfillWorld(o: { env?: Env; ci?: boolean; billing?: boolean } = {}) {
  const w = world(o);
  const env = w.env;
  const bid =
    o.billing === false
      ? ""
      : w.fake.seedD1(platformNames(env).billing, BILLING_SQL);
  const bdb = () => (w.fake.d1.get(bid) as { db: DatabaseSync }).db;
  ROWS.forEach((r, k) => {
    w.db()
      .prepare(
        "INSERT INTO installs (id, slug, app_host, content_host, owner_email, rl_ns, inputs_hash, state, vars, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'h', ?, ?, ?, ?)",
      )
      .run(
        r.id,
        r.slug,
        `${r.slug}.app.test`,
        `${r.slug}.content.test`,
        "o@x.test",
        1_000_000 + 8 * k,
        r.state,
        r.vars,
        NOW,
        NOW,
      );
  });
  if (o.billing !== false) {
    const cols = Object.keys(EXISTING);
    bdb()
      .prepare(
        `INSERT INTO tiers (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
      )
      .run(...Object.values(EXISTING));
  }
  const tiers = () =>
    bdb()
      .prepare("SELECT * FROM tiers ORDER BY install_id")
      .all() as (typeof EXISTING)[];
  const perInstall = () =>
    w.audit().filter((a) => a.action === "cli.billing-backfill.install");
  return { ...w, tiers, perInstall };
}

const run = (w: { deps: Parameters<typeof main>[1] }, ...extra: string[]) =>
  main(["billing-backfill", "--env", "staging", ...extra], w.deps);

const row = (
  install_id: string,
  tier: string,
  trial_ends_at: number | null = null,
) => ({
  install_id,
  tier,
  status: "active",
  trial_ends_at,
  grace_until: null,
  stripe_customer_id: null,
  stripe_subscription_id: null,
  version: 1,
  last_read_at: null,
  updated_at: NOW,
  last_event_created: null,
  last_invoice_created: null,
});
const WANT = [
  row("iaaaaaaaaaa1", "free"),
  row("iaaaaaaaaaa2", "team"),
  row("iaaaaaaaaaa3", "business"),
  row("iaaaaaaaaaa4", "trial", NOW + TRIAL_MS),
  EXISTING,
];

describe("billing-backfill", () => {
  it("--dry-run prints the plan (install, slug, tier) and writes nothing", async () => {
    const w = backfillWorld();
    const before = w.tiers();
    expect(await run(w, "--dry-run")).toBe(0);
    const plan = w.parsed().filter((l) => l.step === "plan");
    expect(plan.map((l) => l.data)).toEqual([
      {
        install: "iaaaaaaaaaa1",
        slug: "free1",
        tier: "free",
        action: "write",
      },
      {
        install: "iaaaaaaaaaa2",
        slug: "team1",
        tier: "team",
        action: "write",
      },
      {
        install: "iaaaaaaaaaa3",
        slug: "biz1",
        tier: "business",
        action: "write",
      },
      {
        install: "iaaaaaaaaaa4",
        slug: "trial1",
        tier: "trial",
        action: "write",
      },
      {
        install: "iaaaaaaaaaa5",
        slug: "gone1",
        tier: null,
        action: "skip",
        reason: "state deleted",
      },
      {
        install: "iaaaaaaaaaa6",
        slug: "new1",
        tier: null,
        action: "skip",
        reason: "state creating",
      },
      {
        install: "iaaaaaaaaaa7",
        slug: "had1",
        tier: "team",
        action: "present",
      },
    ]);
    expect(w.parsed().find((l) => l.step === "billing-backfill")).toMatchObject(
      {
        status: "ok",
        data: { dryRun: true, planned: 4, written: 0, present: 1, skipped: 2 },
      },
    );
    expect(w.tiers()).toEqual(before);
    expect(w.perInstall()).toEqual([]);
    expect(
      w.fake.raw.some((x) => String(x.body).includes("INSERT INTO tiers")),
    ).toBe(false);
  });

  it("writes one row per active install with none: tier from TIER, trial gets an end, existing rows untouched", async () => {
    const w = backfillWorld();
    expect(await run(w)).toBe(0);
    expect(w.tiers()).toEqual(WANT);
    expect(w.parsed().find((l) => l.step === "billing-backfill")).toMatchObject(
      {
        status: "ok",
        data: { dryRun: false, planned: 0, written: 4, present: 1, skipped: 2 },
      },
    );
    const skipped = w
      .parsed()
      .filter((l) => l.step === "backfill" && l.data.action === "skip")
      .map((l) => [l.data.install, l.data.reason]);
    expect(skipped).toEqual([
      ["iaaaaaaaaaa5", "state deleted"],
      ["iaaaaaaaaaa6", "state creating"],
    ]);
    // An audit row per install, between the command's start and done rows.
    const a = w.audit();
    expect(a.at(0)).toMatchObject({
      action: "cli.billing-backfill.start",
      install_id: "-",
    });
    expect(a.at(-1)).toMatchObject({
      action: "cli.billing-backfill.done",
      install_id: "-",
    });
    expect(w.perInstall()).toEqual(
      ROWS.map((r) => ({
        actor: ACTOR,
        install_id: r.id,
        action: "cli.billing-backfill.install",
      })),
    );
  });

  it("a second run writes nothing", async () => {
    const w = backfillWorld();
    expect(await run(w)).toBe(0);
    const once = w.tiers();
    w.lines.length = 0;
    expect(await run(w)).toBe(0);
    expect(w.tiers()).toEqual(once);
    expect(w.parsed().find((l) => l.step === "billing-backfill")).toMatchObject(
      { data: { written: 0, present: 5, skipped: 2 } },
    );
  });

  it("a row that appears between the read and the write is left as it is", async () => {
    const w = backfillWorld();
    const real = w.deps.cf;
    w.deps.cf = (c) => {
      const cf = real(c);
      return {
        ...cf,
        d1Query: async (id, sql, params) => {
          if (
            sql.startsWith("INSERT INTO tiers") &&
            params?.[0] === "iaaaaaaaaaa2"
          )
            await cf.d1Query(
              id,
              "INSERT INTO tiers (install_id, tier, status, version, updated_at) VALUES ('iaaaaaaaaaa2', 'trial', 'active', 3, 1)",
            );
          return cf.d1Query(id, sql, params);
        },
      };
    };
    expect(await run(w)).toBe(0);
    expect(
      w.tiers().find((t) => t.install_id === "iaaaaaaaaaa2"),
    ).toMatchObject({ tier: "trial", version: 3 });
    expect(w.parsed().find((l) => l.step === "billing-backfill")).toMatchObject(
      { data: { written: 3, present: 2 } },
    );
  });

  it("an install whose stored TIER or vars can't be read is skipped, never written as free", async () => {
    const w = backfillWorld();
    w.db()
      .prepare("UPDATE installs SET vars = ? WHERE id = ?")
      .run('{"TIER":"gold"}', "iaaaaaaaaaa1");
    w.db()
      .prepare("UPDATE installs SET vars = NULL WHERE id = ?")
      .run("iaaaaaaaaaa2");
    expect(await run(w)).toBe(0);
    const ids = w.tiers().map((t) => t.install_id);
    expect(ids).not.toContain("iaaaaaaaaaa1");
    expect(ids).not.toContain("iaaaaaaaaaa2");
    const why = Object.fromEntries(
      w
        .parsed()
        .filter((l) => l.step === "backfill" && l.data.action === "skip")
        .map((l) => [l.data.install, l.data.reason]),
    );
    expect(why).toMatchObject({
      iaaaaaaaaaa1: "unknown TIER",
      iaaaaaaaaaa2: "no stored vars",
    });
  });

  it("no billing D1: refused, nothing written", async () => {
    const w = backfillWorld({ billing: false });
    expect(await run(w)).toBe(1);
    expect(
      w.parsed().find((l) => l.step === "billing-backfill")?.message,
    ).toMatch(/billing D1 oa-s-billing not found/);
    expect(w.perInstall()).toEqual([]);
  });

  it("prod is refused in CI (outside the gated laptop path), before any call", async () => {
    const w = backfillWorld({ env: "prod", ci: true });
    const before = w.tiers();
    expect(await main(["billing-backfill", "--env", "prod"], w.deps)).toBe(1);
    expect(w.parsed().at(-1)).toMatchObject({ step: "token", status: "error" });
    expect(w.parsed().at(-1)?.message).toMatch(/staging only/);
    expect(w.fake.log).toEqual([]);
    expect(w.tiers()).toEqual(before);
  });

  it("prod on a laptop is refused: prod runs in CI only", async () => {
    const w = backfillWorld({ env: "prod" });
    const before = w.tiers();
    expect(await main(["billing-backfill", "--env", "prod"], w.deps)).toBe(1);
    expect(
      w.parsed().find((l) => l.step === "billing-backfill")?.message,
    ).toMatch(/runs on prod in CI only/);
    expect(w.tiers()).toEqual(before);
    expect(w.perInstall()).toEqual([]);
    expect(
      w.fake.raw.some((x) => String(x.body).includes("INSERT INTO tiers")),
    ).toBe(false);
  });

  it("staging still runs from a laptop", async () => {
    const w = backfillWorld();
    expect(w.deps.env.CI).toBeUndefined();
    expect(await run(w)).toBe(0);
    expect(w.tiers()).toEqual(WANT);
  });

  it("flag refusals: --dry-run elsewhere, --install here", async () => {
    const w = backfillWorld();
    expect(
      await main(
        [
          "status",
          "--env",
          "staging",
          "--install",
          "iaaaaaaaaaa1",
          "--dry-run",
        ],
        w.deps,
      ),
    ).toBe(1);
    expect(w.parsed().at(-1)?.message).toMatch(
      /--dry-run is for billing-backfill only/,
    );
    expect(await run(w, "--install", "iaaaaaaaaaa1")).toBe(1);
    expect(w.parsed().at(-1)?.message).toMatch(/takes no --install/);
    expect(w.fake.log).toEqual([]);
  });
});
