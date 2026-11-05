// Self-serve billing, install side: the tier cache and its version and
// 7-day rules, plan enforcement on every write path (REST, MCP data tools,
// live data, uploads, versions), the trial start at the first invite, the
// creator count, the signed POSTs and Me.instance.billing. Billing is a fake
// BillingGate (ctx.props.BILLING) that checks signatures as oa-<p>-billing
// does (the install's key over the route path and exact body text).
import { env } from "cloudflare:workers";
import { publicFromPkcs8, verifyRequest } from "@oa/auth-core";
import {
  type BillingStatus,
  type BillingTier,
  type Me,
  MeSchema,
  newId,
  PLAN_STALE_MS,
  R,
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
import { createApp } from "../src/app.js";
import { withBrokerProps } from "../src/auth/broker-transport.js";
import { createPat } from "../src/auth/pat.js";
import { sessionCookieName, signSession } from "../src/auth/session.js";
import {
  creatorsOf,
  forgetRecordedCreators,
  LIVE_KEY,
  monthOf,
  previousMonth,
  USAGE_SENT_KEY,
  usageTick,
} from "../src/billing/creators.js";
import {
  CHECK_KEY,
  effectivePlan,
  PLAN_KEY,
  planOfRaw,
  readPlan,
  type StoredPlan,
} from "../src/billing/plan.js";
import {
  billingTick,
  ON_DEMAND_MS,
  refreshPlan,
  storePlan,
} from "../src/billing/store.js";
import { DIRECTORY_SYNC_CRON, scheduled } from "../src/cron.js";
import type { Env } from "../src/env.js";
import { billingRetry } from "../src/routes/billing.js";
import { TEST_BROKER_KEY } from "./auth-helpers.js";
import { errOf, fetchAndWait, login } from "./helpers.js";
import { connect, oauthToken, textOf, tool } from "./mcp-helpers.js";
import { pinMiddayUtc } from "./midday.js";

const app = createApp();
const DAY = 86_400_000;
const INSTALL = "ibilltest0001";
const tag = newId().slice(0, 6).toLowerCase();

/** A hosted install with spaces on and no provisioned TIER. */
const H = {
  ...(env as object),
  HOSTED: "1",
  INSTALL_ID: INSTALL,
  BROKER_SIGNING_KEY: TEST_BROKER_KEY,
  FEATURES: "spaces,content_revocation",
  TIER: undefined,
} as unknown as Env;
/** The same install self-hosted: no gate at all. */
const SELF = { ...H, HOSTED: undefined } as unknown as Env;

// --------------------------------------------------------------- fake billing

type Row = {
  tier: BillingTier;
  status: BillingStatus;
  trialEndsAt: number | null;
  graceUntil: number | null;
  version: number;
};
type Call = { path: string; body: Record<string, unknown> | null };

let row: Row;
let calls: Call[];
let down: boolean;
/** When set, POST /trial/start answers this row (billing says the trial was used). */
let trialAnswer: Row | null;
let x: string;

/** The gate plus billing: GET /tier, the signed POSTs, as #849 answers them. */
const gate = {
  async fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    if (down) throw new Error("Network connection lost");
    if (req.method === "GET") {
      calls.push({ path, body: null });
      if (path !== "/tier") return new Response("nf", { status: 404 });
      return Response.json({ ...row, asOf: Date.now() });
    }
    const text = await req.text();
    const kid = req.headers.get("x-oa-kid") ?? "";
    const sig = req.headers.get("x-oa-sig") ?? "";
    if (!(await verifyRequest(x, path, kid, text, sig)))
      return Response.json({ error: "bad_signature" }, { status: 401 });
    const body = JSON.parse(text) as Record<string, unknown>;
    calls.push({ path, body });
    if (body.install !== INSTALL)
      return Response.json(
        { error: "install_mismatch" },
        { status: 403, headers: { "x-oa-gate": "1" } },
      );
    if (path === "/trial/start") {
      if (trialAnswer)
        return Response.json({ ...trialAnswer, asOf: Date.now() });
      if (row.tier === "free" && row.trialEndsAt === null)
        row = {
          ...row,
          tier: "trial",
          trialEndsAt: Date.now() + 14 * DAY,
          version: row.version + 1,
        };
      return Response.json({ ...row, asOf: Date.now() });
    }
    if (path === "/usage")
      return Response.json({ ok: true, month: body.month, count: body.count });
    if (path === "/checkout")
      return Response.json({
        url: "https://checkout.stripe.com/c/pay/cs_test_1",
      });
    if (path === "/portal")
      return Response.json({
        url: "https://billing.stripe.com/p/session/test_1",
      });
    return new Response("nf", { status: 404 });
  },
};
const PROPS = { BILLING: gate };

const send = (
  path: string,
  auth: string | null,
  init: {
    method?: string;
    body?: unknown;
    raw?: string;
    e?: Env;
    csrf?: boolean;
  } = {},
) => {
  const headers: Record<string, string> = {};
  if (init.csrf !== false) headers["x-oa-request"] = "1";
  if (auth?.startsWith("oa_pat_")) headers.authorization = `Bearer ${auth}`;
  else if (auth) headers.cookie = auth;
  const body =
    init.raw ??
    (init.body === undefined ? undefined : JSON.stringify(init.body));
  if (body !== undefined) headers["content-type"] = "application/json";
  return fetchAndWait(
    app,
    new Request(`http://app.localhost${path}`, {
      method: init.method ?? "GET",
      headers,
      body,
    }),
    init.e ?? H,
    PROPS,
  );
};

/** Caches `r` as billing's answer now (the version rule applies). */
const cache = (r: Partial<Row>, now = Date.now()) =>
  storePlan(H, { ...row, ...r, asOf: now }, now);

const clear = async () => {
  await env.DB.prepare("delete from settings where key like 'billing.%'").run();
  await env.DB.prepare("delete from creator_months").run();
  forgetRecordedCreators();
};

let owner: { cookie: string; userId: string };
let member: { cookie: string; userId: string };
let mid: number;

beforeAll(async () => {
  x = await publicFromPkcs8(TEST_BROKER_KEY);
  owner = await login(`owner-${tag}@a.com`, "owner");
  member = await login(`member-${tag}@a.com`, "member");
});
beforeEach(async () => {
  mid = pinMiddayUtc();
  row = {
    tier: "business",
    status: "active",
    trialEndsAt: null,
    graceUntil: null,
    version: 1,
  };
  calls = [];
  down = false;
  trialAnswer = null;
  await clear();
});
afterEach(async () => {
  vi.useRealTimers();
  await clear();
});

