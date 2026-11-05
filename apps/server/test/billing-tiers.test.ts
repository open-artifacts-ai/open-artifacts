// Self-serve billing (#857 review): the plan's precedence, branch by branch;
// features from the billing tier (TIER_FEATURES, trial = Business), with a
// downgrade to Team freezing sync and nothing ever deleted; the team routes
// added to the gate; the cron's directory feed under a lock; and the
// free-tier caps, off until configured. Billing is a fake BillingGate
// (billing-helpers.ts); no Stripe or network call is made.
import { env } from "cloudflare:workers";
import {
  type BillingTier,
  type Me,
  MeSchema,
  newId,
  PLAN_STALE_MS,
  R,
  TIER_FEATURES,
} from "@oa/shared";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { withBrokerProps } from "../src/auth/broker-transport.js";
import { storedBytes } from "../src/billing/caps.js";
import { CHECK_KEY, readPlan } from "../src/billing/plan.js";
import { refreshPlan } from "../src/billing/store.js";
import { DIRECTORY_SYNC_CRON, scheduled } from "../src/cron.js";
import type { Env } from "../src/env.js";
import worker from "../src/index.js";
import { fakeAssets } from "./assets-stub.js";
import {
  type BillingRow,
  cachePlan,
  clearBilling,
  DAY,
  fakeBilling,
  H,
  send,
} from "./billing-helpers.js";
import { errOf, fetchAndWait, login } from "./helpers.js";
import { pinMiddayUtc } from "./midday.js";

const tag = newId().slice(0, 6).toLowerCase();
const b = fakeBilling();
const { props } = b;
const TEAM_TIER = { ...H, TIER: "team" } as Env;
const BUSINESS_TIER = { ...H, TIER: "business" } as Env;

let owner: { cookie: string; userId: string };
let admin: { cookie: string; userId: string };
let mid: number;

const row = (r: Partial<BillingRow>): BillingRow => ({
  tier: "business",
  status: "active",
  trialEndsAt: null,
  graceUntil: null,
  version: 1,
  ...r,
});
const withGate = <T>(f: () => Promise<T>) => withBrokerProps({ props }, f);
const getMe = async (cookie: string, e: Env = H): Promise<Me> => {
  const r = await send(props, R.me, cookie, { e });
  expect(r.status).toBe(200);
  return MeSchema.parse(await r.json());
};

beforeAll(async () => {
  owner = await login(`t-owner-${tag}@a.com`, "owner");
  admin = await login(`t-admin-${tag}@a.com`, "admin");
});
beforeEach(async () => {
  mid = pinMiddayUtc();
  b.s.row = row({});
  b.s.down = false;
  b.s.calls.length = 0;
  await clearBilling();
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await clearBilling();
});

// ----------------------------------------------------------- precedence

describe("precedence: BILLING present, then absent, then nothing", () => {
  it("BILLING present: the billing tier wins over TIER; 7 days after the last good read, read-only", async () => {
    await cachePlan(row({ tier: "business" }), mid, TEAM_TIER);
    expect(await withGate(() => readPlan(TEAM_TIER, mid))).toMatchObject({
      tier: "business",
      lock: null,
    });
    b.s.down = true;
    const t = mid + PLAN_STALE_MS;
    expect(await withGate(() => refreshPlan(TEAM_TIER, t))).toBe("failed");
    expect((await withGate(() => readPlan(TEAM_TIER, t)))?.lock).toBeNull();
    expect(await withGate(() => readPlan(TEAM_TIER, t + 1))).toMatchObject({
      tier: "business",
      readOnly: true,
      reason: "billing_unreachable",
    });
  });

  it("BILLING present, nothing read yet: TIER is the last good tier, for 7 days of failures", async () => {
    b.s.down = true;
    expect(await withGate(() => refreshPlan(TEAM_TIER, mid))).toBe("failed");
    expect(await withGate(() => readPlan(TEAM_TIER, mid))).toMatchObject({
      tier: "team",
      lock: null,
    });
    expect(
      (await withGate(() => readPlan(TEAM_TIER, mid + PLAN_STALE_MS + 1)))
        ?.reason,
    ).toBe("billing_unreachable");
  });

  it("BILLING present, no TIER and nothing read: free and solo, the trial allowed", async () => {
    expect(await withGate(() => readPlan(H, mid))).toMatchObject({
      tier: "free",
      lock: { mode: "solo", reason: "solo" },
      trialEligible: true,
    });
  });

  it("BILLING absent: no plan at all, whatever is cached or provisioned; nothing recorded, no call", async () => {
    await cachePlan(row({ status: "lapsed", version: 4 }), mid, BUSINESS_TIER);
    for (const e of [H, TEAM_TIER, BUSINESS_TIER])
      for (const t of [mid, mid + 30 * DAY]) {
        expect(await refreshPlan(e, t)).toBe("skipped");
        expect(await readPlan(e, t)).toBeNull();
      }
    expect(b.s.calls).toEqual([]);
  });
});

