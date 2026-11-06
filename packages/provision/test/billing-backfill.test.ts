// The billing backfill (SS1e) against real SQLite for both D1s: the platform
// installs table and the billing tiers table (apps/billing's 0001_init.sql).
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { billingBackfill } from "../src/billing-backfill.js";
import { cfClient } from "../src/cf.js";
import { platformNames, TRIAL_MS } from "../src/names.js";
import { FakeCf } from "./fake-cf.js";
import { install } from "./platform-db.js";

const ROOT = new URL("../../../", import.meta.url);
const PLATFORM_SQL = readdirSync(new URL("apps/platform-db/migrations/", ROOT))
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) =>
    readFileSync(new URL(`apps/platform-db/migrations/${f}`, ROOT), "utf8"),
  )
  .join("\n");
const BILLING_SQL = readFileSync(
  new URL("apps/billing/migrations/0001_init.sql", ROOT),
  "utf8",
);
const NOW = 1_800_000_000_000;

function world() {
  const fake = new FakeCf({ now: NOW });
  const names = platformNames("staging");
  const platformId = fake.seedD1(names.db, PLATFORM_SQL);
  const billingId = fake.seedD1(names.billing, BILLING_SQL);
  const cf = cfClient({
    accountId: fake.accountId,
    token: fake.token,
    fetch: fake.fetch,
    sleep: async () => {},
  });
  const platform = fake.d1.get(platformId)?.db;
  const billing = fake.d1.get(billingId)?.db;
  if (!platform || !billing) throw new Error("seed");
  const tiers = () =>
    billing
      .prepare(
        "SELECT install_id, tier, status, trial_ends_at, version FROM tiers ORDER BY install_id",
      )
      .all() as Record<string, unknown>[];
  return { cf, platform, billing, tiers };
}

const vars = (tier?: string) => JSON.stringify(tier ? { TIER: tier } : {});
const run = (w: ReturnType<typeof world>, dryRun: boolean) =>
  billingBackfill({ cf: w.cf, env: "staging", now: NOW, dryRun });

describe("billingBackfill", () => {
  it("a dry run plans every write and writes nothing", async () => {
    const w = world();
    install(w.platform, "iaaaaaaaaaa1", { vars: vars("team") });
    install(w.platform, "iaaaaaaaaaa2", { vars: vars("trial") });
    install(w.platform, "iaaaaaaaaaa3", { vars: vars() });
    install(w.platform, "iaaaaaaaaaa4", {
      vars: vars("team"),
      state: "deleting",
    });
    const r = await run(w, true);
    expect(r).toMatchObject({
      dryRun: true,
      planned: 3,
      written: 0,
      present: 0,
      skipped: 1,
    });
    expect(r.entries.map((e) => [e.install, e.tier, e.action])).toEqual([
      ["iaaaaaaaaaa1", "team", "write"],
      ["iaaaaaaaaaa2", "trial", "write"],
      ["iaaaaaaaaaa3", "free", "write"],
      ["iaaaaaaaaaa4", null, "skip"],
    ]);
    expect(w.tiers()).toEqual([]);
  });

  it("a real run writes the missing rows at version 1; a second run writes nothing", async () => {
    const w = world();
    install(w.platform, "iaaaaaaaaaa1", { vars: vars("team") });
    install(w.platform, "iaaaaaaaaaa2", { vars: vars("trial") });
    const first = await run(w, false);
    expect(first).toMatchObject({ planned: 0, written: 2, present: 0 });
    expect(w.tiers()).toEqual([
      {
        install_id: "iaaaaaaaaaa1",
        tier: "team",
        status: "active",
        trial_ends_at: null,
        version: 1,
      },
      {
        install_id: "iaaaaaaaaaa2",
        tier: "trial",
        status: "active",
        trial_ends_at: NOW + TRIAL_MS,
        version: 1,
      },
    ]);
    const second = await run(w, false);
    expect(second).toMatchObject({ written: 0, present: 2 });
  });

  it("never extends an existing trial: the row's trial_ends_at and version are kept", async () => {
    const w = world();
    install(w.platform, "iaaaaaaaaaa2", { vars: vars("trial") });
    const started = NOW - 10 * 86_400_000 + TRIAL_MS;
    w.billing
      .prepare(
        "INSERT INTO tiers (install_id, tier, status, trial_ends_at, version, updated_at) VALUES ('iaaaaaaaaaa2', 'trial', 'active', ?, 5, 1)",
      )
      .run(started);
    const before = w.tiers();
    const dry = await run(w, true);
    expect(dry.entries[0]).toMatchObject({ action: "present" });
    const real = await run(w, false);
    expect(real).toMatchObject({ written: 0, present: 1 });
    expect(w.tiers()).toEqual(before);
    expect(w.tiers()[0]).toMatchObject({ trial_ends_at: started, version: 5 });
  });
});