const publish = async (
  auth: string,
  extra: Record<string, unknown> = {},
  e = H,
) => {
  const r = await send(R.artifacts, auth, {
    method: "POST",
    e,
    body: {
      title: "t",
      format: "html",
      content: "<p>x</p>",
      capabilities: { db: true, viewer: false, storage: false },
      ...extra,
    },
  });
  return r;
};
const idOf = async (r: Response) => ((await r.json()) as { id: string }).id;
const getMe = async (auth: string): Promise<Me> => {
  const r = await send(R.me, auth);
  expect(r.status).toBe(200);
  return MeSchema.parse(await r.json());
};

// ----------------------------------------------------------- the pure rules

describe("effectivePlan", () => {
  const at = (r: Partial<StoredPlan>, now: number): StoredPlan => ({
    tier: "business",
    status: "active",
    trialEndsAt: null,
    graceUntil: null,
    version: 1,
    asOf: now,
    ...r,
  });

  it("free is solo; trial and paid active are unlocked", () => {
    const free = effectivePlan(at({ tier: "free" }, mid), null, undefined, mid);
    expect(free).toMatchObject({
      readOnly: false,
      reason: "solo",
      trialEligible: true,
    });
    expect(free.lock).toEqual({ mode: "solo", tier: "free", reason: "solo" });
    const used = effectivePlan(
      at({ tier: "free", trialEndsAt: mid - DAY }, mid),
      null,
      undefined,
      mid,
    );
    expect(used.trialEligible).toBe(false);
    for (const tier of ["trial", "team", "business"] as const)
      expect(
        effectivePlan(
          at({ tier, trialEndsAt: tier === "trial" ? mid + DAY : null }, mid),
          null,
          undefined,
          mid,
        ).lock,
      ).toBeNull();
  });

  it("an ended trial, a lapse, a suspension and past due beyond grace are read-only", () => {
    const ro = (r: Partial<StoredPlan>) =>
      effectivePlan(at(r, mid), null, undefined, mid);
    expect(ro({ tier: "trial", trialEndsAt: mid - 1 })).toMatchObject({
      readOnly: true,
      reason: "trial_ended",
    });
    expect(ro({ tier: "trial", status: "lapsed" })).toMatchObject({
      readOnly: true,
      reason: "trial_ended",
    });
    expect(ro({ tier: "team", status: "lapsed" })).toMatchObject({
      readOnly: true,
      reason: "lapsed",
    });
    expect(ro({ status: "suspended" })).toMatchObject({
      readOnly: true,
      reason: "suspended",
    });
    expect(ro({ status: "past_due", graceUntil: mid + 1 }).lock).toBeNull();
    expect(ro({ status: "past_due", graceUntil: mid - 1 })).toMatchObject({
      readOnly: true,
      reason: "payment_failed",
    });
  });

  it("missing dates fail closed: past_due with no graceUntil locks 7 days after asOf; a trial with no end counts as ended", () => {
    const pd = (asOf: number, now: number) =>
      effectivePlan(
        at({ tier: "team", status: "past_due", graceUntil: null, asOf }, now),
        // A good read now: only the grace rule is under test, not the outage's.
        { checkedAt: now, failingSince: null, lastGoodAt: now },
        undefined,
        now,
      );
    expect(pd(mid, mid + 7 * DAY).lock).toBeNull();
    expect(pd(mid, mid + 7 * DAY + 1)).toMatchObject({
      readOnly: true,
      reason: "payment_failed",
    });
    expect(
      effectivePlan(
        at({ tier: "trial", trialEndsAt: null }, mid),
        null,
        undefined,
        mid,
      ),
    ).toMatchObject({ readOnly: true, reason: "trial_ended" });
  });

  it("a provisioned TIER=trial with no billing answer is not locked (gate, no-row default); no gate is no plan; a billing answer with no trial end is", async () => {
    const T = { ...H, TIER: "trial" } as Env;
    expect(planOfRaw(T, null, null, mid, { gate: true })?.lock).toBeNull();
    expect(planOfRaw(T, null, null, mid, { gate: false })).toBeNull();
    row = {
      tier: "free",
      status: "active",
      trialEndsAt: null,
      graceUntil: null,
      version: 0,
    };
    expect(
      await withBrokerProps({ props: PROPS }, () => refreshPlan(T, mid)),
    ).toBe("unchanged");
    expect(
      (await withBrokerProps({ props: PROPS }, () => readPlan(T, mid)))?.lock,
    ).toBeNull();
    expect(
      effectivePlan(
        at({ tier: "trial", trialEndsAt: null }, mid),
        null,
        undefined,
        mid,
      ),
    ).toMatchObject({ readOnly: true, reason: "trial_ended" });
  });

  it("OUR outage: the last good tier holds for 7 days, then read-only; never upward", () => {
    const edge = mid - PLAN_STALE_MS;
    expect(effectivePlan(at({}, edge), null, undefined, mid).lock).toBeNull();
    expect(effectivePlan(at({}, edge - 1), null, undefined, mid)).toMatchObject(
      {
        tier: "business",
        readOnly: true,
        reason: "billing_unreachable",
      },
    );
    // A stale free instance does not become solo-and-writable: read-only.
    expect(
      effectivePlan(at({ tier: "free" }, edge - 1), null, undefined, mid),
    ).toMatchObject({
      readOnly: true,
      reason: "billing_unreachable",
    });
    // Never read: the provisioned TIER holds 7 days from the first failure.
    const check = { checkedAt: mid, failingSince: edge };
    expect(effectivePlan(null, check, "team", mid).lock).toBeNull();
    expect(
      effectivePlan(null, { ...check, failingSince: edge - 1 }, "team", mid)
        .reason,
    ).toBe("billing_unreachable");
  });

  it("no answer and no TIER: free (solo, trial allowed), never unenforced (S3)", () => {
    expect(planOfRaw(H, null, null, mid, { gate: true })).toMatchObject({
      tier: "free",
      reason: "solo",
      lock: { mode: "solo" },
      trialEligible: true,
    });
    // No BILLING gate: no plan at all, whatever is cached.
    expect(planOfRaw(H, null, null, mid, { gate: false })).toBeNull();
    expect(
      planOfRaw(H, JSON.stringify(at({ status: "lapsed" }, mid)), null, mid, {
        gate: false,
      }),
    ).toBeNull();
    const failing = JSON.stringify({
      checkedAt: mid,
      failingSince: mid - PLAN_STALE_MS - 1,
    });
    expect(planOfRaw(H, null, failing, mid, { gate: true })?.reason).toBe(
      "billing_unreachable",
    );

    // Self-hosted: no gate, whatever is stored.
    const stored = JSON.stringify(at({ status: "lapsed" }, mid));
    expect(planOfRaw(SELF, stored, null, mid)).toBeNull();
  });
});

// -------------------------------------------------------------- tier cache

