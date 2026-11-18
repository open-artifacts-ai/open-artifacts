// #2650, hosted: the install pulls bounce and complaint events from the
// platform over the LoginGate and applies the same rules as the Queue path.
import { env } from "cloudflare:workers";
import { publicFromPkcs8, verifyRequest } from "@oa/auth-core";
import {
  EMAIL_EVENTS_ACK_PATH,
  EMAIL_EVENTS_PULL_PATH,
  EmailEventsAckBodySchema,
  EmailEventsPullBodySchema,
} from "@oa/provisioning-contract/email-events";
import { R, ShareResultSchema } from "@oa/shared";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { withBrokerProps } from "../src/auth/broker-transport.js";
import { DIRECTORY_SYNC_CRON, scheduled } from "../src/cron.js";
import type { Env } from "../src/env.js";
import { publish } from "../src/services/artifacts.js";
import { pullEmailEvents } from "../src/services/email-events.js";
import { LoginGateError, loginGateCall } from "../src/services/login-gate.js";
import { getUser } from "../src/services/users.js";
import { direct, mailer, TEST_BROKER_KEY, uniq } from "./auth-helpers.js";
import { fetchAndWait, login } from "./helpers.js";

const app = createApp();
const HOSTED: Partial<Env> = {
  HOSTED: "1",
  AUTH_DOMAIN_JOIN: "invite",
  AUTH_BROKER_URL: "https://auth.h.test",
  BROKER_SIGNING_KEY: TEST_BROKER_KEY,
  GOOGLE_CLIENT_SECRET: "",
  EMAIL_EVENTS_PULL: "on",
};

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
  const sentIds = async (n: number) => {
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      const to = uniq("out", "gmail.com");
      await share(to);
      out.push(ids[to] as string);
    }
    return out;
  };
  return { e, member, share, sentIds };
}

type Seen = { path: string; text: string; kid: string; sig: string };
/**
 * A fake gate: a pull serves the next queued batch (and deletes nothing: the
 * same events come again until acknowledged), an ack records its ids.
 */
function gateServing(
  batches: unknown[],
  opts: {
    status?: number;
    ackStatus?: number;
    onAck?: () => Promise<void>;
  } = {},
) {
  const seen: Seen[] = [];
  const acks: string[][] = [];
  const gate = {
    async fetch(req: Request): Promise<Response> {
      const text = await req.text();
      const path = new URL(req.url).pathname;
      seen.push({
        path,
        text,
        kid: req.headers.get("x-oa-kid") ?? "",
        sig: req.headers.get("x-oa-sig") ?? "",
      });
      if (path === EMAIL_EVENTS_ACK_PATH) {
        if (opts.ackStatus)
          return new Response("x", { status: opts.ackStatus });
        await opts.onAck?.();
        const ids = EmailEventsAckBodySchema.parse(JSON.parse(text)).eventIds;
        acks.push(ids);
        return Response.json({ acked: ids.length });
      }
      if (opts.status && opts.status !== 200)
        return new Response("x", { status: opts.status });
      return Response.json(batches.shift() ?? { events: [] });
    },
  };
  return { gate, seen, acks };
}
const pull = <T>(gate: unknown, e: Env, f: (e: Env) => Promise<T>) =>
  withBrokerProps({ props: { LOGIN: gate } }, () => f(e));
const pausedUntil = async (userId: string) =>
  (
    await env.DB.prepare(
      "select until_at from share_email_pauses where user_id = ?",
    )
      .bind(userId)
      .first<{ until_at: number }>()
  )?.until_at ?? null;
const ev = (
  messageId: string,
  kind: "bounced" | "complained",
  bounceType: "hard" | "soft" | null = kind === "bounced" ? "hard" : null,
) => ({
  eventId: `ev-${crypto.randomUUID()}`,
  messageId,
  kind,
  bounceType,
});

