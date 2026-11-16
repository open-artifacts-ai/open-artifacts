// #2650, hosted: the install pulls bounce and complaint events from the
// platform over the LoginGate and applies the same rules as the Queue path.
import { env } from "cloudflare:workers";
import { publicFromPkcs8, verifyRequest } from "@oa/auth-core";
import {
  EMAIL_EVENTS_PULL_PATH,
  EmailEventsPullBodySchema,
} from "@oa/provisioning-contract";
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
/** A fake gate that serves each queued answer once, as the platform serves events once. */
function gateServing(batches: unknown[], status = 200) {
  const seen: Seen[] = [];
  const gate = {
    async fetch(req: Request): Promise<Response> {
      const text = await req.text();
      seen.push({
        path: new URL(req.url).pathname,
        text,
        kid: req.headers.get("x-oa-kid") ?? "",
        sig: req.headers.get("x-oa-sig") ?? "",
      });
      return status === 200
        ? Response.json(batches.shift() ?? { events: [] })
        : new Response("x", { status });
    },
  };
  return { gate, seen };
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
const ev = (messageId: string, kind: string, bounceType?: string | null) => ({
  messageId,
  kind,
  ...(bounceType === undefined ? {} : { bounceType }),
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
          ev(bounced[1] as string, "bounced", "permanent"),
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

  it("only a known terminal bounceType counts: soft, missing, null, unknown; failed and other kinds never; unknown message ids nothing", async () => {
    const a = await sender();
    const ids = await a.sentIds(4);
    const { gate } = gateServing([
      {
        events: [
          ...ids.flatMap((id) => [
            ev(id, "bounced", "soft"),
            ev(id, "bounced"),
            ev(id, "bounced", null),
            ev(id, "bounced", "mystery"),
            ev(id, "bounced", "HARD"),
            ev(id, "failed", "hard"),
            ev(id, "delivered"),
            ev(id, "deferred"),
          ]),
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

  it("a gate that can't answer pulls nothing and never throws: no gate, a refusal, a 500, a wrong-shaped answer", async () => {
    const a = await sender();
    const [id] = await a.sentIds(1);
    const warn = vi.spyOn(console, "warn");
    expect(await pullEmailEvents(a.e)).toBe(0);
    expect(await pull(gateServing([], 503).gate, a.e, pullEmailEvents)).toBe(0);
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
              { messageId: id, kind: "complained", recipient: "a@b.co" },
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
    expect(seen).toHaveLength(1);
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