describe("tier read and cache", () => {
  const stored = async () =>
    JSON.parse(
      (
        (await env.DB.prepare("select value from settings where key = ?")
          .bind(PLAN_KEY)
          .first<{ value: string }>()) as { value: string }
      ).value,
    ) as StoredPlan;

  it("never accepts an older version, nor the same version read earlier", async () => {
    expect(await cache({ version: 5, tier: "team" }, mid)).toBe(true);
    expect(await cache({ version: 4, tier: "business" }, mid + 1000)).toBe(
      false,
    );
    expect(await cache({ version: 5, tier: "business" }, mid - 1000)).toBe(
      false,
    );
    expect((await stored()).tier).toBe("team");
    expect(await cache({ version: 5, tier: "team" }, mid + 2000)).toBe(true);
    expect((await stored()).asOf).toBe(mid + 2000);
    expect(await cache({ version: 6, tier: "business" }, mid + 3000)).toBe(
      true,
    );
    expect((await stored()).tier).toBe("business");
  });

  it("the scheduler tick reads GET /tier through ctx.props.BILLING", async () => {
    row = { ...row, tier: "team", version: 3 };
    const ctx = {
      waitUntil: (p: Promise<unknown>) => pending.push(p),
      passThroughOnException() {},
      props: PROPS,
    } as unknown as ExecutionContext;
    const pending: Promise<unknown>[] = [];
    await scheduled({ cron: DIRECTORY_SYNC_CRON }, H, ctx);
    await Promise.all(pending);
    expect(calls.map((c) => c.path)).toContain("/tier");
    expect(await stored()).toMatchObject({ tier: "team", version: 3 });
  });

  it("on demand: at most once a minute across the instance", async () => {
    const run = () =>
      withBrokerProps({ props: PROPS }, () =>
        refreshPlan(H, Date.now(), { onDemand: true }),
      );
    expect(await run()).toBe("stored");
    expect(await run()).toBe("skipped");
    vi.setSystemTime(mid + ON_DEMAND_MS + 1);
    // Same version, read later: stored (asOf moves; the 7-day clock with it).
    expect(await run()).toBe("stored");
    expect(calls.filter((c) => c.path === "/tier")).toHaveLength(2);
  });

  it("a failed read keeps the last good tier and starts the 7-day clock once", async () => {
    await cache({ tier: "team", version: 2 }, mid);
    down = true;
    const fail = (t: number) =>
      withBrokerProps({ props: PROPS }, () => refreshPlan(H, t));
    expect(await fail(mid + 1000)).toBe("failed");
    expect(await fail(mid + 2000)).toBe("failed");
    const check = JSON.parse(
      (
        (await env.DB.prepare("select value from settings where key = ?")
          .bind(CHECK_KEY)
          .first<{ value: string }>()) as {
          value: string;
        }
      ).value,
    );
    expect(check).toEqual({
      checkedAt: mid + 2000,
      failingSince: mid + 1000,
      lastGoodAt: mid,
    });
    expect((await stored()).tier).toBe("team");
    // No gate at all (no props): no billing enforcement (B1). Nothing is
    // recorded, the 7-day clock doesn't move, never an HTTPS fallback.
    expect(await refreshPlan(H, mid + 3000)).toBe("skipped");
    const after = JSON.parse(
      (
        (await env.DB.prepare("select value from settings where key = ?")
          .bind(CHECK_KEY)
          .first<{ value: string }>()) as { value: string }
      ).value,
    );
    expect(after).toEqual(check);
  });

  it("no BILLING gate: inert; nothing recorded, no call, no plan whatever is cached or provisioned (B1, R2)", async () => {
    const TEAM = { ...H, TIER: "team" } as Env;
    for (const t of [mid, mid + 30 * DAY])
      expect(await refreshPlan(TEAM, t, { onDemand: true })).toBe("skipped");
    expect(
      await env.DB.prepare("select count(*) as n from settings where key = ?")
        .bind(CHECK_KEY)
        .first<{ n: number }>(),
    ).toEqual({ n: 0 });
    expect(calls).toEqual([]);
    expect(await readPlan(TEAM, mid + 30 * DAY)).toBeNull();
    await cache({ tier: "free", trialEndsAt: 1, version: 4 }, mid);
    expect(await readPlan(TEAM, mid + 30 * DAY)).toBeNull();
  });

  it("a good read of an older version stops the 7-day clock but never applies the older tier", async () => {
    await cache({ tier: "team", version: 5 }, mid);
    row = { ...row, tier: "business", version: 4 };
    const t = mid + PLAN_STALE_MS + DAY;
    vi.setSystemTime(t);
    expect(
      await withBrokerProps({ props: PROPS }, () => refreshPlan(H, t)),
    ).toBe("unchanged");
    expect((await stored()).tier).toBe("team");
    expect(
      await withBrokerProps({ props: PROPS }, () => readPlan(H, t)),
    ).toMatchObject({ tier: "team", lock: null });
    // Without that read, the same moment is our outage: read-only.
    await env.DB.prepare("delete from settings where key = ?")
      .bind(CHECK_KEY)
      .run();
    expect(
      (await withBrokerProps({ props: PROPS }, () => readPlan(H, t)))?.reason,
    ).toBe("billing_unreachable");
  });

  it("billing's no-row default (version 0) never overrides a provisioned TIER", async () => {
    const TEAM = { ...H, TIER: "team" } as Env;
    row = {
      tier: "free",
      status: "active",
      trialEndsAt: null,
      graceUntil: null,
      version: 0,
    };
    expect(
      await withBrokerProps({ props: PROPS }, () => refreshPlan(TEAM, mid)),
    ).toBe("unchanged");
    expect(
      await withBrokerProps({ props: PROPS }, () => readPlan(TEAM, mid)),
    ).toMatchObject({
      tier: "team",
      lock: null,
    });
    // Without a TIER, version 0 is the answer: free.
    expect(
      await withBrokerProps({ props: PROPS }, () => refreshPlan(H, mid)),
    ).toBe("stored");
    expect(
      (await withBrokerProps({ props: PROPS }, () => readPlan(H, mid)))?.tier,
    ).toBe("free");
  });

  it("self-hosted never calls billing", async () => {
    expect(
      await withBrokerProps({ props: PROPS }, () => refreshPlan(SELF, mid)),
    ).toBe("skipped");
    await withBrokerProps({ props: PROPS }, () => billingTick(SELF, mid));
    expect(calls).toEqual([]);
  });
});

// ------------------------------------------------------------- enforcement

