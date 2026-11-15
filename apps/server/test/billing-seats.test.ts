// Per-member billing, install side (#2580): who counts, the signed POST
// /seats after every write that can move the count, and the daily tick.
import { env } from "cloudflare:workers";
import { newId, R } from "@oa/shared";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withBrokerProps } from "../src/auth/broker-transport.js";
import { ROUTE_POLICY } from "../src/auth/route-policy-table.js";
import {
  memberCount,
  reportSeats,
  SEAT_ROUTES,
  SEAT_ROUTES_EXEMPT,
  SEATS_DAILY_MS,
  SEATS_SENT_KEY,
} from "../src/billing/seats.js";
import { DIRECTORY_SYNC_CRON, scheduled } from "../src/cron.js";
import {
  cachePlan,
  clearBilling,
  fakeBilling,
  H,
  send,
} from "./billing-helpers.js";
import { login } from "./helpers.js";
import { pinMiddayUtc } from "./midday.js";

const tag = newId().slice(0, 6).toLowerCase();
const { s: fake, props } = fakeBilling();
const seen = (id: string, at: number | null = 5) =>
  env.DB.prepare("update users set last_seen_at = ?2 where id = ?1")
    .bind(id, at)
    .run();
// A listed write that moves nothing: promotes an admin to admin.
const poke = async () => {
  const r = await send(props, R.member(admin.userId), owner.cookie, {
    method: "PATCH",
    body: { role: "admin" },
  });
  expect(r.status).toBe(200);
};
const seatCalls = () => fake.calls.filter((c) => c.path === "/seats");
const lastSeats = () => seatCalls().at(-1)?.body;
let seq = 0;
let admin: { cookie: string; userId: string };
let owner: { cookie: string; userId: string };

async function person(name: string, role: "admin" | "member" | "guest") {
  const u = await login(`${name}${++seq}-${tag}@x.com`, role);
  await seen(u.userId);
  return u;
}

beforeAll(async () => {
  pinMiddayUtc();
  owner = await login(`own-${tag}@x.com`, "owner");
  admin = await login(`adm-${tag}@x.com`, "admin");
});

beforeEach(async () => {
  await clearBilling();
  fake.calls.length = 0;
  await cachePlan({
    tier: "team",
    status: "active",
    trialEndsAt: null,
    graceUntil: null,
    version: 1,
  });
  // A clean roster: only the owner, signed in.
  await env.DB.prepare("update users set last_seen_at = null").run();
  await seen(owner.userId);
});

describe("memberCount", () => {
  it("counts owner, admin and member who have signed in; nobody else", async () => {
    expect(await memberCount(env)).toBe(1);
    await person("a", "admin");
    await person("m", "member");
    expect(await memberCount(env)).toBe(3);
    // Never counted: guest, never signed in, suspended, removed, erased,
    // restricted (by hand or by sync).
    await person("g", "guest");
    await login(`never${++seq}-${tag}@x.com`, "member");
    const s = await person("s", "member");
    const r = await person("r", "member");
    const e = await person("e", "member");
    const rm = await person("rm", "member");
    const rs = await person("rs", "member");
    await env.DB.prepare("update users set status = 'suspended' where id = ?")
      .bind(s.userId)
      .run();
    await env.DB.prepare("update users set restricted_manual = 1 where id = ?")
      .bind(r.userId)
      .run();
    await env.DB.prepare(
      "update users set status = 'removed', erased_at = 9 where id = ?",
    )
      .bind(e.userId)
      .run();
    await env.DB.prepare("update users set status = 'removed' where id = ?")
      .bind(rm.userId)
      .run();
    await env.DB.prepare("update users set restricted_sync = 1 where id = ?")
      .bind(rs.userId)
      .run();
    expect(await memberCount(env)).toBe(3);
  });
});

