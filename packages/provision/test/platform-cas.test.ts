// The install row's compare-and-swap writes against real D1 semantics:
// meta.changes counts rows a trigger writes too (installs_row_version), so a
// won CAS must be read from RETURNING, and a lost race must still read lost.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cfClient } from "../src/cf.js";
import { platformNames } from "../src/names.js";
import { PlatformDb } from "../src/platform.js";
import { FakeCf } from "./fake-cf.js";

const ROOT = new URL("../../../", import.meta.url);
const PLATFORM_SQL = readdirSync(new URL("apps/platform-db/migrations/", ROOT))
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) =>
    readFileSync(new URL(`apps/platform-db/migrations/${f}`, ROOT), "utf8"),
  )
  .join("\n");

function world() {
  let t = 1_800_000_000_000;
  const fake = new FakeCf({ now: t });
  const name = platformNames("staging").db;
  const id = fake.seedD1(name, PLATFORM_SQL);
  const cf = cfClient({
    accountId: fake.accountId,
    token: fake.token,
    fetch: fake.fetch,
    sleep: async () => {},
  });
  const db = new PlatformDb(cf, { id, name }, "staging", () => t);
  return { cf, id, db, tick: (ms: number) => (t += ms) };
}

async function row(w: ReturnType<typeof world>) {
  return w.db.insertCreating({
    id: "iaaaaaaaaaaa",
    slug: "acme",
    appHost: "acme.open-artifacts-staging.app",
    contentHost: "acme.open-artifacts-staging.page",
    ownerEmail: "owner@acme.test",
    testHooks: false,
    inputsHash: "h",
  });
}

describe("install CAS writes on D1's real meta.changes", () => {
  it("the fake reports D1's count: a one-row UPDATE of installs is 2 (the row_version trigger)", async () => {
    const w = world();
    await row(w);
    const r = await w.cf.d1Query(
      w.id,
      "UPDATE installs SET updated_at = updated_at WHERE id = ?1",
      ["iaaaaaaaaaaa"],
    );
    expect(r[0]?.meta?.changes).toBe(2);
  });

  it("a won claim, renew, lease update and finish read as won", async () => {
    const w = world();
    const r = await row(w);
    const until = 1_800_000_000_000;
    expect(
      await w.db.claim(
        r.id,
        ["creating"],
        "creating",
        "L1",
        until + 1e12,
        r.row_version,
      ),
    ).toBe(true);
    expect(await w.db.renew(r.id, "L1", until + 2e12)).toBe(true);
    expect(await w.db.update(r.id, { version: "0.57.1" }, "L1")).toBe(true);
    expect(await w.db.finish(r.id, "L1", "active")).toBe(true);
  });

  it("a lost race (another holder's live lease) still reads as lost", async () => {
    const w = world();
    const r = await row(w);
    expect(
      await w.db.claim(
        r.id,
        ["creating"],
        "creating",
        "THEIRS",
        1e15,
        r.row_version,
      ),
    ).toBe(true);
    const cur = await w.db.byId(r.id);
    expect(
      await w.db.claim(
        r.id,
        ["creating"],
        "creating",
        "MINE",
        1e15,
        cur?.row_version ?? 0,
      ),
    ).toBe(false);
    expect(await w.db.renew(r.id, "MINE", 1e15)).toBe(false);
    expect(await w.db.update(r.id, { version: "0.57.1" }, "MINE")).toBe(false);
    expect(await w.db.finish(r.id, "MINE", "active")).toBe(false);
    const after = await w.db.byId(r.id);
    expect(after?.lease).toBe("THEIRS");
    expect(after?.state).toBe("creating");
    expect(after?.version).toBeNull();
  });

  it("a stale row_version loses the claim even with no lease held", async () => {
    const w = world();
    const r = await row(w);
    await w.cf.d1Query(
      w.id,
      "UPDATE installs SET updated_at = updated_at WHERE id = ?1",
      [r.id],
    );
    expect(
      await w.db.claim(
        r.id,
        ["creating"],
        "creating",
        "L1",
        1e15,
        r.row_version,
      ),
    ).toBe(false);
  });
});
