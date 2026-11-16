// #2652: hosted installs ask the platform's hosted-wide opt-out list (through
// the LoginGate) before an outside share email, fail closed, and link to the
// platform's page. Self-host never calls it. A fake platform and a fake gate.
import { env } from "cloudflare:workers";
import { publicFromPkcs8, verifyRequest } from "@oa/auth-core";
import {
  OPTOUT_CHECK_PATH,
  OPTOUT_MINT_PATH,
  OptoutBodySchema,
} from "@oa/provisioning-contract";
import { R, ShareResultSchema } from "@oa/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { withBrokerProps } from "../src/auth/broker-transport.js";
import { addressHash } from "../src/email/share-optout.js";
import type { Env } from "../src/env.js";
import { publish } from "../src/services/artifacts.js";
import {
  gateOptoutPlatform,
  type OptoutPlatform,
  OptoutUnavailableError,
  optoutHash,
  optoutPlatform,
  optoutTimeout,
} from "../src/services/hosted-optout.js";
import { getUser } from "../src/services/users.js";
import { direct, mailer, TEST_BROKER_KEY, uniq } from "./auth-helpers.js";
import { fetchAndWait, login } from "./helpers.js";

const app = createApp();
const APP = "http://app.localhost";
const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
const PAGE = "https://signup.example.test/unsubscribe";
const TOKEN = (n: number) => `${"T".repeat(30)}${n}.${"m".repeat(43)}`;

const HOSTED: Partial<Env> = {
  HOSTED: "1",
  AUTH_DOMAIN_JOIN: "invite",
  AUTH_BROKER_URL: "https://auth.h.test",
  BROKER_SIGNING_KEY: TEST_BROKER_KEY,
  GOOGLE_CLIENT_SECRET: "",
  OPTOUT_PLATFORM: "on",
  OPTOUT_HASH_KEY: "hosted-installs-only-key",
  OPTOUT_UNSUBSCRIBE_URL: PAGE,
};

type Calls = { check: string[]; mint: string[] };
function fake(over: Partial<OptoutPlatform> = {}) {
  const calls: Calls = { check: [], mint: [] };
  optoutPlatform.impl = {
    async check(_e, h1) {
      calls.check.push(h1);
      return false;
    },
    async mint(_e, h1) {
      calls.mint.push(h1);
      return TOKEN(calls.mint.length);
    },
    ...over,
  };
  return calls;
}
afterEach(() => {
  optoutPlatform.impl = gateOptoutPlatform;
});

async function world(over: Partial<Env>) {
  const m = mailer();
  const e = direct({ ...m.env, ...over }) as Env;
  const o = await login(uniq("own", "a.com"), "member");
  const member = await getUser(env, o.userId);
  if (!member) throw new Error("no user");
  const share = async (to: string, props?: Record<string, unknown>) => {
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
      new Request(`${APP}${R.shares(id)}`, {
        method: "PUT",
        headers: {
          cookie: o.cookie,
          "x-oa-request": "1",
          "content-type": "application/json",
        },
        body: JSON.stringify({ email: to, role: "viewer" }),
      }),
      e,
      props,
    );
    expect(r.status).toBe(200);
    return ShareResultSchema.parse(await r.json());
  };
  return { m, e, share };
}
const links = (html: string | undefined) =>
  [...(html ?? "").matchAll(/href="([^"]+)"/g)].map((x) => x[1] ?? "");