// ------------------------------------------------------ plan read (R4)

describe("the plan read: lazy, once per invocation, seeded by the user load (R4)", () => {
  /** H with a DB that records each statement's SQL, and a fake ASSETS. */
  const counting = () => {
    const qs: string[] = [];
    const DB = new Proxy(env.DB, {
      get(t, p) {
        if (p === "prepare")
          return (q: string) => {
            qs.push(q);
            return t.prepare(q);
          };
        const v = Reflect.get(t, p);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    return { qs, e: { ...H, DB, ASSETS: fakeAssets().fetcher } as Env };
  };
  const planReads = (qs: string[]) =>
    qs.filter((q) => q.includes("billing.plan")).length;
  const call = (e: Env, url: string, cookie?: string) =>
    fetchAndWait(
      worker as never,
      new Request(url, { headers: cookie ? { cookie } : {} }),
      e,
      props,
    );

  it("the SPA and the content host read no plan; a signed-in call reads it once, in its user load; an anonymous API call once", async () => {
    await cachePlan(row({}), mid);
    const c = counting();
    for (const url of [
      "http://app.localhost/",
      "http://app.localhost/settings/billing",
      "http://content.localhost/robots.txt",
    ]) {
      c.qs.length = 0;
      await call(c.e, url, owner.cookie);
      expect(planReads(c.qs), url).toBe(0);
    }
    // Signed in: the user load's own statement carries it; no second read,
    // and Me still reports the billing tier's features.
    c.qs.length = 0;
    const me = await call(c.e, `http://app.localhost${R.me}`, owner.cookie);
    expect(me.status).toBe(200);
    expect(planReads(c.qs)).toBe(1);
    expect(c.qs.find((q) => q.includes("billing.plan"))).toMatch(
      /^select id, email,[\s\S]* users\s+where id = \?1/,
    );
    expect(MeSchema.parse(await me.json()).instance.features).toEqual(
      expect.arrayContaining(["sync_google"]),
    );
    // Anonymous, an API route: read once, lazily.
    c.qs.length = 0;
    expect((await call(c.e, "http://app.localhost/healthz")).status).toBe(200);
    expect(planReads(c.qs)).toBe(1);
  });
});

// ------------------------------------------------------------- features

const counts = async () => {
  const out: Record<string, number> = {};
  for (const t of [
    "users",
    "artifacts",
    "versions",
    "spaces",
    "space_members",
    "shares",
    "directory_state",
  ])
    out[t] = (
      (await env.DB.prepare(`select count(*) as n from ${t}`).first<{
        n: number;
      }>()) as { n: number }
    ).n;
  return out;
};

describe("features follow the billing tier (TIER_FEATURES)", () => {
  const featuresAt = async (tier: BillingTier, version: number) => {
    await cachePlan(row({ tier, version, trialEndsAt: mid + DAY }), mid);
    return getMe(owner.cookie);
  };

  it("the trial gets Business's features; Me's two tiers agree; provisioned FEATURES don't count", async () => {
    const me = await featuresAt("trial", 2);
    expect(
      new Set(me.instance.features?.filter((f) => f !== "guests_read_only")),
    ).toEqual(new Set([...TIER_FEATURES.business, "usage_off"]));
    expect(me.instance.tier).toBe("trial");
    expect(me.instance.billing?.tier).toBe("trial");
    expect(me.instance.directory?.mode).toBe("google");
    // H provisions FEATURES "spaces,content_revocation" only.
    expect(H.FEATURES).toBe("spaces,content_revocation");
  });

  it("Team -> Business adds sync; Business -> Team freezes it; nothing deleted on any transition", async () => {
    // Something to keep: a directory row, a space with a member, a share.
    await env.DB.prepare(
      "insert into directory_state (key, value) values (?, ?) on conflict (key) do nothing",
    )
      .bind(`test.kept.${tag}`, '{"kept":true}')
      .run();
    await cachePlan(row({ tier: "business", version: 1 }), mid);
    const sp = await send(props, R.spaces, owner.cookie, {
      method: "POST",
      body: { name: `Keep ${tag}` },
    });
    expect(sp.status).toBe(201);
    const before = await counts();

    const team = await featuresAt("team", 2);
    expect(team.instance.features).toContain("sync_frozen");
    expect(team.instance.features).not.toContain("sync_google");
    expect(team.instance.directory?.mode).toBe("frozen");
    expect(team.instance.tier).toBe("team");

    const business = await featuresAt("business", 3);
    expect(business.instance.features).toContain("sync_google");
    expect(business.instance.features).not.toContain("sync_frozen");

    await featuresAt("team", 4);
    // A lapse: read-only, the tier's features kept.
    await cachePlan(row({ tier: "team", status: "lapsed", version: 5 }), mid);
    const lapsed = await getMe(owner.cookie);
    expect(lapsed.instance.billing).toMatchObject({
      tier: "team",
      readOnly: true,
      reason: "lapsed",
    });
    expect(lapsed.instance.features).toContain("sync_frozen");
    await cachePlan(row({ tier: "free", trialEndsAt: 1, version: 6 }), mid);
    expect((await getMe(owner.cookie)).instance.tier).toBeNull();
    expect(await counts()).toEqual(before);
    expect(
      await env.DB.prepare("select value from directory_state where key = ?")
        .bind(`test.kept.${tag}`)
        .first(),
    ).toEqual({ value: '{"kept":true}' });
  });

  it("the cron pauses directory sync only on a locked plan (Team stays unpaused)", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    });
    const tick = async () => {
      const pending: Promise<unknown>[] = [];
      await scheduled({ cron: DIRECTORY_SYNC_CRON }, H, {
        waitUntil: (p: Promise<unknown>) => pending.push(p),
        passThroughOnException() {},
        props,
      } as unknown as ExecutionContext);
      await Promise.allSettled(pending);
    };
    const paused = () => lines.filter((l) => l.includes("plan_paused")).length;
    // Business: the feed runs (no plan pause).
    b.s.row = row({ tier: "business", version: 1 });
    await cachePlan(b.s.row, mid);
    await tick();
    expect(paused()).toBe(0);
    // Team is frozen (groups stop) but not paused: its user lanes keep
    // running, so no plan_paused line.
    b.s.row = row({ tier: "team", version: 2 });
    await cachePlan(b.s.row, mid);
    const teamN = paused();
    await tick();
    expect(paused()).toBe(teamN);
    // A lapse and free: paused, nothing disconnected.
    for (const r of [
      row({ tier: "team", status: "lapsed", version: 3 }),
      row({ tier: "free", trialEndsAt: 1, version: 4 }),
    ]) {
      b.s.row = r;
      await cachePlan(r, mid);
      const n = paused();
      await tick();
      expect(paused()).toBe(n + 1);
    }
  });
});

