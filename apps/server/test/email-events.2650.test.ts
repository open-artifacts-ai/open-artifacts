// #2650: a bounce or complaint on a member's outside share email pauses that
// member's outside share emails for 7 days. Driven through the Queue consumer
// with fake Email Service events.
import { env } from "cloudflare:workers";
import { R, ShareResultSchema } from "@oa/shared";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import type { Env } from "../src/env.js";
import worker from "../src/index.js";
import { publish } from "../src/services/artifacts.js";
import {
  SENDER_PAUSE_MS,
  sweepEmailEvents,
} from "../src/services/email-events.js";
import { getUser } from "../src/services/users.js";
import { direct, mailer, TEST_BROKER_KEY, uniq } from "./auth-helpers.js";
import { fetchAndWait, login } from "./helpers.js";

const app = createApp();
const QUEUE = "oa-email-events";
const HOSTED: Partial<Env> = {
  HOSTED: "1",
  AUTH_DOMAIN_JOIN: "invite",
  AUTH_BROKER_URL: "https://auth.h.test",
  BROKER_SIGNING_KEY: TEST_BROKER_KEY,
  GOOGLE_CLIENT_SECRET: "",
};

/** A sender with a published page and a mailer whose message ids are unique. */
async function sender(over: Partial<Env> = HOSTED) {
  const m = mailer();
  const ids: Record<string, string> = {};
  const send = async (msg: { to: string }) => {
    (m.sent as unknown[]).push(msg);
    const messageId = `msg-${crypto.randomUUID()}`;
    ids[msg.to] = messageId;
    return { messageId };
  };
  const e = direct({
    ...m.env,
    ...over,
    EMAIL: { send } as unknown as SendEmail,
  }) as Env;
  const o = await login(uniq("own", "a.com"), "member");
  const member = await getUser(env, o.userId);
  if (!member) throw new Error("no user");
  const share = async (to: string) => {
    // A new page each time: a re-share of one page sends nothing.
    const { id } = await publish(
      env,
      member,
      { title: "Plan", format: "markdown", content: "x" } as never,
      null,
      undefined,
      "create",
    );
    const r = await fetchAndWait(
      app,
      new Request(`http://app.localhost${R.shares(id)}`, {
        method: "PUT",
        headers: {
          cookie: o.cookie,
          "x-oa-request": "1",
          "content-type": "application/json",
        },
        body: JSON.stringify({ email: to, role: "viewer" }),
      }),
      e,
    );
    expect(r.status).toBe(200);
    return ShareResultSchema.parse(await r.json());
  };
  return { e, m, ids, member, share };
}

const event = (type: string, messageId: string, extra: object = {}) => ({
  type: `cf.email.sending.${type}`,
  source: { type: "email.sending", zoneId: "z", domain: "example.com" },
  payload: { messageId, recipient: "someone@example.net", ...extra },
});

/** Runs the Worker's queue() with these message bodies. */
async function consume(
  bodies: unknown[],
  e: Env,
  queue = QUEUE,
): Promise<{ acked: number; retried: number; all: number }> {
  const out = { acked: 0, retried: 0, all: 0 };
  const batch = {
    queue,
    messages: bodies.map((body, i) => ({
      id: `m${i}`,
      timestamp: new Date(),
      attempts: 1,
      body,
      ack: () => {
        out.acked++;
      },
      retry: () => {
        out.retried++;
      },
    })),
    ackAll: () => {
      out.all++;
    },
    retryAll: () => {},
  };
  await worker.queue?.(batch as unknown as MessageBatch<unknown>, e);
  return out;
}
const withQueue = (e: Env): Env => ({ ...e, EMAIL_EVENTS_QUEUE: QUEUE }) as Env;
const pausedUntil = async (userId: string) =>
  (
    await env.DB.prepare(
      "select until_at from share_email_pauses where user_id = ?",
    )
      .bind(userId)
      .first<{ until_at: number }>()
  )?.until_at ?? null;

describe("recording the sender", () => {
  it("an outside share email stores its message id against the member, never the address", async () => {
    const { share, ids, member } = await sender();
    const to = uniq("out", "gmail.com");
    expect(await share(to)).toMatchObject({ emailed: true });
    const row = await env.DB.prepare(
      "select * from share_email_messages where message_id = ?",
    )
      .bind(ids[to])
      .first<Record<string, unknown>>();
    expect(row?.user_id).toBe(member.id);
    expect(Object.keys(row ?? {}).sort()).toEqual([
      "bounced_at",
      "created_at",
      "message_id",
      "user_id",
    ]);
    expect(JSON.stringify(row)).not.toContain(to);
  });

  it("an address at a login domain (the normal share email) is not recorded", async () => {
    const { share, ids } = await sender();
    const to = uniq("team", "a.com");
    expect(await share(to)).toMatchObject({ emailed: true });
    expect(
      await env.DB.prepare(
        "select 1 from share_email_messages where message_id = ?",
      )
        .bind(ids[to])
        .first(),
    ).toBeNull();
  });
});