describe("POST /seats after every write that moves the count", () => {
  it("role change: guest to member", async () => {
    const g = await person("g", "guest");
    fake.calls.length = 0;
    const up = await send(props, R.member(g.userId), owner.cookie, {
      method: "PATCH",
      body: { role: "member" },
    });
    expect(up.status).toBe(200);
    expect(lastSeats()).toMatchObject({ members: 2 });
  });

  it("remove, restore", async () => {
    const m = await person("m", "member");
    await send(props, R.member(m.userId), owner.cookie, {
      method: "PATCH",
      body: { role: "admin" },
    });
    fake.calls.length = 0;
    expect(
      (
        await send(props, R.member(m.userId), owner.cookie, {
          method: "DELETE",
        })
      ).status,
    ).toBe(204);
    expect(lastSeats()).toMatchObject({ members: 1 });
    expect(
      (
        await send(props, R.memberRestore(m.userId), owner.cookie, {
          method: "POST",
        })
      ).status,
    ).toBe(200);
    expect(lastSeats()).toMatchObject({ members: 2 });
  });

  it("restrict and unrestrict", async () => {
    const m = await person("m", "member");
    await send(props, R.memberRestricted(m.userId), owner.cookie, {
      method: "PUT",
    });
    expect(lastSeats()).toMatchObject({ members: 1 });
    await send(props, R.memberRestricted(m.userId), owner.cookie, {
      method: "DELETE",
    });
    expect(lastSeats()).toMatchObject({ members: 2 });
  });

  it("erase", async () => {
    const m = await person("m", "member");
    await send(props, R.member(m.userId), owner.cookie, { method: "DELETE" });
    fake.calls.length = 0;
    await send(props, R.memberErase(m.userId), owner.cookie, {
      method: "POST",
    });
    // Already out of the count when removed: the count did not move.
    expect(seatCalls().length).toBe(0);
  });

  it("a first login is reported by the next listed write", async () => {
    const fresh = await login(`first${++seq}-${tag}@x.com`, "member");
    await poke();
    expect(lastSeats()).toMatchObject({ members: 1 });
    await seen(fresh.userId);
    await poke();
    expect(lastSeats()).toMatchObject({ members: 2 });
  });

  it("an unchanged count sends nothing; a failed send is retried by the next hook", async () => {
    await poke();
    const n = seatCalls().length;
    await poke();
    expect(seatCalls().length).toBe(n);
    await person("m", "member");
    fake.down = true;
    await poke();
    fake.down = false;
    expect(
      await env.DB.prepare("select value from settings where key = ?")
        .bind(SEATS_SENT_KEY)
        .first<{ value: string }>(),
    ).toMatchObject({ value: expect.stringContaining('"members":1') });
    await poke();
    expect(lastSeats()).toMatchObject({ members: 2 });
  });

  it("self-hosted: never sent", async () => {
    await send(props, "/auth/providers", null, {
      e: { ...H, HOSTED: undefined } as never,
    });
    expect(seatCalls().length).toBe(0);
  });
});

describe("the route list", () => {
  it("every members and directory write is listed or exempt, and every listed route exists", () => {
    const writes = Object.keys(ROUTE_POLICY).filter((k) =>
      /^(POST|PUT|PATCH|DELETE) \/api\/v1\/(members|directory)/.test(k),
    );
    for (const k of writes)
      expect(SEAT_ROUTES.has(k) || SEAT_ROUTES_EXEMPT.has(k), k).toBe(true);
    for (const k of SEAT_ROUTES) expect(k in ROUTE_POLICY, k).toBe(true);
  });

  it("a data write does not trigger a report", async () => {
    await send(props, R.artifacts, owner.cookie, {
      method: "POST",
      body: { title: "x", format: "html", content: "<p>x</p>" },
    });
    expect(seatCalls().length).toBe(0);
  });
});

describe("billing's outcome", () => {
  it("retry: true is resent on the next tick; false, absent or any outcome name waits a day", async () => {
    const run = (at: number) =>
      withBrokerProps({ props }, () => reportSeats(H, at, true));
    const t0 = Date.now();
    fake.seatsApplied = "no_subscription";
    fake.seatsRetry = true;
    await run(t0);
    await run(t0 + 120_000);
    expect(seatCalls().length).toBe(2);
    fake.seatsRetry = false;
    await run(t0 + 240_000);
    expect(seatCalls().length).toBe(3);
    await run(t0 + 360_000);
    expect(seatCalls().length).toBe(3);
    // An older billing sends no retry: settled, whatever the outcome.
    fake.seatsRetry = undefined;
    fake.seatsApplied = "held";
    await run(t0 + 2 * SEATS_DAILY_MS);
    await run(t0 + 2 * SEATS_DAILY_MS + 120_000);
    expect(seatCalls().length).toBe(4);
  });
});

describe("daily reconcile", () => {
  it("the scheduled billing tick sends once a day", async () => {
    const run = (at: number) =>
      withBrokerProps({ props }, () => reportSeats(H, at, true));
    const t0 = Date.now();
    await run(t0);
    expect(seatCalls().length).toBe(1);
    await run(t0 + 60_000);
    expect(seatCalls().length).toBe(1);
    await run(t0 + SEATS_DAILY_MS + 1);
    expect(seatCalls().length).toBe(2);
    expect(lastSeats()).toMatchObject({ members: 1 });
  });

  it("the cron tick runs it", async () => {
    const pending: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (p: Promise<unknown>) => pending.push(p),
      passThroughOnException() {},
      props,
    } as unknown as ExecutionContext;
    await scheduled({ cron: DIRECTORY_SYNC_CRON }, H, ctx);
    await Promise.all(pending);
    expect(seatCalls().length).toBe(1);
  });
});