// ---------------------------------------------------- team routes (S6)

describe("the gate's team routes", () => {
  const code = async (r: Response) =>
    r.status === 403 ? (await errOf(r)).code : `http_${r.status}`;
  const DIRECTORY_WRITES = [
    () =>
      send(props, R.directorySync, owner.cookie, { method: "POST", body: {} }),
    () =>
      send(props, R.directoryHeldConfirm("g1"), owner.cookie, {
        method: "POST",
        body: {},
      }),
    () =>
      send(props, R.directoryHeldSnooze("g1"), owner.cookie, {
        method: "POST",
        body: {},
      }),
    () =>
      send(props, R.restrictedGroup("g1"), owner.cookie, {
        method: "PUT",
        body: {},
      }),
  ];

  it("directory sync now, a held confirm or snooze and a restricted group: refused under a lock, the owner included", async () => {
    await cachePlan(row({ version: 1 }), mid);
    for (const f of DIRECTORY_WRITES)
      expect(await code(await f())).not.toMatch(/^plan_/);
    await cachePlan(row({ tier: "team", status: "lapsed", version: 2 }), mid);
    for (const f of DIRECTORY_WRITES)
      expect(await code(await f())).toBe("plan_read_only");
    await cachePlan(row({ tier: "free", trialEndsAt: 1, version: 3 }), mid);
    for (const f of DIRECTORY_WRITES)
      expect(await code(await f())).toBe("plan_required");
  });

  it("cancelling a snooze is a removal: it passes the plan gate under a lock", async () => {
    await cachePlan(row({ tier: "team", status: "lapsed", version: 1 }), mid);
    const r = await send(props, R.directoryHeldSnooze("g1"), owner.cookie, {
      method: "DELETE",
    });
    expect(await code(r)).not.toMatch(/^plan_/);
  });

  it("a locked instance refuses only a promotion or a reactivation; demotions pass, free and read-only alike (R3)", async () => {
    const target = await login(`t-role-${uniq()}@a.com`, "admin");
    const patch = (role: string) =>
      send(props, R.member(target.userId), owner.cookie, {
        method: "PATCH",
        body: { role },
      });
    await cachePlan(row({ tier: "free", trialEndsAt: 1, version: 1 }), mid);
    // A demotion, then the same role again: pass.
    expect((await patch("member")).status).toBe(200);
    expect((await patch("member")).status).toBe(200);
    // A promotion: plan_required.
    expect(await code(await patch("admin"))).toBe("plan_required");
    // A reactivation (someone not active): plan_required, even unchanged.
    await env.DB.prepare("update users set status = 'removed' where id = ?")
      .bind(target.userId)
      .run();
    expect(await code(await patch("member"))).toBe("plan_required");
    await env.DB.prepare("update users set status = 'active' where id = ?")
      .bind(target.userId)
      .run();
    // Read-only (a lapse): the same rule, with plan_read_only.
    await cachePlan(row({ tier: "team", status: "lapsed", version: 2 }), mid);
    expect(await code(await patch("admin"))).toBe("plan_read_only");
    expect((await patch("member")).status).toBe(200);
  });
});