/** Shares `n` outside emails and returns their message ids. */
async function sent(a: Awaited<ReturnType<typeof sender>>, n: number) {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const to = uniq("out", "gmail.com");
    await a.share(to);
    ids.push(a.ids[to] as string);
  }
  return ids;
}

describe("a complaint pauses at once", () => {
  it("the member's next outside share is saved, not emailed, and reads sender_paused with when it ends", async () => {
    const a = await sender();
    const b = await sender();
    const [id] = await sent(a, 1);
    const log = vi.spyOn(console, "log");
    const res = await consume(
      [event("message.complained", id as string)],
      withQueue(a.e),
    );
    expect(res).toMatchObject({ acked: 1, retried: 0 });
    const until = await pausedUntil(a.member.id);
    expect(until).toBeGreaterThan(Date.now() + SENDER_PAUSE_MS - 60_000);
    expect(until).toBeLessThanOrEqual(Date.now() + SENDER_PAUSE_MS);
    const next = uniq("out", "gmail.com");
    const r = await a.share(next);
    expect(r).toMatchObject({ emailed: false, notEmailed: "sender_paused" });
    expect(new Date(r.pausedUntil as string).getTime()).toBe(until);
    // Never which recipient bounced, or that anyone did.
    expect(JSON.stringify(r)).not.toMatch(/bounce|complain/);
    expect(a.ids[next]).toBeUndefined();
    expect(
      log.mock.calls.some((c) =>
        String(c[0]).includes('"reason":"sender_paused"'),
      ),
    ).toBe(true);
    log.mockRestore();
    expect(
      await env.DB.prepare("select 1 from shares where email = ?")
        .bind(next)
        .first(),
    ).not.toBeNull();
    // Another member is not affected; neither is this member's team email.
    expect(await b.share(uniq("out", "gmail.com"))).toMatchObject({
      emailed: true,
    });
    expect(await a.share(uniq("team", "a.com"))).toMatchObject({
      emailed: true,
    });
  });
});

