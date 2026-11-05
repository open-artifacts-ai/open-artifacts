// The install row's compare-and-swap writes against real D1 semantics:
// meta.changes counts rows a trigger writes too (installs_row_version), so a
// won CAS must be read from RETURNING, and a lost race must still read lost.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cfClient } from "../src/cf.js";
import { platformNames } from "../src/names.js";
import { holderLease, leaseJobPart, PlatformDb } from "../src/platform.js";
import type { InstallId } from "../src/types.js";
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
  return { cf, fake, id, db, tick: (ms: number) => (t += ms) };
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

describe("a job's lease token (holderLease, #1326: fenced by attempt)", () => {
  const JA = "job:01JOBA";
  const JB = "job:01JOBB";
  const ID = "iaaaaaaaaaaa" as InstallId;
  const claim = async (
    w: ReturnType<typeof world>,
    lease: string,
    until: number,
  ) => {
    const cur = await w.db.byId(ID);
    return w.db.claim(
      ID,
      ["creating"],
      "creating",
      lease,
      until,
      cur?.row_version ?? 0,
    );
  };

  it("is the job part, a dot and 32 random hex: one job part per job, a new token per attempt", () => {
    const a1 = holderLease(JA);
    const a2 = holderLease(JA);
    expect(a1).toMatch(/^[0-9a-f]{16}\.[0-9a-f]{32}$/);
    expect(a1.startsWith(leaseJobPart(JA))).toBe(true);
    expect(a2.startsWith(leaseJobPart(JA))).toBe(true);
    expect(a2).not.toBe(a1);
    expect(leaseJobPart(JB)).not.toBe(leaseJobPart(JA));
  });

  it("a later attempt of the holding job re-takes the live lease with its own token; the earlier attempt's token then renews and finishes nothing", async () => {
    const w = world();
    await row(w);
    const until = 1_800_000_000_000 + 30 * 60_000;
    const a1 = holderLease(JA);
    expect(await claim(w, a1, until)).toBe(true);
    w.tick(60_000);
    const a2 = holderLease(JA);
    expect(await claim(w, a2, until + 60_000)).toBe(true);
    expect((await w.db.byId(ID))?.lease).toBe(a2);
    expect(await w.db.renew(ID, a1, until + 60_000)).toBe(false);
    expect(await w.db.update(ID, { version: "0.57.1" }, a1)).toBe(false);
    expect(await w.db.finish(ID, a1, "active")).toBe(false);
    expect(await w.db.byId(ID)).toMatchObject({
      lease: a2,
      state: "creating",
      version: null,
    });
  });

  it("another job is refused while the lease is live, and takes it once it expires", async () => {
    const w = world();
    await row(w);
    const until = 1_800_000_000_000 + 30 * 60_000;
    const a = holderLease(JA);
    expect(await claim(w, a, until)).toBe(true);
    expect(await claim(w, holderLease(JB), until)).toBe(false);
    expect((await w.db.byId(ID))?.lease).toBe(a);
    // Expiry is unchanged.
    w.tick(30 * 60_000);
    const b = holderLease(JB);
    expect(await claim(w, b, until + 120 * 60_000)).toBe(true);
    expect((await w.db.byId(ID))?.lease).toBe(b);
    // Now the first job is the one refused.
    expect(await claim(w, holderLease(JA), until + 120 * 60_000)).toBe(false);
  });

  it("a job never re-takes a live CLI lease, even one whose first 16 hex are its job part", async () => {
    const w = world();
    await row(w);
    const until = 1_800_000_000_000 + 30 * 60_000;
    // A CLI token (hex16: 32 hex, no dot) that starts with job A's 16 hex.
    const cli = `${leaseJobPart(JA).slice(0, 16)}${"0".repeat(16)}`;
    expect(cli).toMatch(/^[0-9a-f]{32}$/);
    expect(await claim(w, cli, until)).toBe(true);
    expect(await claim(w, holderLease(JA), until)).toBe(false);
    expect((await w.db.byId(ID))?.lease).toBe(cli);
    // And a CLI claim never re-takes a job's live lease.
    w.tick(30 * 60_000 + 1);
    const a = holderLease(JA);
    expect(await claim(w, a, until + 120 * 60_000)).toBe(true);
    expect(await claim(w, a.slice(0, 16) + a.slice(17, 33), until)).toBe(false);
    expect((await w.db.byId(ID))?.lease).toBe(a);
  });
});

describe("insertCreating and platform principals (4.1)", () => {
  it.each(["i000000admin", "i00000signup"])(
    "refuses %s before any write",
    async (id) => {
      const w = world();
      const n = w.fake.log.length;
      await expect(
        w.db.insertCreating({
          id: id as InstallId,
          slug: "acme",
          appHost: "acme.open-artifacts-staging.app",
          contentHost: "acme.open-artifacts-staging.page",
          ownerEmail: "owner@acme.test",
          testHooks: false,
          inputsHash: "h",
        }),
      ).rejects.toThrow(/platform principal/);
      expect(w.fake.log.length).toBe(n);
    },
  );
});

describe("the operation's audit actor (design v7 4.9)", () => {
  const actors = async (w: ReturnType<typeof world>) =>
    (
      await w.cf.d1Query(
        w.id,
        "SELECT actor, action FROM hosted_audit ORDER BY id",
        [],
      )
    )[0]?.results;

  it("with an actor, every row (create.start included) goes through auditAs as it", async () => {
    const w = world();
    const db = new PlatformDb(
      w.cf,
      { id: w.id, name: platformNames("staging").db },
      "staging",
      () => 1,
      "job:01JOB",
    );
    await db.insertCreating({
      id: "iaaaaaaaaaaa",
      slug: "acme",
      appHost: "acme.open-artifacts-staging.app",
      contentHost: "acme.open-artifacts-staging.page",
      ownerEmail: "owner@acme.test",
      testHooks: false,
      inputsHash: "h",
    });
    await db.audit("iaaaaaaaaaaa" as InstallId, "upgrade.start", {});
    expect(await actors(w)).toEqual([
      { actor: "job:01JOB", action: "create.start" },
      { actor: "job:01JOB", action: "upgrade.start" },
    ]);
  });

  it("without one (the CLI) the rows carry none, as before", async () => {
    const w = world();
    await row(w);
    await w.db.audit("iaaaaaaaaaaa" as InstallId, "upgrade.start", {});
    expect(await actors(w)).toEqual([
      { actor: null, action: "create.start" },
      { actor: null, action: "upgrade.start" },
    ]);
  });

  it("an empty or overlong actor is refused", () => {
    const w = world();
    for (const a of ["", "x".repeat(301)])
      expect(
        () =>
          new PlatformDb(w.cf, { id: w.id, name: "n" }, "staging", () => 1, a),
      ).toThrow(/audit actor/);
  });
});