describe("before an outside share email (hosted, the switch on)", () => {
  it("asks with h1, never the address; mints a token; the link and header are the platform's page; the hosted-wide wording", async () => {
    const calls = fake();
    const { m, e, share } = await world(HOSTED);
    const to = uniq("out", "gmail.com");
    expect(await share(to)).toMatchObject({ emailed: true });
    const h1 = await optoutHash(e, to);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(await optoutHash(e, ` ${to.toUpperCase()} `)).toBe(h1);
    expect(calls).toEqual({ check: [h1], mint: [h1] });
    expect(JSON.stringify(calls)).not.toContain(to);
    const mail = m.sent.find((x) => x.to === to);
    const url = `${PAGE}?t=${TOKEN(1)}`;
    expect(mail?.headers?.["List-Unsubscribe"]).toBe(`<${url}>`);
    expect(mail?.headers?.["List-Unsubscribe-Post"]).toBe(
      "List-Unsubscribe=One-Click",
    );
    expect(links(mail?.html)[1]).toBe(url);
    expect(mail?.text).toContain(`Don't email me again:\n${url}`);
    expect(mail?.html).toContain(">Don&#39;t email me again</a>");
    expect(mail?.text).not.toContain("Don't email me from");
  });

  it("opted out hosted-wide: saved, not emailed, skipped; no token is minted; the log has the reason", async () => {
    const calls = fake({
      async check() {
        return true;
      },
    });
    const { m, share } = await world(HOSTED);
    const log = vi.spyOn(console, "log");
    const to = uniq("out", "gmail.com");
    const r = await share(to);
    expect(r).toMatchObject({ emailed: false, notEmailed: "skipped" });
    expect(JSON.stringify(r)).not.toMatch(/opt/);
    expect(calls.mint).toEqual([]);
    expect(m.sent.some((x) => x.to === to)).toBe(false);
    expect(
      log.mock.calls.some((c) =>
        String(c[0]).includes('"reason":"platform_opted_out"'),
      ),
    ).toBe(true);
    log.mockRestore();
    expect(
      await env.DB.prepare("select 1 from shares where email = ?")
        .bind(to)
        .first(),
    ).not.toBeNull();
  });

  it("fails closed: no answer, a mint over its cap, no hash key, no page URL: no email, the reason in the log", async () => {
    const seen: string[] = [];
    const log = vi.spyOn(console, "log");
    const fails = async (
      over: Partial<Env>,
      impl?: Partial<OptoutPlatform>,
    ) => {
      fake(impl);
      const { m, share } = await world({ ...HOSTED, ...over });
      const to = uniq("out", "gmail.com");
      expect(await share(to)).toMatchObject({
        emailed: false,
        notEmailed: "skipped",
      });
      expect(m.sent.some((x) => x.to === to)).toBe(false);
      for (const c of log.mock.calls) {
        const j = String(c[0]).match(/"reason":"(optout_[a-z_]+)"/);
        if (j?.[1]) seen.push(j[1]);
      }
    };
    await fails(
      {},
      {
        async check() {
          throw new OptoutUnavailableError("network");
        },
      },
    );
    await fails(
      {},
      {
        async mint() {
          throw new OptoutUnavailableError("capped");
        },
      },
    );
    await fails({ OPTOUT_HASH_KEY: undefined });
    await fails({ OPTOUT_UNSUBSCRIBE_URL: undefined });
    await fails({ OPTOUT_UNSUBSCRIBE_URL: "http://signup.example.test/u" });
    log.mockRestore();
    expect(new Set(seen)).toEqual(
      new Set([
        "optout_unavailable",
        "optout_mint_capped",
        "optout_unconfigured",
      ]),
    );
  });

  it("an opt-out this install already holds is still honoured, and the platform isn't asked", async () => {
    const calls = fake();
    const { m, share } = await world(HOSTED);
    const to = uniq("out", "gmail.com");
    await env.DB.prepare(
      "insert into email_optouts (address_hash, created_at) values (?, ?)",
    )
      .bind(await addressHash(to), Date.now())
      .run();
    expect(await share(to)).toMatchObject({
      emailed: false,
      notEmailed: "skipped",
    });
    expect(calls).toEqual({ check: [], mint: [] });
    expect(m.sent.some((x) => x.to === to)).toBe(false);
  });
});

describe("never on self-host, or with the switch off", () => {
  it("self-host and hosted-without-the-switch never call the platform and keep this install's own link and per-team wording; an address at a login domain isn't asked", async () => {
    const calls = fake();
    const self = await world({ ...HOSTED, HOSTED: undefined });
    const to1 = uniq("out", "gmail.com");
    expect(await self.share(to1)).toMatchObject({ emailed: true });
    const off = await world({ ...HOSTED, OPTOUT_PLATFORM: undefined });
    const to2 = uniq("out", "gmail.com");
    expect(await off.share(to2)).toMatchObject({ emailed: true });
    const on = await world(HOSTED);
    expect(await on.share(uniq("team", "a.com"))).toMatchObject({
      emailed: true,
    });
    expect(calls).toEqual({ check: [], mint: [] });
    for (const [w, to] of [
      [self, to1],
      [off, to2],
    ] as const) {
      const mail = w.m.sent.find((x) => x.to === to);
      expect(links(mail?.html)[1]).toContain("/auth/unsubscribe/shares?t=v1.");
      expect(mail?.text).toContain("Don't email me from");
      expect(mail?.text).toContain("again:");
    }
  });
});

