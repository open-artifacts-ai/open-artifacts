// Per-member billing, install side (#2580): who counts, the signed POST
// /seats after every write that can move the count, and the daily tick.
import { env } from "cloudflare:workers";
import { newId, R } from "@oa/shared";
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
import { ROUTE_POLICY } from "../src/auth/route-policy-table.js";
import {
  memberCount,
  reportSeats,
  SEAT_ROUTES,
  SEAT_ROUTES_EXEMPT,
  SEATS_DAILY_MS,
  SEATS_JUMP_ACK_KEY,
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

describe("billing from before #2580", () => {
  afterEach(() => {
    fake.legacy = false;
  });

  it("checkout retries once without members, with a fresh ts", async () => {
    fake.legacy = true;
    const r = await send(props, R.billingCheckout, owner.cookie, {
      method: "POST",
      body: { tier: "team" },
    });
    expect(r.status).toBe(200);
    const co = fake.calls.filter((c) => c.path === "/checkout");
    expect(co.map((c) => c.status)).toEqual([400, 200]);
    expect(co[0]?.body).toHaveProperty("members");
    expect(co[1]?.body).not.toHaveProperty("members");
    expect(co[1]?.body).toMatchObject({
      plan: "team",
      creators: expect.any(Number),
    });
    expect(Number(co[1]?.body?.ts)).toBeGreaterThan(Number(co[0]?.body?.ts));
  });

  it("a yearly checkout (seats and members) falls back the same way", async () => {
    fake.legacy = true;
    const r = await send(props, R.billingCheckout, owner.cookie, {
      method: "POST",
      body: { tier: "team", interval: "year", seats: 3 },
    });
    // Yearly carries members too: it falls back the same way.
    expect(r.status).toBe(200);
    expect(
      fake.calls.filter((c) => c.path === "/checkout").map((c) => c.status),
    ).toEqual([400, 200]);
  });

  it("/seats 404 is settled: no soon retry, nothing thrown", async () => {
    fake.legacy = true;
    const run = (at: number) =>
      withBrokerProps({ props }, () => reportSeats(H, at, true));
    const t0 = Date.now();
    await run(t0);
    await run(t0 + 120_000);
    expect(seatCalls().length).toBe(1);
    await run(t0 + SEATS_DAILY_MS + 1);
    expect(seatCalls().length).toBe(2);
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

describe("a big jump billed at once emails the owner (#2588)", () => {
  const sends: { to: string; subject: string; text: string; html: string }[] =
    [];
  let failSend = false;
  const HE = () =>
    ({
      ...(H as object),
      EMAIL: {
        send: vi.fn(async (m: (typeof sends)[number]) => {
          if (failSend) throw new Error("boom");
          sends.push(m);
          return { messageId: `m${sends.length}` };
        }),
      },
      EMAIL_FROM: "noreply@x.com",
    }) as unknown as typeof H;
  const run = (e: typeof H, at: number) =>
    withBrokerProps({ props }, () => reportSeats(e, at, true));
  const jumpKeys = () =>
    env.DB.prepare(
      "select key from settings where key like 'billing.seats.jump:%'",
    )
      .all<{ key: string }>()
      .then((r) => r.results);
  beforeEach(async () => {
    sends.length = 0;
    failSend = false;
    fake.seatsJump = undefined;
    await env.DB.prepare(
      "delete from settings where key like 'billing.seats.jump:%'",
    ).run();
    await env.DB.prepare("delete from counters where key like 'email:%'").run();
  });
  afterEach(() => {
    fake.seatsJump = undefined;
    fake.seatsRetry = undefined;
  });

  it("a jump sends one email to the owner with Product's copy", async () => {
    fake.seatsJump = { from: 3, to: 14 };
    await run(HE(), Date.now());
    expect(sends).toHaveLength(1);
    const m = sends[0] as (typeof sends)[number];
    expect(m.to).toBe(`own-${tag}@x.com`);
    expect(m.subject).toMatch(/^.+: 14 members now, billed today$/);
    expect(m.text).toContain(
      "grew from 3 to 14 members today. Because that's a big jump, we billed the 11 new members right away, prorated for the rest of your billing period.",
    );
    expect(m.text).toContain(
      `Settings, Members: https://${(H as { APP_HOST: string }).APP_HOST}/settings/members`,
    );
    expect(m.text).toContain("Settings, Plan and billing: https://");
    expect(m.text).toContain("/settings/plan");
    expect(m.text).not.toContain("\u2014");
    expect(m.html).toContain("/settings/members");
  });

  it("a repeat report of the same jump sends none", async () => {
    fake.seatsJump = { from: 3, to: 14 };
    // retry: billing asks for the count again soon, and answers the jump again.
    fake.seatsRetry = true;
    const e = HE();
    const t = Date.now();
    await run(e, t);
    await run(e, t + 120_000);
    expect(seatCalls().length).toBe(2);
    expect(sends).toHaveLength(1);
    expect(await jumpKeys()).toHaveLength(1);
  });

  it("with billing's `at`, a redelivery on another day is still one email, and a new jump is another", async () => {
    const e = HE();
    const t = Date.now();
    fake.seatsJump = { from: 3, to: 14, at: t - 5_000 };
    await run(e, t);
    // The next day's daily report gets the same jump again: no second email.
    await run(e, t + SEATS_DAILY_MS + 1_000);
    expect(seatCalls().length).toBe(2);
    expect(sends).toHaveLength(1);
    expect((await jumpKeys()).map((k) => k.key)).toEqual([
      `billing.seats.jump:${t - 5_000}`,
    ]);
    // A different jump (another `at`), even to the same count, is its own email.
    fake.seatsJump = { from: 3, to: 14, at: t + 1 };
    await run(e, t + 2 * SEATS_DAILY_MS + 2_000);
    expect(sends).toHaveLength(2);
  });

  it("a handled jump is acknowledged in the next report (jumpAck = its `at`), and never before one", async () => {
    const e = HE();
    const t = Date.now();
    await run(e, t);
    expect(lastSeats()).not.toHaveProperty("jumpAck");
    fake.seatsJump = { from: 3, to: 14, at: t - 5_000 };
    await run(e, t + SEATS_DAILY_MS + 1_000);
    expect(sends).toHaveLength(1);
    // The report that carried the jump did not ack it; the next one does.
    expect(lastSeats()).not.toHaveProperty("jumpAck");
    await run(e, t + 2 * SEATS_DAILY_MS + 2_000);
    expect(lastSeats()).toMatchObject({ jumpAck: t - 5_000 });
    // The same jump delivered again is acknowledged again, with no second email.
    await run(e, t + 3 * SEATS_DAILY_MS + 3_000);
    expect(sends).toHaveLength(1);
    expect(lastSeats()).toMatchObject({ jumpAck: t - 5_000 });
    // A newer jump moves the ack on (the newest wins).
    fake.seatsJump = { from: 3, to: 40, at: t + 7_000 };
    await run(e, t + 4 * SEATS_DAILY_MS + 4_000);
    await run(e, t + 5 * SEATS_DAILY_MS + 5_000);
    expect(lastSeats()).toMatchObject({ jumpAck: t + 7_000 });
  });

  it("the ack stops riding reports once a report that carried it was accepted", async () => {
    const e = HE();
    const t = Date.now();
    fake.seatsJump = { from: 3, to: 14, at: t - 5_000 };
    await run(e, t + 1_000);
    // Billing cleared the jump on the ack: it no longer carries it.
    fake.seatsJump = undefined;
    await run(e, t + SEATS_DAILY_MS + 2_000);
    expect(lastSeats()).toMatchObject({ jumpAck: t - 5_000 });
    await run(e, t + 2 * SEATS_DAILY_MS + 3_000);
    expect(lastSeats()).not.toHaveProperty("jumpAck");
    expect(
      await env.DB.prepare("select 1 as x from settings where key = ?1")
        .bind(SEATS_JUMP_ACK_KEY)
        .first(),
    ).toBeNull();
  });

  it("billing from before the ack answers 400 bad_body to jumpAck: resent once without it, not 'no /seats', and the ack is dropped", async () => {
    const e = HE();
    const t = Date.now();
    await env.DB.prepare(
      "insert into settings (key, value) values (?1, ?2) on conflict (key) do update set value = excluded.value",
    )
      .bind(SEATS_JUMP_ACK_KEY, String(t - 5_000))
      .run();
    fake.rejectAck = true;
    try {
      await run(e, t);
      const calls = seatCalls();
      expect(calls).toHaveLength(2);
      expect(calls[0]?.body).toMatchObject({ jumpAck: t - 5_000 });
      expect(calls[1]?.body).not.toHaveProperty("jumpAck");
      // Accepted: the report was recorded as accepted (not the unsupported path).
      const sent = JSON.parse(
        (
          (await env.DB.prepare("select value from settings where key = ?1")
            .bind(SEATS_SENT_KEY)
            .first<{ value: string }>()) as { value: string }
        ).value,
      );
      expect(sent).toMatchObject({ ok: true });
      expect(
        await env.DB.prepare("select 1 as x from settings where key = ?1")
          .bind(SEATS_JUMP_ACK_KEY)
          .first(),
      ).toBeNull();
      // Later reports are not stuck: a count change is sent, with no jumpAck.
      await person("late", "member");
      await run(e, t + SEATS_DAILY_MS + 1_000);
      expect(seatCalls().length).toBe(3);
      expect(lastSeats()).not.toHaveProperty("jumpAck");
    } finally {
      fake.rejectAck = false;
    }
  });

  it("a concurrent report does not acknowledge a claim whose email has not gone out; it does once it has", async () => {
    const e = HE();
    const t = Date.now();
    const at = t - 5_000;
    const claim = (sent: boolean) =>
      env.DB.prepare(
        "insert into settings (key, value) values (?1, ?2) on conflict (key) do update set value = excluded.value",
      )
        .bind(
          `billing.seats.jump:${at}`,
          JSON.stringify({ from: 3, to: 14, at: t, sent }),
        )
        .run();
    // A holds the claim (its send in flight, then failing).
    await claim(false);
    fake.seatsJump = { from: 3, to: 14, at };
    await run(e, t);
    expect(sends).toHaveLength(0);
    await run(e, t + SEATS_DAILY_MS + 1_000);
    expect(lastSeats()).not.toHaveProperty("jumpAck");
    // A's send failed and released the claim: the next report sends, and acks.
    await env.DB.prepare("delete from settings where key = ?1")
      .bind(`billing.seats.jump:${at}`)
      .run();
    await run(e, t + 2 * SEATS_DAILY_MS + 2_000);
    expect(sends).toHaveLength(1);
    // A claim that says sent is acknowledged by a report that finds it.
    await env.DB.prepare("delete from settings where key = ?1")
      .bind(SEATS_JUMP_ACK_KEY)
      .run();
    await run(e, t + 3 * SEATS_DAILY_MS + 3_000);
    await run(e, t + 4 * SEATS_DAILY_MS + 4_000);
    expect(lastSeats()).toMatchObject({ jumpAck: at });
    expect(sends).toHaveLength(1);
  });

  it("a jump whose email could not be sent is not acknowledged", async () => {
    const e = HE();
    const t = Date.now();
    failSend = true;
    fake.seatsJump = { from: 3, to: 14, at: t - 5_000 };
    await run(e, t);
    await run(e, t + SEATS_DAILY_MS + 1_000);
    expect(lastSeats()).not.toHaveProperty("jumpAck");
  });

  it("no jump, no email", async () => {
    await run(HE(), Date.now());
    expect(sends).toHaveLength(0);
    expect(await jumpKeys()).toHaveLength(0);
  });

  it("a send failure does not break the report, and a later report retries", async () => {
    fake.seatsJump = { from: 3, to: 14 };
    failSend = true;
    const e = HE();
    const t = Date.now();
    await expect(run(e, t)).resolves.toBeUndefined();
    expect(seatCalls().length).toBeGreaterThan(0);
    expect(sends).toHaveLength(0);
    expect(await jumpKeys()).toHaveLength(0);
    failSend = false;
    await run(e, t + SEATS_DAILY_MS + 1_000);
    expect(sends).toHaveLength(1);
  });

  it("an install that can't send email does not fail either", async () => {
    fake.seatsJump = { from: 3, to: 14 };
    await expect(run(H, Date.now())).resolves.toBeUndefined();
    expect(await jumpKeys()).toHaveLength(0);
  });
});