describe("the pull", () => {
  it("asks with a signed { ts, nonce } body (no install), to the fixed path", async () => {
    const a = await sender();
    const { gate, seen } = gateServing([{ events: [] }, { events: [] }]);
    await pull(gate, a.e, pullEmailEvents);
    await pull(gate, a.e, pullEmailEvents);
    expect(seen.map((s) => s.path)).toEqual([
      EMAIL_EVENTS_PULL_PATH,
      EMAIL_EVENTS_PULL_PATH,
    ]);
    const pub = await publicFromPkcs8(TEST_BROKER_KEY);
    for (const s of seen) {
      const body = EmailEventsPullBodySchema.parse(JSON.parse(s.text));
      expect(Object.keys(body).sort()).toEqual(["nonce", "ts"]);
      expect(await verifyRequest(pub, s.path, s.kid, s.text, s.sig)).toBe(true);
    }
    const nonces = seen.map(
      (s) => (JSON.parse(s.text) as { nonce: string }).nonce,
    );
    expect(new Set(nonces).size).toBe(2);
  });

  it("a complaint pauses at once; hard bounces pause at the third; the same rules as the Queue path", async () => {
    const a = await sender();
    const b = await sender();
    const [c] = await a.sentIds(1);
    const bounced = await b.sentIds(3);
    const { gate } = gateServing([
      {
        events: [
          ev(c as string, "complained"),
          ev(bounced[0] as string, "bounced", "hard"),
          ev(bounced[1] as string, "bounced", "hard"),
        ],
      },
      { events: [ev(bounced[2] as string, "bounced", "hard")] },
    ]);
    expect(await pull(gate, a.e, pullEmailEvents)).toBe(1);
    expect(await pausedUntil(a.member.id)).not.toBeNull();
    expect(await pausedUntil(b.member.id)).toBeNull();
    expect(await pull(gate, a.e, pullEmailEvents)).toBe(1);
    expect(await pausedUntil(b.member.id)).not.toBeNull();
    expect(await a.share(uniq("out", "gmail.com"))).toMatchObject({
      notEmailed: "sender_paused",
    });
  });

  it("only a hard bounce counts: soft and complaints on unknown ids never pause; unknown message ids nothing", async () => {
    const a = await sender();
    const ids = await a.sentIds(4);
    const { gate } = gateServing([
      {
        events: [
          ...ids.map((id) => ev(id, "bounced", "soft")),
          ev("msg-someone-elses", "complained"),
          ev("msg-someone-elses", "bounced", "hard"),
        ],
      },
    ]);
    expect(await pull(gate, a.e, pullEmailEvents)).toBe(0);
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
  });

  it("a response with a kind or bounceType the contract doesn't have is malformed: no events, nothing acknowledged", async () => {
    const a = await sender();
    const ids = await a.sentIds(3);
    const warn = vi.spyOn(console, "warn");
    for (const bad of [
      { kind: "failed", bounceType: "hard" },
      { kind: "bounced", bounceType: "permanent" },
      { kind: "bounced" },
    ]) {
      const g = gateServing([
        {
          events: [
            ev(ids[0] as string, "bounced", "hard"),
            { eventId: "bad", messageId: ids[1], ...bad },
          ],
        },
      ]);
      expect(await pull(g.gate, a.e, pullEmailEvents)).toBe(0);
      expect(g.seen.map((x) => x.path)).toEqual([EMAIL_EVENTS_PULL_PATH]);
    }
    warn.mockRestore();
    expect(await pausedUntil(a.member.id)).toBeNull();
  });

  it("a gate that can't answer pulls nothing and never throws: no gate, a refusal, a 500, a wrong-shaped answer", async () => {
    const a = await sender();
    const [id] = await a.sentIds(1);
    const warn = vi.spyOn(console, "warn");
    expect(await pullEmailEvents(a.e)).toBe(0);
    expect(
      await pull(gateServing([], { status: 503 }).gate, a.e, pullEmailEvents),
    ).toBe(0);
    expect(
      await pull(
        gateServing([{ events: [ev(id as string, "complained")], extra: 1 }])
          .gate,
        a.e,
        pullEmailEvents,
      ),
    ).toBe(0);
    expect(
      await pull(
        gateServing([
          {
            events: [
              {
                eventId: "e1",
                messageId: id,
                kind: "complained",
                bounceType: null,
                recipient: "a@b.co",
              },
            ],
          },
        ]).gate,
        a.e,
        pullEmailEvents,
      ),
    ).toBe(0);
    warn.mockRestore();
    expect(await pausedUntil(a.member.id)).toBeNull();
  });

  it("a hung gate is aborted at the timeout", async () => {
    const a = await sender();
    const signals: AbortSignal[] = [];
    const hang = {
      fetch: (req: Request) => {
        signals.push(req.signal);
        return new Promise<Response>(() => {});
      },
    };
    await expect(
      withBrokerProps({ props: { LOGIN: hang } }, () =>
        loginGateCall(a.e, EMAIL_EVENTS_PULL_PATH, {}, 30),
      ),
    ).rejects.toBeInstanceOf(LoginGateError);
    expect(signals[0]?.aborted).toBe(true);
  });
});