describe("the install's own page", () => {
  it("an install token (v1) always gets the per-team wording, with the platform's list on or off, hosted or not", async () => {
    const { signOptoutToken } = await import("../src/email/share-optout.js");
    const t = await signOptoutToken(env, uniq("pg", "gmail.com"));
    const path = `/auth/unsubscribe/shares?t=${encodeURIComponent(t)}`;
    const base = direct({}) as Env;
    for (const e of [
      base,
      { ...base, ...HOSTED } as Env,
      { ...base, ...HOSTED, OPTOUT_PLATFORM: undefined } as Env,
      { ...base, ...HOSTED, HOSTED: undefined } as Env,
    ]) {
      const html = await (
        await app.fetch(new Request(`${APP}${path}`), e, ctx)
      ).text();
      expect(html).toContain("Stop emails from");
      expect(html).toContain(
        "Other teams on Open Artifacts can still email you.",
      );
      expect(html).not.toContain("from any team");
      const done = await (
        await app.fetch(
          new Request(`${APP}${path}`, { method: "POST" }),
          e,
          ctx,
        )
      ).text();
      expect(done).toContain("You won&#39;t get emails from");
    }
  });
});

describe("the transport: the LoginGate", () => {
  const gateWith = (
    answer: (path: string, body: unknown) => Response | Promise<Response>,
  ) => {
    const seen: {
      path: string;
      body: unknown;
      kid: string;
      sig: string;
      text: string;
    }[] = [];
    const gate = {
      async fetch(req: Request): Promise<Response> {
        const path = new URL(req.url).pathname;
        const text = await req.text();
        const body = JSON.parse(text);
        seen.push({
          path,
          body,
          kid: req.headers.get("x-oa-kid") ?? "",
          sig: req.headers.get("x-oa-sig") ?? "",
          text,
        });
        return answer(path, body);
      },
    };
    return { gate, seen };
  };
  const via = <T>(gate: unknown, f: () => Promise<T>) =>
    withBrokerProps({ props: { LOGIN: gate } }, f);
  const e = { ...(env as object), ...HOSTED } as Env;
  const H1 = "c".repeat(64);

  it("check and mint: a signed { ts, nonce, h1 } body (no install, no address), to the fixed paths, answers parsed", async () => {
    const { gate, seen } = gateWith((path) =>
      path === OPTOUT_CHECK_PATH
        ? Response.json({ optedOut: true })
        : Response.json({ token: TOKEN(7) }),
    );
    expect(await via(gate, () => gateOptoutPlatform.check(e, H1))).toBe(true);
    expect(await via(gate, () => gateOptoutPlatform.mint(e, H1))).toBe(
      TOKEN(7),
    );
    expect(seen.map((s) => s.path)).toEqual([
      OPTOUT_CHECK_PATH,
      OPTOUT_MINT_PATH,
    ]);
    const pub = await publicFromPkcs8(TEST_BROKER_KEY);
    for (const s of seen) {
      expect(OptoutBodySchema.parse(s.body)).toMatchObject({ h1: H1 });
      expect(Object.keys(s.body as object).sort()).toEqual([
        "h1",
        "nonce",
        "ts",
      ]);
      expect(await verifyRequest(pub, s.path, s.kid, s.text, s.sig)).toBe(true);
      expect(Math.abs((s.body as { ts: number }).ts - Date.now())).toBeLessThan(
        60_000,
      );
    }
    // A fresh nonce each call.
    const [first, second] = seen.map(
      (s) => (s.body as { nonce: string }).nonce,
    );
    expect(first).not.toBe(second);
  });

  it("fails closed: no gate, no signing key, a refusal, a 429, a server error, a network error, an answer of the wrong shape", async () => {
    const why = async (f: () => Promise<unknown>) => {
      try {
        await f();
      } catch (x) {
        expect(x).toBeInstanceOf(OptoutUnavailableError);
        return (x as OptoutUnavailableError).why;
      }
      return "no error";
    };
    expect(await why(() => gateOptoutPlatform.check(e, H1))).toBe("no_gate");
    const ok = gateWith(() => Response.json({ optedOut: false }));
    expect(
      await why(() =>
        via(ok.gate, () =>
          gateOptoutPlatform.check(
            { ...e, BROKER_SIGNING_KEY: undefined } as Env,
            H1,
          ),
        ),
      ),
    ).toBe("unconfigured");
    const refused = gateWith(
      () => new Response("{}", { status: 403, headers: { "x-oa-gate": "1" } }),
    );
    expect(
      await why(() => via(refused.gate, () => gateOptoutPlatform.check(e, H1))),
    ).toBe("gate_refused");
    const capped = gateWith(() => new Response("{}", { status: 429 }));
    expect(
      await why(() => via(capped.gate, () => gateOptoutPlatform.mint(e, H1))),
    ).toBe("capped");
    const down = gateWith(() => new Response("x", { status: 503 }));
    expect(
      await why(() => via(down.gate, () => gateOptoutPlatform.check(e, H1))),
    ).toBe("http_503");
    const net = {
      fetch: async () => {
        throw new Error("socket hang up");
      },
    };
    expect(
      await why(() => via(net, () => gateOptoutPlatform.check(e, H1))),
    ).toBe("network");
    const wrong = gateWith(() => Response.json({ optedOut: "yes" }));
    expect(
      await why(() => via(wrong.gate, () => gateOptoutPlatform.check(e, H1))),
    ).toBe("bad_answer");
    const extra = gateWith(() => Response.json({ token: TOKEN(1), more: 1 }));
    expect(
      await why(() => via(extra.gate, () => gateOptoutPlatform.mint(e, H1))),
    ).toBe("bad_answer");
  });

  it("each call times out: a hung gate is no answer; the share is saved, no email, optout_timeout is logged", async () => {
    const hang = { fetch: () => new Promise<Response>(() => {}) };
    expect(optoutTimeout.ms).toBe(2500);
    const saved = optoutTimeout.ms;
    optoutTimeout.ms = 30;
    try {
      const calls: (() => Promise<unknown>)[] = [
        () => gateOptoutPlatform.check(e, H1),
        () => gateOptoutPlatform.mint(e, H1),
      ];
      for (const call of calls) {
        const t0 = Date.now();
        await expect(via(hang, call)).rejects.toMatchObject({ why: "timeout" });
        expect(Date.now() - t0).toBeLessThan(2000);
      }
      optoutPlatform.impl = gateOptoutPlatform;
      const { m, share } = await world(HOSTED);
      const log = vi.spyOn(console, "log");
      const to = uniq("out", "gmail.com");
      const r = await share(to, { LOGIN: hang });
      expect(r).toMatchObject({ emailed: false, notEmailed: "skipped" });
      expect(m.sent.some((x) => x.to === to)).toBe(false);
      expect(
        log.mock.calls.some((c) =>
          String(c[0]).includes('"reason":"optout_timeout"'),
        ),
      ).toBe(true);
      log.mockRestore();
      expect(
        await env.DB.prepare("select 1 from shares where email = ?")
          .bind(to)
          .first(),
      ).not.toBeNull();
    } finally {
      optoutTimeout.ms = saved;
    }
  });

  it("an end to end share through the fake gate: check, mint, then the email", async () => {
    const { gate, seen } = gateWith((path) =>
      path === OPTOUT_CHECK_PATH
        ? Response.json({ optedOut: false })
        : Response.json({ token: TOKEN(3) }),
    );
    optoutPlatform.impl = gateOptoutPlatform;
    const { m, share } = await world(HOSTED);
    const to = uniq("out", "gmail.com");
    const r = await share(to, { LOGIN: gate });
    expect(r).toMatchObject({ emailed: true });
    expect(seen.map((s) => s.path)).toEqual([
      OPTOUT_CHECK_PATH,
      OPTOUT_MINT_PATH,
    ]);
    expect(m.sent.find((x) => x.to === to)?.headers?.["List-Unsubscribe"]).toBe(
      `<${PAGE}?t=${TOKEN(3)}>`,
    );
  });
});