describe("plan enforcement", () => {
  const readOnly = () => cache({ tier: "team", status: "lapsed", version: 9 });

  it("free: the first invite passes and starts the trial with a signed POST", async () => {
    row = {
      tier: "free",
      status: "active",
      trialEndsAt: null,
      graceUntil: null,
      version: 0,
    };
    await cache({});
    const r = await send(R.members, owner.cookie, {
      method: "POST",
      body: { email: `inv1-${tag}@a.com`, role: "member" },
    });
    expect(r.status).toBe(201);
    const trial = calls.find((c) => c.path === "/trial/start");
    expect(trial?.body).toEqual({ install: INSTALL, ts: expect.any(Number) });
    expect((await getMe(owner.cookie)).instance.billing).toMatchObject({
      tier: "trial",
      readOnly: false,
    });
  });

  it("free: an invite passes only if the trial starts; billing down is 503 billing_unavailable and no user is left", async () => {
    row = {
      tier: "free",
      status: "active",
      trialEndsAt: null,
      graceUntil: null,
      version: 0,
    };
    await cache({});
    down = true;
    const email = `inv-down-${tag}@a.com`;
    const r = await send(R.members, owner.cookie, {
      method: "POST",
      body: { email, role: "member" },
    });
    expect(r.status).toBe(503);
    expect(await errOf(r)).toMatchObject({ code: "billing_unavailable" });
    expect(
      await env.DB.prepare("select 1 from users where email = ?")
        .bind(email)
        .first(),
    ).toBeNull();
    // Billing back: the same invite passes and starts the trial.
    down = false;
    const ok = await send(R.members, owner.cookie, {
      method: "POST",
      body: { email, role: "member" },
    });
    expect(ok.status).toBe(201);
    expect(calls.some((c) => c.path === "/trial/start")).toBe(true);
  });

  it("a code session with no tenant is a guest even under a plan lock: no admin reads, no billing", async () => {
    await cache({ tier: "team", status: "lapsed", trialEndsAt: 1, version: 9 });
    const admin = await login(`admin-code-${tag}@a.com`, "admin");
    const code = `${sessionCookieName(env)}=${await signSession(
      env,
      admin.userId,
      Date.now(),
      { provider: "code", epoch: 0 },
    )}`;
    // The same admin on a normal session keeps the exemption (control).
    expect((await send(R.members, admin.cookie)).status).toBe(200);
    expect((await send(R.me, code)).status).toBe(200);
    expect((await send(R.members, code)).status).toBe(404);
    expect((await send(R.audit, code)).status).toBe(404);
    const p = await send(R.billingPortal, code, { method: "POST", body: {} });
    expect([403, 404]).toContain(p.status);
    expect(calls.some((c) => c.path === "/portal")).toBe(false);
  });

  it("read-only (lapsed team): the owner can't promote a member; a demotion still passes", async () => {
    const m = await login(`promo-${tag}@a.com`, "member");
    await cache({ tier: "team", status: "lapsed", trialEndsAt: 1, version: 9 });
    const r = await send(R.member(m.userId), owner.cookie, {
      method: "PATCH",
      body: { role: "admin" },
    });
    expect(r.status).toBe(403);
    expect(await errOf(r)).toMatchObject({ code: "plan_read_only" });
    const role = await env.DB.prepare("select role from users where id = ?")
      .bind(m.userId)
      .first<{ role: string }>();
    expect(role?.role).toBe("member");
    const a = await login(`demote-${tag}@a.com`, "admin");
    const d = await send(R.member(a.userId), owner.cookie, {
      method: "PATCH",
      body: { role: "member" },
    });
    expect(d.status).toBe(200);
  });

  it("free: when /trial/start says the trial was already used, the invite is 403 plan_required with the plan details, not 503; no user", async () => {
    row = {
      tier: "free",
      status: "active",
      trialEndsAt: null,
      graceUntil: null,
      version: 0,
    };
    await cache({});
    // Billing's own row says the trial ran (the install's cache is stale).
    trialAnswer = { ...row, trialEndsAt: 1, version: 5 };
    const email = `inv-used-${tag}@a.com`;
    const r = await send(R.members, owner.cookie, {
      method: "POST",
      body: { email, role: "member" },
    });
    expect(r.status).toBe(403);
    expect(await errOf(r)).toMatchObject({
      code: "plan_required",
      details: { tier: "free", reason: "solo" },
    });
    expect(
      await env.DB.prepare("select 1 from users where email = ?")
        .bind(email)
        .first(),
    ).toBeNull();
  });

  it("free, trial never ran: restoring a removed member takes the invite's path (409 on invite, restore starts the trial; billing down is 503)", async () => {
    row = {
      tier: "free",
      status: "active",
      trialEndsAt: null,
      graceUntil: null,
      version: 0,
    };
    await cache({});
    const gone = await login(`restore-${tag}@a.com`, "member");
    await env.DB.prepare("update users set status = 'removed' where id = ?")
      .bind(gone.userId)
      .run();
    const inv = await send(R.members, owner.cookie, {
      method: "POST",
      body: { email: `restore-${tag}@a.com`, role: "member" },
    });
    expect(inv.status).toBe(409);
    expect(await errOf(inv)).toMatchObject({ code: "member_removed" });
    expect(calls.some((c) => c.path === "/trial/start")).toBe(false);
    down = true;
    const bad = await send(R.memberRestore(gone.userId), owner.cookie, {
      method: "POST",
    });
    expect(bad.status).toBe(503);
    expect(await errOf(bad)).toMatchObject({ code: "billing_unavailable" });
    expect(
      (
        await env.DB.prepare("select status from users where id = ?")
          .bind(gone.userId)
          .first<{ status: string }>()
      )?.status,
    ).toBe("removed");
    down = false;
    const ok = await send(R.memberRestore(gone.userId), owner.cookie, {
      method: "POST",
    });
    expect(ok.status).toBe(200);
    expect(calls.some((c) => c.path === "/trial/start")).toBe(true);
  });

  it("HOSTED=1 with no BILLING gate and no TIER is inert: invite, share, agents and spaces work as on main; Me has no billing; billing routes 404", async () => {
    // Even a cached lapse is ignored without the gate.
    await cache({ tier: "free", status: "lapsed", trialEndsAt: 1, version: 3 });
    const admin = await login(`ng-admin-${tag}@a.com`, "admin");
    const mem = await login(`ng-mem-${tag}@a.com`, "member");
    const ng = (
      path: string,
      auth: string,
      init: { method?: string; body?: unknown } = {},
    ) =>
      fetchAndWait(
        app,
        new Request(`http://app.localhost${path}`, {
          method: init.method ?? "GET",
          headers: {
            cookie: auth,
            "x-oa-request": "1",
            ...(init.body === undefined
              ? {}
              : { "content-type": "application/json" }),
          },
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
        }),
        H,
      );
    // Invite: no plan lock, no trial start.
    const inv = await ng(R.members, admin.cookie, {
      method: "POST",
      body: { email: `ng-inv-${tag}@a.com`, role: "member" },
    });
    expect(inv.status).toBe(201);
    // A member publishes, shares, and publishes into a shared space.
    const art = await ng(R.artifacts, mem.cookie, {
      method: "POST",
      body: { title: "t", format: "html", content: "<p>x</p>" },
    });
    expect(art.status).toBe(201);
    const id = await idOf(art);
    expect(
      (
        await ng(R.shares(id), mem.cookie, {
          method: "PUT",
          body: { email: `ng-sh-${tag}@a.com`, role: "viewer" },
        })
      ).status,
    ).toBe(200);
    const sp = await ng(R.spaces, owner.cookie, {
      method: "POST",
      body: { name: `NG ${tag}` },
    });
    expect(sp.status).toBe(201);
    const spaceId = ((await sp.json()) as { id: string }).id;
    await env.DB.prepare(
      "insert into space_members (space_id, user_id, role, source, created_at) values (?, ?, 'editor', 'manual', 1)",
    )
      .bind(spaceId, mem.userId)
      .run();
    expect(
      (
        await ng(R.artifacts, mem.cookie, {
          method: "POST",
          body: { title: "t", format: "html", content: "<p>x</p>", spaceId },
        })
      ).status,
    ).toBe(201);
    // An AI agent (the member's PAT over /mcp) connects and works.
    const { token } = await createPat(env, mem.userId, "ng agent");
    const client = await connect(token, { env: H });
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    await client.close();
    // Me: no billing details; billing routes are hidden; nothing was called.
    const me = MeSchema.parse(await (await ng(R.me, owner.cookie)).json());
    expect(me.instance.billing).toBeUndefined();
    expect(
      (await ng(R.billingPortal, owner.cookie, { method: "POST", body: {} }))
        .status,
    ).toBe(404);
    expect(calls).toEqual([]);
  });

  it("a stale cache is cleared by a gateless request, so a later gate binding does not start read-only on an old lastGoodAt", async () => {
    const T = { ...H, TIER: "team" } as Env;
    const old = mid - 30 * DAY;
    await storePlan(
      T,
      {
        tier: "team",
        status: "active",
        trialEndsAt: null,
        graceUntil: null,
        version: 3,
        asOf: old,
      },
      old,
    );
    await env.DB.prepare(
      "insert or replace into settings (key, value) values (?, ?)",
    )
      .bind(CHECK_KEY, JSON.stringify({ checkedAt: old, failingSince: old }))
      .run();
    // A request with no gate (billing inert) clears them.
    const r = await fetchAndWait(
      app,
      new Request("http://app.localhost" + R.me, {
        headers: { cookie: owner.cookie },
      }),
      T,
    );
    expect(r.status).toBe(200);
    expect(
      await env.DB.prepare("select key from settings where key in (?, ?)")
        .bind(PLAN_KEY, CHECK_KEY)
        .all(),
    ).toMatchObject({ results: [] });
    // The gate is bound: nothing read yet is the provisioned TIER, not an outage.
    expect(
      await withBrokerProps({ props: PROPS }, () => readPlan(T, mid)),
    ).toMatchObject({ tier: "team", lock: null });
  });

  it("free after the trial: invites are 403 plan_required; nothing is created", async () => {
    await cache({ tier: "free", trialEndsAt: mid - DAY, version: 2 });
    const email = `inv2-${tag}@a.com`;
    const r = await send(R.members, owner.cookie, {
      method: "POST",
      body: { email, role: "member" },
    });
    expect(r.status).toBe(403);
    expect(await errOf(r)).toMatchObject({
      code: "plan_required",
      details: { tier: "free", reason: "solo" },
    });
    expect(
      await env.DB.prepare("select 1 from users where email = ?")
        .bind(email)
        .first(),
    ).toBeNull();
    expect(calls.some((c) => c.path === "/trial/start")).toBe(false);
  });

  it("free: everyone but the owner is read-only (cap plan); the owner's own artifacts stay writable", async () => {
    await cache({ tier: "free", trialEndsAt: mid - DAY, version: 2 });
    const me = await getMe(member.cookie);
    expect(me.auth).toMatchObject({ readOnly: true, cap: "plan" });
    const denied = await publish(member.cookie);
    expect(denied.status).toBe(403);
    expect((await errOf(denied)).code).toBe("plan_required");
    expect((await publish(owner.cookie)).status).toBe(201);
  });

  it("read-only: no write path lets anyone but the owner change anything; reads and removals stay", async () => {
    await cache({});
    const a = await idOf(await publish(owner.cookie, { visibility: "team" }));
    const shared = await idOf(
      await publish(member.cookie, { visibility: "team" }),
    );
    await readOnly();
    const code = async (r: Response) => [r.status, (await errOf(r)).code];
    // Others: versions, renames, data, uploads, tokens.
    expect(
      await code(
        await send(R.versions(shared), member.cookie, {
          method: "POST",
          body: { format: "html", content: "<p>y</p>" },
        }),
      ),
    ).toEqual([403, "plan_read_only"]);
    expect(
      await code(
        await send(R.artifact(shared), member.cookie, {
          method: "PATCH",
          body: { title: "z" },
        }),
      ),
    ).toEqual([403, "plan_read_only"]);
    expect(
      await code(
        await send(R.dataDoc(shared, "c", "d"), member.cookie, {
          method: "PUT",
          raw: '{"v":1}',
        }),
      ),
    ).toEqual([403, "plan_read_only"]);
    expect(
      await code(
        await send(R.uploads, member.cookie, {
          method: "POST",
          body: {
            artifactId: shared,
            path: "a.png",
            size: 3,
            contentType: "image/png",
          },
        }),
      ),
    ).toEqual([403, "plan_read_only"]);
    expect(
      await code(
        await send(R.tokens, member.cookie, {
          method: "POST",
          body: { label: "x" },
        }),
      ),
    ).toEqual([403, "plan_read_only"]);
    // Reads stay: the team artifact, its versions.
    expect((await send(R.artifact(a), member.cookie)).status).toBe(200);
    expect((await send(R.versions(shared), member.cookie)).status).toBe(200);
    // The owner: own personal artifacts writable; shares and invites refused.
    expect(
      (
        await send(R.versions(a), owner.cookie, {
          method: "POST",
          body: { format: "html", content: "<p>2</p>" },
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await send(R.dataDoc(a, "c", "d"), owner.cookie, {
          method: "PUT",
          raw: '{"v":1}',
        })
      ).status,
    ).toBe(200);
    expect(
      await code(
        await send(R.shares(a), owner.cookie, {
          method: "PUT",
          body: { email: `s-${tag}@a.com`, role: "viewer" },
        }),
      ),
    ).toEqual([403, "plan_read_only"]);
    expect(
      await code(
        await send(R.members, owner.cookie, {
          method: "POST",
          body: { email: `inv3-${tag}@a.com`, role: "member" },
        }),
      ),
    ).toEqual([403, "plan_read_only"]);
    expect(
      await code(
        await send(R.spaces, owner.cookie, {
          method: "POST",
          body: { name: `S ${tag}` },
        }),
      ),
    ).toEqual([403, "plan_read_only"]);
    // Removals pass: dropping a teammate is how a team goes back to free.
    const gone = await login(`gone-${tag}@a.com`, "member");
    expect(
      (await send(R.member(gone.userId), owner.cookie, { method: "DELETE" }))
        .status,
    ).toBe(204);
  });

  it("read-only: the owner can't write into a shared space, nor move into one", async () => {
    await cache({});
    const r = await send(R.spaces, owner.cookie, {
      method: "POST",
      body: { name: `Sp ${tag}` },
    });
    expect(r.status).toBe(201);
    const spaceId = ((await r.json()) as { id: string }).id;
    const inSpace = await idOf(await publish(owner.cookie, { spaceId }));
    const mine = await idOf(await publish(owner.cookie));
    await readOnly();
    const code = async (r: Response) => [r.status, (await errOf(r)).code];
    expect(await code(await publish(owner.cookie, { spaceId }))).toEqual([
      403,
      "plan_read_only",
    ]);
    expect(
      await code(
        await send(R.versions(inSpace), owner.cookie, {
          method: "POST",
          body: { format: "html", content: "<p>2</p>" },
        }),
      ),
    ).toEqual([403, "plan_read_only"]);
    expect(
      await code(
        await send(R.dataDoc(inSpace, "c", "d"), owner.cookie, {
          method: "PUT",
          raw: "{}",
        }),
      ),
    ).toEqual([403, "plan_read_only"]);
    expect(
      await code(
        await send(R.moveArtifact(mine), owner.cookie, {
          method: "POST",
          body: { spaceId },
        }),
      ),
    ).toEqual([403, "plan_read_only"]);
    // Still readable.
    expect((await send(R.artifact(inSpace), owner.cookie)).status).toBe(200);
  });

  it("read-only: anonymous live-data writes are refused; free allows them on the owner's public page", async () => {
    const a = await idOf(
      await publish(owner.cookie, {
        visibility: "public",
        dataWriters: "viewers",
      }),
    );
    const anon = () =>
      send(R.dataDoc(a, "votes", newId()), null, {
        method: "PUT",
        raw: '{"v":1}',
      });
    await cache({ tier: "free", version: 2 });
    const ok = await anon();
    expect([200, 429]).toContain(ok.status);
    await readOnly();
    const r = await anon();
    expect(r.status).toBe(403);
    expect((await errOf(r)).code).toBe("plan_read_only");
  });

  it("MCP agents: the owner's agent is refused team writes and counted for its data writes", async () => {
    await cache({});
    const sp = await send(R.spaces, owner.cookie, {
      method: "POST",
      body: { name: `Mcp ${tag}` },
    });
    const spaceId = ((await sp.json()) as { id: string }).id;
    const inSpace = await idOf(await publish(owner.cookie, { spaceId }));
    const mine = await idOf(await publish(owner.cookie));
    const t = await send(R.tokens, owner.cookie, {
      method: "POST",
      body: { label: `mcp ${tag}` },
    });
    const pat = ((await t.json()) as { token: string }).token;
    await readOnly();
    await env.DB.prepare("delete from creator_months").run();
    forgetRecordedCreators();
    const client = await connect(pat, { env: H, props: PROPS });
    try {
      const refused = await tool(client, "artifact_data_set", {
        id: inSpace,
        collection: "c",
        docId: "d",
        data: { v: 1 },
      });
      expect(refused.isError).toBe(true);
      expect(textOf(refused)).toContain("read-only");
      const share = await tool(client, "share_artifact", {
        id: mine,
        email: `m-${tag}@a.com`,
        role: "viewer",
      });
      expect(share.isError).toBe(true);
      const ok = await tool(client, "artifact_data_set", {
        id: mine,
        collection: "c",
        docId: "d",
        data: { v: 1 },
      });
      expect(ok.isError).toBeFalsy();
      expect(await creatorsOf(H, monthOf(Date.now()))).toEqual([owner.userId]);
    } finally {
      await client.close();
    }
  });

  it("the CSRF header is still required on cookie writes", async () => {
    await readOnly();
    const r = await send(R.members, owner.cookie, {
      method: "POST",
      csrf: false,
      body: { email: `c-${tag}@a.com`, role: "member" },
    });
    expect(r.status).toBe(403);
    expect((await errOf(r)).code).toBe("csrf");
  });

  it("trial and paid tiers change nothing; self-hosted ignores a cached lapse", async () => {
    await cache({ tier: "trial", trialEndsAt: mid + DAY, version: 2 });
    expect((await publish(member.cookie)).status).toBe(201);
    await cache({ tier: "team", status: "lapsed", version: 3 });
    expect((await publish(member.cookie, {}, SELF)).status).toBe(201);
  });
});

// ------------------------------------------------------------ creator count

describe("creator count", () => {
  it("counts versions and editor data writes, agents for their owner; not restores, moves or viewers", async () => {
    await cache({ tier: "business", version: 2 });
    const month = monthOf(Date.now());
    // A publish (session) and a version.
    const a = await idOf(await publish(owner.cookie));
    expect(await creatorsOf(H, month)).toEqual([owner.userId]);
    // An agent's (PAT) publish counts for the member who owns the token.
    const t = await send(R.tokens, member.cookie, {
      method: "POST",
      body: { label: `agent ${tag}` },
    });
    expect(t.status).toBe(201);
    const pat = ((await t.json()) as { token: string }).token;
    expect((await publish(pat)).status).toBe(201);
    expect((await creatorsOf(H, month)).sort()).toEqual(
      [owner.userId, member.userId].sort(),
    );
    // A restore and a move never count.
    const v = await login(`restorer-${tag}@a.com`, "member");
    const own = await idOf(await publish(v.cookie));
    await env.DB.prepare("delete from creator_months where user_id = ?")
      .bind(v.userId)
      .run();
    expect(
      (await send(R.restoreVersion(own, 1), v.cookie, { method: "POST" }))
        .status,
    ).toBe(201);
    const sp = await send(R.spaces, owner.cookie, {
      method: "POST",
      body: { name: `Mv ${tag}` },
    });
    const spaceId = ((await sp.json()) as { id: string }).id;
    await env.DB.prepare(
      "insert into space_members (space_id, user_id, role, source, created_at) values (?, ?, 'editor', 'manual', 1)",
    )
      .bind(spaceId, v.userId)
      .run();
    expect(
      (
        await send(R.moveArtifact(own), v.cookie, {
          method: "POST",
          body: { spaceId },
        })
      ).status,
    ).toBe(200);
    expect(await creatorsOf(H, month)).not.toContain(v.userId);
    // A viewer's data write is free; an editor's counts.
    const poll = await idOf(
      await publish(owner.cookie, {
        visibility: "team",
        dataWriters: "viewers",
      }),
    );
    const viewer = await login(`viewer-${tag}@a.com`, "member");
    expect(
      (
        await send(R.dataDoc(poll, "c", "d"), viewer.cookie, {
          method: "PUT",
          raw: "{}",
        })
      ).status,
    ).toBe(200);
    expect(await creatorsOf(H, month)).not.toContain(viewer.userId);
    expect(
      (
        await send(R.shares(poll), owner.cookie, {
          method: "PUT",
          body: { email: `editor-${tag}@a.com`, role: "editor" },
        })
      ).status,
    ).toBe(200);
    const editor = await login(`editor-${tag}@a.com`, "member");
    expect(
      (
        await send(R.dataDoc(poll, "c", "e"), editor.cookie, {
          method: "PUT",
          raw: "{}",
        })
      ).status,
    ).toBe(200);
    expect(await creatorsOf(H, month)).toContain(editor.userId);
    // Exact: owner, member (agent), editor. Each once.
    expect((await creatorsOf(H, month)).sort()).toEqual(
      [owner.userId, member.userId, editor.userId].sort(),
    );
    void a;
  });

  it("no creator_months rows without the BILLING gate", async () => {
    const r = await fetchAndWait(
      app,
      new Request("http://app.localhost" + R.artifacts, {
        method: "POST",
        headers: {
          cookie: owner.cookie,
          "x-oa-request": "1",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          title: "t",
          format: "html",
          content: "<p>x</p>",
        }),
      }),
      H,
    );
    expect(r.status).toBe(201);
    expect(await creatorsOf(H, monthOf(Date.now()))).toEqual([]);
    // The same publish with the gate counts.
    await publish(owner.cookie);
    expect(await creatorsOf(H, monthOf(Date.now()))).toEqual([owner.userId]);
  });

  it("the first report starts at the go-live month (first good /tier read), never before", async () => {
    const live = monthOf(mid);
    const before1 = previousMonth(live);
    const before2 = previousMonth(before1);
    await env.DB.prepare(
      "insert into creator_months (month, user_id, source, first_at) values (?, 'uA', 'version', 1), (?, 'uB', 'version', 2), (?, 'uC', 'version', 3)",
    )
      .bind(before2, before1, live)
      .run();
    // No good read yet: nothing to report to.
    await withBrokerProps({ props: PROPS }, () => usageTick(H, mid + 40 * DAY));
    expect(calls.filter((c) => c.path === "/usage")).toEqual([]);
    // The first good read marks the go-live month.
    expect(
      await withBrokerProps({ props: PROPS }, () => refreshPlan(H, mid)),
    ).toBe("stored");
    await withBrokerProps({ props: PROPS }, () => usageTick(H, mid));
    expect(calls.filter((c) => c.path === "/usage")).toEqual([]);
    await withBrokerProps({ props: PROPS }, () => usageTick(H, mid + 40 * DAY));
    expect(
      calls.filter((c) => c.path === "/usage").map((c) => c.body?.month),
    ).toEqual([live]);
  });

  it("self-hosted records nothing", async () => {
    await publish(owner.cookie, {}, SELF);
    expect(await creatorsOf(H, monthOf(Date.now()))).toEqual([]);
  });

  it("the monthly report: the previous UTC month's list, signed, once", async () => {
    await env.DB.prepare(
      "insert or replace into settings (key, value) values (?, '2000-01')",
    )
      .bind(LIVE_KEY)
      .run();
    const prev = previousMonth(monthOf(mid));
    await env.DB.prepare(
      "insert into creator_months (month, user_id, source, first_at) values (?, ?, 'version', 1), (?, ?, 'data', 2), (?, ?, 'version', 3)",
    )
      .bind(prev, "uB", prev, "uA", monthOf(mid), "uC")
      .run();
    await withBrokerProps({ props: PROPS }, () => usageTick(H, mid));
    await withBrokerProps({ props: PROPS }, () => usageTick(H, mid + 1000));
    const usage = calls.filter((c) => c.path === "/usage");
    expect(usage).toHaveLength(1);
    expect(usage[0]?.body).toEqual({
      install: INSTALL,
      ts: mid,
      month: prev,
      count: 2,
      creators: ["uA", "uB"],
    });
    expect(
      (
        await env.DB.prepare("select value from settings where key = ?")
          .bind(USAGE_SENT_KEY)
          .first<{ value: string }>()
      )?.value,
    ).toBe(prev);
    expect(previousMonth("2026-01")).toBe("2025-12");
  });

  it("the monthly report with nothing ever sent starts at the oldest month with creators, oldest first", async () => {
    await env.DB.prepare(
      "insert or replace into settings (key, value) values (?, '2000-01')",
    )
      .bind(LIVE_KEY)
      .run();
    const prev = previousMonth(monthOf(mid));
    const mid1 = previousMonth(prev);
    const oldest = previousMonth(mid1);
    await env.DB.prepare(
      "insert into creator_months (month, user_id, source, first_at) values (?, 'uA', 'version', 1), (?, 'uB', 'version', 2)",
    )
      .bind(oldest, prev)
      .run();
    await withBrokerProps({ props: PROPS }, () => usageTick(H, mid));
    expect(
      calls.filter((c) => c.path === "/usage").map((c) => c.body?.month),
    ).toEqual([oldest, mid1, prev]);
  });

  it("the monthly report sends every unsent month after the last sent one, oldest first", async () => {
    await env.DB.prepare(
      "insert or replace into settings (key, value) values (?, '2000-01')",
    )
      .bind(LIVE_KEY)
      .run();
    const prev = previousMonth(monthOf(mid));
    const skipped = previousMonth(prev);
    const sent = previousMonth(skipped);
    await env.DB.prepare(
      "insert into creator_months (month, user_id, source, first_at) values (?, 'uA', 'version', 1), (?, 'uB', 'version', 2), (?, 'uC', 'version', 3)",
    )
      .bind(sent, skipped, prev)
      .run();
    await env.DB.prepare("insert into settings (key, value) values (?, ?)")
      .bind(USAGE_SENT_KEY, sent)
      .run();
    await withBrokerProps({ props: PROPS }, () => usageTick(H, mid));
    expect(
      calls.filter((c) => c.path === "/usage").map((c) => c.body?.month),
    ).toEqual([skipped, prev]);
    expect(
      (
        await env.DB.prepare("select value from settings where key = ?")
          .bind(USAGE_SENT_KEY)
          .first<{ value: string }>()
      )?.value,
    ).toBe(prev);
  });
});

// ------------------------------------------------------- Me and the routes

describe("Me.instance.billing and the billing routes", () => {
  it("owner and admins see the details; members see tier, readOnly and reason only", async () => {
    await cache({
      tier: "team",
      status: "past_due",
      graceUntil: mid + DAY,
      version: 4,
    });
    const me = await getMe(owner.cookie);
    // B2: one tier everywhere.
    expect(me.instance.tier).toBe("team");
    const o = me.instance.billing;
    expect(o).toEqual({
      tier: "team",
      status: "past_due",
      trialEndsAt: null,
      graceUntil: new Date(mid + DAY).toISOString(),
      creatorsThisMonth: 0,
      readOnly: false,
    });
    const m = (await getMe(member.cookie)).instance.billing;
    expect(m).toEqual({
      tier: "team",
      status: null,
      trialEndsAt: null,
      graceUntil: null,
      readOnly: false,
    });
    // Self-hosted: absent.
    const self = await send(R.me, owner.cookie, { e: SELF });
    expect(MeSchema.parse(await self.json()).instance.billing).toBeUndefined();
  });

  it("the billing routes need an interactive cookie session: a PAT, an OAuth grant and an MCP agent are refused, even the owner's", async () => {
    await cache({ tier: "trial", trialEndsAt: mid + DAY, version: 2 });
    const { token } = await createPat(env, owner.userId, "billing pat");
    const { accessToken } = await oauthToken(
      `owner-${tag}@a.com`,
      "Billing Agent",
      owner,
    );
    const bearer = (path: string, t: string, body: unknown) =>
      fetchAndWait(
        app,
        new Request(`http://app.localhost${path}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${t}`,
            "content-type": "application/json",
            "x-oa-request": "1",
          },
          body: JSON.stringify(body),
        }),
        H,
        PROPS,
      );
    // An MCP agent (the owner's PAT over /mcp) has no billing tool at all.
    const client = await connect(token, { env: H, props: PROPS });
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools.some((n) => /billing|checkout|portal|usage/.test(n))).toBe(
      false,
    );
    await client.close();
    for (const [path, body] of [
      [R.billingCheckout, { tier: "team" }],
      [R.billingPortal, {}],
      [R.billingUsage, {}],
    ] as const) {
      expect([401, 404]).toContain(
        (await bearer(path, accessToken, body)).status,
      );
    }
    expect(
      calls.some((c) => ["/checkout", "/portal", "/usage"].includes(c.path)),
    ).toBe(false);
    for (const [path, body] of [
      [R.billingCheckout, { tier: "team" }],
      [R.billingPortal, {}],
      [R.billingUsage, {}],
    ] as const) {
      expect((await send(path, token, { method: "POST", body })).status).toBe(
        404,
      );
      // The same call on a cookie session is the control.
      expect(
        (await send(path, owner.cookie, { method: "POST", body })).status,
      ).toBe(200);
    }
  });

  it("checkout and portal: a Stripe URL only, signed; owner and admin only", async () => {
    await cache({ tier: "trial", trialEndsAt: mid + DAY, version: 2 });
    const r = await send(R.billingCheckout, owner.cookie, {
      method: "POST",
      body: { tier: "team" },
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      url: "https://checkout.stripe.com/c/pay/cs_test_1",
    });
    expect(calls.find((c) => c.path === "/checkout")?.body).toMatchObject({
      install: INSTALL,
      plan: "team",
    });
    const p = await send(R.billingPortal, owner.cookie, {
      method: "POST",
      body: {},
    });
    expect(await p.json()).toEqual({
      url: "https://billing.stripe.com/p/session/test_1",
    });
    expect(
      (
        await send(R.billingCheckout, member.cookie, {
          method: "POST",
          body: { tier: "team" },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await send(R.billingCheckout, null, {
          method: "POST",
          body: { tier: "team" },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await send(R.billingCheckout, owner.cookie, {
          method: "POST",
          body: { tier: "enterprise" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await send(R.billingCheckout, owner.cookie, {
          method: "POST",
          body: { tier: "team" },
          e: SELF,
        })
      ).status,
    ).toBe(404);
    down = true;
    const d = await send(R.billingPortal, owner.cookie, {
      method: "POST",
      body: {},
    });
    expect(d.status).toBe(503);
    expect((await errOf(d)).code).toBe("billing_unavailable");
  });

  it("a non-Stripe URL from billing is never handed out", async () => {
    await cache({ tier: "team", version: 2 });
    const orig = gate.fetch;
    gate.fetch = async () => Response.json({ url: "https://evil.example/pay" });
    try {
      const r = await send(R.billingPortal, owner.cookie, {
        method: "POST",
        body: {},
      });
      expect(r.status).toBe(503);
    } finally {
      gate.fetch = orig;
    }
  });

  it("billing's 503 retry (Stripe 409): one more try with the same signed body after the backoff, then billing_unavailable (R7)", async () => {
    await cache({ tier: "team", version: 2 });
    const orig = gate.fetch;
    const wait = billingRetry.wait;
    const waits: number[] = [];
    billingRetry.wait = async (ms) => {
      waits.push(ms);
    };
    // Each answer in turn; the bodies each try sent.
    let answers: Array<() => Response> = [];
    const bodies: string[] = [];
    gate.fetch = async (req: Request) => {
      bodies.push(await req.text());
      const next = answers.shift();
      if (!next) throw new Error("unexpected call");
      return next();
    };
    const retry = () => Response.json({ error: "retry" }, { status: 503 });
    const ok = () =>
      Response.json({ url: "https://checkout.stripe.com/c/pay/cs_test_2" });
    const checkout = () =>
      send(R.billingCheckout, owner.cookie, {
        method: "POST",
        body: { tier: "business" },
      });
    try {
      // Retry, then the session: 200, the same body twice, one backoff.
      answers = [retry, ok];
      const r = await checkout();
      expect(await r.json()).toEqual({
        url: "https://checkout.stripe.com/c/pay/cs_test_2",
      });
      expect(bodies).toHaveLength(2);
      expect(bodies[1]).toBe(bodies[0]);
      expect(waits).toEqual([billingRetry.backoffMs]);
      // Retry twice: 503 billing_unavailable, no third call.
      bodies.length = 0;
      answers = [retry, retry];
      const d = await checkout();
      expect(d.status).toBe(503);
      expect((await errOf(d)).code).toBe("billing_unavailable");
      expect(bodies).toHaveLength(2);
      // Any other 503 (or the gate's refusal) is not retried.
      bodies.length = 0;
      answers = [() => Response.json({ error: "upstream" }, { status: 503 })];
      expect((await checkout()).status).toBe(503);
      expect(bodies).toHaveLength(1);
      expect(waits).toHaveLength(2);
    } finally {
      gate.fetch = orig;
      billingRetry.wait = wait;
    }
  });
});