let seq = 0;
function uniq() {
  return `${tag}${++seq}`;
}

// ------------------------------------------------------ free-tier caps

describe("free-tier caps: config, off until set", () => {
  const FREE = row({ tier: "free", trialEndsAt: 1, version: 1 });
  const publish = (e: Env) =>
    send(props, R.artifacts, owner.cookie, {
      method: "POST",
      e,
      body: {
        title: "t",
        format: "html",
        content: "<p>x</p>",
        capabilities: { db: true, viewer: false, storage: false },
      },
    });
  const put = (e: Env, id: string, doc: string) =>
    send(props, R.dataDoc(id, "c", doc), owner.cookie, {
      method: "PUT",
      raw: '{"v":1}',
      e,
    });
  const upload = (e: Env, id: string, size: number) =>
    send(props, R.uploads, owner.cookie, {
      method: "POST",
      e,
      body: {
        artifactId: id,
        path: `${uniq()}.png`,
        size,
        contentType: "image/png",
      },
    });
  const stored = () => storedBytes(H);

  it("unset: a free instance has no caps", async () => {
    await cachePlan(FREE, mid);
    const r = await publish(H);
    expect(r.status).toBe(201);
    const id = ((await r.json()) as { id: string }).id;
    for (const d of ["a", "b", "c", "d", "a"])
      expect((await put(H, id, d)).status).toBe(200);
    expect((await upload(H, id, 5_000_000)).status).toBe(201);
  });

  it("set: docs and daily writes per artifact are 403 plan_limit; updates of existing docs pass", async () => {
    await cachePlan(FREE, mid);
    const e = {
      ...H,
      FREE_DATA_DOCS: "2",
      FREE_DATA_DAILY_WRITES: "4",
    } as Env;
    const id = ((await (await publish(e)).json()) as { id: string }).id;
    expect((await put(e, id, "a")).status).toBe(200);
    expect((await put(e, id, "b")).status).toBe(200);
    const third = await put(e, id, "c");
    expect(third.status).toBe(403);
    expect(await errOf(third)).toMatchObject({
      code: "plan_limit",
      details: { tier: "free", limit: "data_docs", max: 2 },
    });
    // An update of a doc that exists: passes (3 writes, then 4).
    expect((await put(e, id, "a")).status).toBe(200);
    expect((await put(e, id, "b")).status).toBe(200);
    const fifth = await put(e, id, "a");
    expect(await errOf(fifth)).toMatchObject({
      code: "plan_limit",
      details: { limit: "data_daily_writes", max: 4 },
    });
    // A paid tier: the same caps never apply.
    await cachePlan(row({ tier: "team", version: 2 }), mid);
    expect((await put(e, id, "z")).status).toBe(200);
  });

  it("set: stored bytes refuse an upload past the cap, and publishing once it is reached", async () => {
    await cachePlan(FREE, mid);
    const id = ((await (await publish(H)).json()) as { id: string }).id;
    const used = await stored();
    const e = { ...H, FREE_STORAGE_BYTES: String(used + 50) } as Env;
    expect((await upload(e, id, 40)).status).toBe(201);
    const over = await upload(e, id, 60);
    expect(over.status).toBe(403);
    expect(await errOf(over)).toMatchObject({
      code: "plan_limit",
      details: { limit: "storage_bytes", max: used + 50 },
    });
    expect((await publish(e)).status).toBe(201);
    const full = { ...H, FREE_STORAGE_BYTES: String(await stored()) } as Env;
    const refused = await publish(full);
    expect(refused.status).toBe(403);
    expect((await errOf(refused)).code).toBe("plan_limit");
    // Invalid values are off, never zero.
    for (const v of ["0", "-1", "abc", ""])
      expect(
        (await publish({ ...H, FREE_STORAGE_BYTES: v } as Env)).status,
      ).toBe(201);
  });

  it("set: an unsized PUT over the storage cap is refused before and after storing", async () => {
    await cachePlan(FREE, mid);
    const id = ((await (await publish(H)).json()) as { id: string }).id;
    const used = await stored();
    const e = { ...H, FREE_STORAGE_BYTES: String(used + 50) } as Env;
    const made = async () => {
      const r = await send(props, R.uploads, owner.cookie, {
        method: "POST",
        e,
        body: { artifactId: id, path: `${uniq()}.bin` },
      });
      expect(r.status).toBe(201);
      const j = (await r.json()) as { uploadId: string; url: string };
      const u = new URL(j.url);
      return {
        id: j.uploadId,
        exp: u.searchParams.get("exp") ?? "",
        sig: u.searchParams.get("sig") ?? "",
      };
    };
    const putTo = (
      x: { id: string; exp: string; sig: string },
      env2: Env,
      bytes: number,
      claimed = bytes,
    ) =>
      send(props, `${R.upload(x.id)}?exp=${x.exp}&sig=${x.sig}`, null, {
        method: "PUT",
        e: env2,
        csrf: false,
        raw: "x".repeat(bytes),
        headers: { "content-length": String(claimed) },
      });
    const row = (uploadId: string) =>
      env.DB.prepare("select r2_key, received_at from uploads where id = ?")
        .bind(uploadId)
        .first<{ r2_key: string; received_at: number | null }>();

    // Before: the header says 60 > 50 free, so R2 is never written.
    const a = await made();
    const puts: string[] = [];
    const spy = {
      ...e,
      FILES: {
        put: (k: string) => {
          puts.push(k);
          return env.FILES.put(k, "");
        },
        delete: env.FILES.delete.bind(env.FILES),
      },
    } as unknown as Env;
    const ra = await putTo(a, spy, 60);
    expect(ra.status).toBe(403);
    expect(await errOf(ra)).toMatchObject({
      code: "plan_limit",
      details: { limit: "storage_bytes" },
    });
    expect(puts).toEqual([]);
    expect((await row(a.id))?.received_at).toBeNull();

    // After: the header lies (10), the body is 60; the measured bytes are refused and removed.
    const b = await made();
    const rbRes = await putTo(b, e, 60, 10);
    expect(rbRes.status).toBe(403);
    expect((await errOf(rbRes)).code).toBe("plan_limit");
    const rb = await row(b.id);
    expect(rb?.received_at).toBeNull();
    expect(await env.FILES.head(rb?.r2_key ?? "")).toBeNull();

    // Within the cap it passes and records the measured size.
    const c = await made();
    expect((await putTo(c, e, 40)).status).toBe(204);
    expect(
      (
        await env.DB.prepare("select size from uploads where id = ?")
          .bind(c.id)
          .first<{ size: number }>()
      )?.size,
    ).toBe(40);
  });

  // Manager decision R5: distinct content across every version (history
  // included), each blob once, trashed artifacts excluded.
  const version = (id: string, content: string, e: Env = H) =>
    send(props, R.versions(id), owner.cookie, {
      method: "POST",
      e,
      body: { format: "html", content },
    });
  const fresh = async (content: string) => {
    const r = await send(props, R.artifacts, owner.cookie, {
      method: "POST",
      body: { title: "s", format: "html", content },
    });
    expect(r.status).toBe(201);
    return ((await r.json()) as { id: string }).id;
  };
  const trash = (id: string) =>
    send(props, R.artifact(id), owner.cookie, { method: "DELETE" });

  it("storage: republishing the same file 100 times counts it once", async () => {
    const content = `<p>same ${uniq()}</p>`;
    const size = new TextEncoder().encode(content).length;
    const before = await stored();
    const id = await fresh(content);
    expect(await stored()).toBe(before + size);
    for (let i = 0; i < 100; i++)
      expect((await version(id, content)).status).toBe(201);
    expect(await stored()).toBe(before + size);
  });

  it("storage: a new version with new content adds its bytes; history stays counted", async () => {
    const a = `<p>a ${uniq()}</p>`;
    const b = `<p>bb ${uniq()}</p>`;
    const before = await stored();
    const id = await fresh(a);
    expect((await version(id, b)).status).toBe(201);
    const both =
      new TextEncoder().encode(a).length + new TextEncoder().encode(b).length;
    expect(await stored()).toBe(before + both);
  });

  it("storage: trashing an artifact drops the blobs no live artifact still holds", async () => {
    const shared = `<p>shared ${uniq()}</p>`;
    const own = `<p>own only ${uniq()}</p>`;
    const n = (s: string) => new TextEncoder().encode(s).length;
    const before = await stored();
    const keep = await fresh(shared);
    const gone = await fresh(shared);
    expect((await version(gone, own)).status).toBe(201);
    expect(await stored()).toBe(before + n(shared) + n(own));
    expect((await trash(gone)).status).toBe(204);
    // `own` went with it; `shared` stays: `keep` still holds it.
    expect(await stored()).toBe(before + n(shared));
    expect((await trash(keep)).status).toBe(204);
    expect(await stored()).toBe(before);
  });

  it("storage: the cap set is enforced at the distinct count; unset, never", async () => {
    await cachePlan(FREE, mid);
    const content = `<p>cap ${uniq()}</p>`;
    const id = await fresh(content);
    const at = { ...H, FREE_STORAGE_BYTES: String(await stored()) } as Env;
    // At the cap: refused, though the bytes would not change.
    expect((await errOf(await version(id, content, at))).code).toBe(
      "plan_limit",
    );
    const roomy = {
      ...H,
      FREE_STORAGE_BYTES: String((await stored()) + 1_000),
    } as Env;
    for (let i = 0; i < 5; i++)
      expect((await version(id, content, roomy)).status).toBe(201);
    // Unset: nothing enforced, whatever is stored.
    expect((await version(id, `<p>${uniq()}</p>`)).status).toBe(201);
  });
});