describe("processed, then acknowledged", () => {
  it("acknowledges a full pull of 100 events in one ack, after they are applied", async () => {
    const a = await sender();
    const [id] = await a.sentIds(1);
    // 100 events (a pull's most): a complaint first, the rest ignorable.
    const events = [
      ev(id as string, "complained"),
      ...Array.from({ length: 99 }, () =>
        ev("msg-not-ours", "bounced", "hard"),
      ),
    ];
    let pausedAtFirstAck: number | null | undefined;
    const { gate, seen, acks } = gateServing([{ events }], {
      async onAck() {
        pausedAtFirstAck ??= await pausedUntil(a.member.id);
      },
    });
    await pull(gate, a.e, pullEmailEvents);
    expect(seen.map((x) => x.path)).toEqual([
      EMAIL_EVENTS_PULL_PATH,
      EMAIL_EVENTS_ACK_PATH,
    ]);
    expect(acks.map((x) => x.length)).toEqual([100]);
    expect(acks.flat()).toEqual(events.map((e) => e.eventId));
    // The pause was written before the first ack went out.
    expect(pausedAtFirstAck).not.toBeNull();
    const pub = await publicFromPkcs8(TEST_BROKER_KEY);
    for (const x of seen.filter((s) => s.path === EMAIL_EVENTS_ACK_PATH)) {
      expect(
        await verifyRequest(pub, x.path, x.kid, x.sig ? x.text : "", x.sig),
      ).toBe(true);
      expect(Object.keys(JSON.parse(x.text)).sort()).toEqual([
        "eventIds",
        "nonce",
        "ts",
      ]);
    }
  });

  it("an event served again (the ack failed) is a no-op: nothing is applied twice, it is acknowledged again", async () => {
    const a = await sender();
    const ids = await a.sentIds(3);
    const events = ids.map((id) => ev(id, "bounced", "hard"));
    const first = gateServing([{ events }], { ackStatus: 500 });
    expect(await pull(first.gate, a.e, pullEmailEvents)).toBe(1);
    expect(first.acks).toEqual([]);
    expect(await pausedUntil(a.member.id)).not.toBeNull();
    const until = await pausedUntil(a.member.id);
    // Served again: nothing changes, then the ack goes through.
    const second = gateServing([{ events }]);
    expect(await pull(second.gate, a.e, pullEmailEvents)).toBe(0);
    expect(second.acks.flat()).toEqual(events.map((e) => e.eventId));
    expect(await pausedUntil(a.member.id)).toBe(until);
    // The bounces were counted once each.
    expect(
      (
        await env.DB.prepare(
          "select count(*) n from share_email_messages where user_id = ? and bounced_at is not null",
        )
          .bind(a.member.id)
          .first<{ n: number }>()
      )?.n,
    ).toBe(3);
  });

  it("an event that can't be applied is not acknowledged, so it comes back", async () => {
    const a = await sender();
    const [id] = await a.sentIds(1);
    const bad = ev(id as string, "complained");
    const ok = ev("msg-not-ours", "complained");
    const broken = {
      ...a.e,
      DB: new Proxy(a.e.DB, {
        get(t, k) {
          if (k === "prepare")
            return (sql: string) => {
              if (sql.includes("insert into share_email_pauses"))
                throw new Error("D1 down");
              return t.prepare(sql);
            };
          const v = Reflect.get(t, k);
          return typeof v === "function" ? v.bind(t) : v;
        },
      }),
    } as Env;
    const g = gateServing([{ events: [bad, ok] }]);
    await pull(g.gate, broken, pullEmailEvents);
    expect(g.acks.flat()).toEqual([ok.eventId]);
    expect(await pausedUntil(a.member.id)).toBeNull();
    // Served again and applied for real this time.
    const g2 = gateServing([{ events: [bad, ok] }]);
    expect(await pull(g2.gate, a.e, pullEmailEvents)).toBe(1);
    expect(g2.acks.flat()).toEqual([bad.eventId, ok.eventId]);
    expect(await pausedUntil(a.member.id)).not.toBeNull();
  });

  it("the pause and the seen id are one D1 batch: a write that fails leaves neither, and a re-served complaint extends the pause once", async () => {
    const a = await sender();
    const [id] = await a.sentIds(1);
    const ev1 = ev(id as string, "complained");
    let failBatch = true;
    const broken = {
      ...a.e,
      DB: new Proxy(a.e.DB, {
        get(t, k) {
          if (k === "batch" && failBatch)
            return async () => {
              throw new Error("D1 down");
            };
          const v = Reflect.get(t, k);
          return typeof v === "function" ? v.bind(t) : v;
        },
      }),
    } as Env;
    const g = gateServing([{ events: [ev1] }]);
    await pull(g.gate, broken, pullEmailEvents);
    expect(g.acks).toEqual([]);
    expect(await pausedUntil(a.member.id)).toBeNull();
    expect(
      await env.DB.prepare(
        "select 1 from share_email_events_seen where event_id = ?",
      )
        .bind(ev1.eventId)
        .first(),
    ).toBeNull();
    failBatch = false;
    const g2 = gateServing([{ events: [ev1] }, { events: [ev1] }]);
    expect(await pull(g2.gate, broken, pullEmailEvents)).toBe(1);
    const until = await pausedUntil(a.member.id);
    expect(until).not.toBeNull();
    // Served again, ack lost: no second extension.
    expect(await pull(g2.gate, broken, pullEmailEvents)).toBe(0);
    expect(await pausedUntil(a.member.id)).toBe(until);
  });

  it("nothing to acknowledge, nothing sent; a refused ack never throws", async () => {
    const a = await sender();
    const none = gateServing([{ events: [] }]);
    await pull(none.gate, a.e, pullEmailEvents);
    expect(none.seen.map((x) => x.path)).toEqual([EMAIL_EVENTS_PULL_PATH]);
    const [id] = await a.sentIds(1);
    const refused = gateServing(
      [{ events: [ev(id as string, "complained")] }],
      {
        ackStatus: 503,
      },
    );
    expect(await pull(refused.gate, a.e, pullEmailEvents)).toBe(1);
  });

  it("the sweep drops processed event ids after 30 days", async () => {
    const { sweepEmailEvents } = await import(
      "../src/services/email-events.js"
    );
    const old = `ev-old-${crypto.randomUUID()}`;
    const fresh = `ev-fresh-${crypto.randomUUID()}`;
    await env.DB.prepare(
      "insert into share_email_events_seen (event_id, created_at) values (?, ?), (?, ?)",
    )
      .bind(old, Date.now() - 31 * 86_400_000, fresh, Date.now())
      .run();
    await sweepEmailEvents(env, Date.now());
    const has = async (id: string) =>
      (await env.DB.prepare(
        "select 1 from share_email_events_seen where event_id = ?",
      )
        .bind(id)
        .first()) !== null;
    expect(await has(old)).toBe(false);
    expect(await has(fresh)).toBe(true);
  });
});

