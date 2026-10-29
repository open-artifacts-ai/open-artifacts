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
import { CHECK_KEY, readPlan } from "../src/billing/plan.js";
import { refreshPlan } from "../src/billing/store.js";
import { DIRECTORY_SYNC_CRON, scheduled } from "../src/cron.js";
import type { Env } from "../src/env.js";
import {
  type BillingRow,
  cachePlan,
  clearBilling,
  DAY,
  fakeBilling,
  H,
  send,
} from "./billing-helpers.js";
import { errOf, login } from "./helpers.js";
import { pinMiddayUtc } from "./midday.js";

const tag = newId().slice(0, 6).toLowerCase();
const b = fakeBilling();
const { props } = b;
const TEAM_TIER = { ...H, TIER: "team" } as Env;

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

  it("BILLING absent: the provisioned TIER, whatever is cached; never unreachable; nothing recorded", async () => {
    await cachePlan(row({ status: "lapsed", version: 3 }), mid, TEAM_TIER);
    await env.DB.prepare(
      "insert into settings (key, value) values (?, ?) on conflict (key) do update set value = excluded.value",
    )
      .bind(
        CHECK_KEY,
        JSON.stringify({ checkedAt: mid, failingSince: mid - 30 * DAY }),
      )
      .run();
    const before = await env.DB.prepare(
      "select value from settings where key = ?",
    )
      .bind(CHECK_KEY)
      .first();
    for (const t of [mid, mid + 30 * DAY]) {
      expect(await refreshPlan(TEAM_TIER, t)).toBe("skipped");
      expect(await readPlan(TEAM_TIER, t)).toMatchObject({
        tier: "team",
        lock: null,
      });
    }
    expect(
      await env.DB.prepare("select value from settings where key = ?")
        .bind(CHECK_KEY)
        .first(),
    ).toEqual(before);
  });

  it("BILLING absent, no TIER: no plan at all (no enforcement), whatever is cached", async () => {
    expect(await readPlan(H, mid)).toBeNull();
    await cachePlan(row({ tier: "team", status: "lapsed", version: 2 }), mid);
    expect(await readPlan(H, mid + 30 * DAY)).toBeNull();
    // The same install with the gate: the cached lapse applies.
    expect(await withGate(() => readPlan(H, mid))).toMatchObject({
      readOnly: true,
      reason: "lapsed",
    });
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

  it("the cron feeds directory sync only on a syncing, unlocked tier", async () => {
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
    // Team (frozen), a lapse, and free: paused, nothing disconnected.
    for (const r of [
      row({ tier: "team", version: 2 }),
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
      send(props, R.restrictedGroup("g1"), owner.cookie, {
        method: "PUT",
        body: {},
      }),
  ];

  it("directory sync now, a held confirm and a restricted group: refused under a lock, the owner included", async () => {
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

  it("a role change is refused on a free instance; read-only still lets the owner demote", async () => {
    const target = await login(`t-role-${uniq()}@a.com`, "admin");
    await cachePlan(row({ tier: "free", trialEndsAt: 1, version: 1 }), mid);
    const patch = () =>
      send(props, R.member(target.userId), owner.cookie, {
        method: "PATCH",
        body: { role: "member" },
      });
    expect(await code(await patch())).toBe("plan_required");
    await cachePlan(row({ tier: "team", status: "lapsed", version: 2 }), mid);
    expect((await patch()).status).toBe(200);
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
  const stored = async () =>
    (
      (await env.DB.prepare(
        "select coalesce(sum(json_extract(j.value, '$.size')), 0) as n from versions v, json_each(v.manifest) j",
      ).first<{ n: number }>()) as { n: number }
    ).n;

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
});