describe("bounces: the third terminal one in 7 days", () => {
  it("one or two terminal bounces change nothing; the third pauses", async () => {
    const a = await sender();
    const ids = await sent(a, 3);
    const q = withQueue(a.e);
    await consume(
      [event("message.bounced", ids[0] as string, { terminal: true })],
      q,
    );
    await consume(
      [event("message.bounced", ids[1] as string, { terminal: true })],
      q,
    );
    expect(await pausedUntil(a.member.id)).toBeNull();
    expect(await a.share(uniq("out", "gmail.com"))).toMatchObject({
      emailed: true,
    });
    await consume(
      [event("message.bounced", ids[2] as string, { terminal: true })],
      q,
    );
    expect(await pausedUntil(a.member.id)).not.toBeNull();
    expect(await a.share(uniq("out", "gmail.com"))).toMatchObject({
      emailed: false,
      notEmailed: "sender_paused",
    });
  });

  it("a redelivered event counts once", async () => {
    const a = await sender();
    const ids = await sent(a, 3);
    const q = withQueue(a.e);
    const ev = event("message.bounced", ids[0] as string, { terminal: true });
    await consume([ev, ev, ev, ev], q);
    expect(await pausedUntil(a.member.id)).toBeNull();
  });

  it("bounces older than 7 days don't count", async () => {
    const a = await sender();
    const ids = await sent(a, 3);
    const q = withQueue(a.e);
    await consume(
      [event("message.bounced", ids[0] as string, { terminal: true })],
      q,
    );
    await consume(
      [event("message.bounced", ids[1] as string, { terminal: true })],
      q,
    );
    await env.DB.prepare(
      "update share_email_messages set bounced_at = ? where message_id = ?",
    )
      .bind(Date.now() - 8 * 86_400_000, ids[0])
      .run();
    await consume(
      [event("message.bounced", ids[2] as string, { terminal: true })],
      q,
    );
    expect(await pausedUntil(a.member.id)).toBeNull();
  });

  it("only an explicit terminal counts: a missing field, terminal false, failed, delivered, deferred, rejected", async () => {
    const a = await sender();
    const ids = await sent(a, 4);
    const q = withQueue(a.e);
    for (const id of ids)
      await consume(
        [
          event("message.bounced", id),
          event("message.bounced", id, { terminal: false }),
          event("message.failed", id, { terminal: true }),
          event("message.delivered", id),
          event("message.deferred", id),
          event("message.rejected", id),
        ],
        q,
      );
    expect(await pausedUntil(a.member.id)).toBeNull();
    expect(
      (
        await env.DB.prepare(
          "select count(*) n from share_email_messages where user_id = ? and bounced_at is not null",
        )
          .bind(a.member.id)
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
    expect(await a.share(uniq("out", "gmail.com"))).toMatchObject({
      emailed: true,
    });
  });

  it("an unknown message id and malformed events change nothing and are acked", async () => {
    const a = await sender();
    const res = await consume(
      [
        event("message.complained", "msg-someone-elses"),
        event("message.bounced", "msg-someone-elses", { terminal: true }),
        { nope: true },
        "text",
        null,
      ],
      withQueue(a.e),
    );
    expect(res).toMatchObject({ acked: 5, retried: 0 });
    expect(await pausedUntil(a.member.id)).toBeNull();
  });
});

describe("the pause", () => {
  it("lasts 7 days: after it emails go again; a later pause extends, never shortens", async () => {
    const a = await sender();
    const [id] = await sent(a, 1);
    const q = withQueue(a.e);
    await consume([event("message.complained", id as string)], q);
    const first = (await pausedUntil(a.member.id)) as number;
    await consume([event("message.complained", id as string)], q);
    expect((await pausedUntil(a.member.id)) as number).toBeGreaterThanOrEqual(
      first,
    );
    await env.DB.prepare(
      "update share_email_pauses set until_at = ? where user_id = ?",
    )
      .bind(Date.now() + 30 * 86_400_000, a.member.id)
      .run();
    const far = (await pausedUntil(a.member.id)) as number;
    await consume([event("message.complained", id as string)], q);
    expect(await pausedUntil(a.member.id)).toBe(far);
    await env.DB.prepare(
      "update share_email_pauses set until_at = ? where user_id = ?",
    )
      .bind(Date.now() - 1000, a.member.id)
      .run();
    expect(await a.share(uniq("out", "gmail.com"))).toMatchObject({
      emailed: true,
    });
  });
});

describe("the consumer is optional", () => {
  it("with no EMAIL_EVENTS_QUEUE, or another queue, nothing changes: the batch is acked and ignored", async () => {
    const a = await sender();
    const to = uniq("out", "gmail.com");
    await a.share(to);
    const ev = event("message.complained", a.ids[to] as string);
    expect(await consume([ev], a.e)).toMatchObject({ all: 1, acked: 0 });
    expect(await consume([ev], withQueue(a.e), "another-queue")).toMatchObject({
      all: 1,
      acked: 0,
    });
    expect(await pausedUntil(a.member.id)).toBeNull();
    expect(await a.share(uniq("out", "gmail.com"))).toMatchObject({
      emailed: true,
    });
  });

  it("an event that can't be handled is retried, the others still acked", async () => {
    const a = await sender();
    const to = uniq("out", "gmail.com");
    await a.share(to);
    const broken = {
      ...withQueue(a.e),
      DB: new Proxy(a.e.DB, {
        get(t, k) {
          if (k === "prepare")
            return (sql: string) => {
              if (sql.includes("share_email_messages where message_id"))
                throw new Error("D1 down");
              return t.prepare(sql);
            };
          const v = Reflect.get(t, k);
          return typeof v === "function" ? v.bind(t) : v;
        },
      }),
    } as Env;
    const res = await consume(
      [event("message.complained", a.ids[to] as string)],
      broken,
    );
    expect(res).toMatchObject({ acked: 0, retried: 1 });
  });
});

describe("the daily sweep", () => {
  it("drops expired pauses and message ids older than 30 days", async () => {
    const old = `msg-old-${crypto.randomUUID()}`;
    const fresh = `msg-fresh-${crypto.randomUUID()}`;
    const u = await login(uniq("sw", "a.com"), "member");
    await env.DB.prepare(
      "insert into share_email_messages (message_id, user_id, created_at) values (?, ?, ?), (?, ?, ?)",
    )
      .bind(
        old,
        u.userId,
        Date.now() - 31 * 86_400_000,
        fresh,
        u.userId,
        Date.now(),
      )
      .run();
    await env.DB.prepare(
      "insert into share_email_pauses (user_id, until_at, reason, created_at) values (?, ?, 'bounced', 1)",
    )
      .bind(u.userId, Date.now() - 1000)
      .run();
    await sweepEmailEvents(env, Date.now());
    const has = async (id: string) =>
      (await env.DB.prepare(
        "select 1 from share_email_messages where message_id = ?",
      )
        .bind(id)
        .first()) !== null;
    expect(await has(old)).toBe(false);
    expect(await has(fresh)).toBe(true);
    expect(await pausedUntil(u.userId)).toBeNull();
  });
});