describe("the tick", () => {
  const tick = async (e: Env, gate: unknown, cron = DIRECTORY_SYNC_CRON) => {
    const waits: Promise<unknown>[] = [];
    const ctx = {
      props: { LOGIN: gate },
      waitUntil: (p: Promise<unknown>) => waits.push(p),
      passThroughOnException() {},
    } as unknown as ExecutionContext;
    await scheduled({ cron } as ScheduledController, e, ctx);
    await Promise.allSettled(waits);
  };

  it("hosted with the flag: each frequent system tick pulls once and applies the events", async () => {
    const a = await sender();
    const [id] = await a.sentIds(1);
    const { gate, seen } = gateServing([
      { events: [ev(id as string, "complained")] },
    ]);
    await tick(a.e, gate);
    expect(seen.map((x) => x.path)).toEqual([
      EMAIL_EVENTS_PULL_PATH,
      EMAIL_EVENTS_ACK_PATH,
    ]);
    expect(await pausedUntil(a.member.id)).not.toBeNull();
  });

  it("not with the flag off, not on self-host, not on another tick", async () => {
    const off = await sender({ ...HOSTED, EMAIL_EVENTS_PULL: undefined });
    const self = await sender({ ...HOSTED, HOSTED: undefined });
    const { gate, seen } = gateServing([{ events: [] }]);
    await tick(off.e, gate);
    await tick(self.e, gate);
    await tick((await sender()).e, gate, "oa:resume");
    expect(seen).toHaveLength(0);
  });
});
