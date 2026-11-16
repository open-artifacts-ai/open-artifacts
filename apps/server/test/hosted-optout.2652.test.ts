// #2652: hosted installs ask the platform's opt-out list before an outside
// share email and report opt-outs to it. Self-host never calls it. Fake platform.
import { env } from "cloudflare:workers";
import { R, ShareResultSchema } from "@oa/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import {
  SHARE_OPTOUT_PATH,
  signOptoutToken,
  verifyOptoutToken,
  verifyOptoutTokenFull,
} from "../src/email/share-optout.js";
import type { Env } from "../src/env.js";
import { publish } from "../src/services/artifacts.js";
import {
  gateOptoutPlatform,
  type OptoutPlatform,
  optoutHash,
  optoutPlatform,
} from "../src/services/hosted-optout.js";
import { getUser } from "../src/services/users.js";
import { direct, mailer, TEST_BROKER_KEY, uniq } from "./auth-helpers.js";
import { fetchAndWait, login } from "./helpers.js";

const app = createApp();
const APP = "http://app.localhost";
const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
const KEY = "platform-wide-optout-key";

const HOSTED: Partial<Env> = {
  HOSTED: "1",
  AUTH_DOMAIN_JOIN: "invite",
  AUTH_BROKER_URL: "https://auth.h.test",
  BROKER_SIGNING_KEY: TEST_BROKER_KEY,
  GOOGLE_CLIENT_SECRET: "",
  OPTOUT_PLATFORM: "on",
  OPTOUT_HASH_KEY: KEY,
};

type Calls = { check: string[][]; add: [string, string][] };
function fake(over: Partial<OptoutPlatform> = {}) {
  const calls: Calls = { check: [], add: [] };
  const impl: OptoutPlatform = {
    async check(_e, hashes) {
      calls.check.push(hashes);
      return hashes.map((_, i) => ({
        optedOut: false,
        token: `tok${calls.check.length}x${i}`,
      }));
    },
    async add(_e, h, token) {
      calls.add.push([h, token]);
    },
    ...over,
  };
  optoutPlatform.impl = impl;
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
    );
    expect(r.status).toBe(200);
    return ShareResultSchema.parse(await r.json());
  };
  return { m, e, share };
}
const post = (path: string, e: Env) =>
  app.fetch(new Request(`${APP}${path}`, { method: "POST" }), e, ctx);
const tokenIn = (mail: { html: string } | undefined) =>
  decodeURIComponent(
    /href="[^"]*unsubscribe\/shares\?t=([^"]+)"/.exec(mail?.html ?? "")?.[1] ??
      "",
  );

describe("before an outside share email", () => {
  it("hosted: the platform is asked with the HMAC, never the address; the token it mints rides in the link", async () => {
    const calls = fake();
    const { m, e, share } = await world(HOSTED);
    const to = uniq("out", "gmail.com");
    expect(await share(to)).toMatchObject({ emailed: true });
    const h = await optoutHash(e, to);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(calls.check).toEqual([[h]]);
    expect(JSON.stringify(calls)).not.toContain(to);
    // Case and padding don't change the key.
    expect(await optoutHash(e, ` ${to.toUpperCase()} `)).toBe(h);
    const mail = m.sent.find((x) => x.to === to);
    const t = tokenIn(mail);
    expect(t.startsWith("v2.")).toBe(true);
    expect(await verifyOptoutTokenFull(e, t)).toMatchObject({
      platform: { h, p: "tok1x0" },
    });
    expect(await verifyOptoutToken(e, t)).not.toBeNull();
  });

  it("opted out platform-wide: saved, not emailed, skipped; the log has the reason", async () => {
    fake({
      async check(_e, hashes) {
        return hashes.map(() => ({ optedOut: true, token: "t" }));
      },
    });
    const { m, share } = await world(HOSTED);
    const log = vi.spyOn(console, "log");
    const to = uniq("out", "gmail.com");
    const r = await share(to);
    expect(r).toMatchObject({ emailed: false, notEmailed: "skipped" });
    expect(JSON.stringify(r)).not.toMatch(/opt/);
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

  it("fails closed: the platform can't answer, or no hash key, or an empty answer: no email", async () => {
    const reasons: string[] = [];
    const log = vi.spyOn(console, "log");
    const fails = async (
      over: Partial<Env>,
      impl?: Partial<OptoutPlatform>,
    ) => {
      fake(impl);
      const { m, share } = await world({ ...HOSTED, ...over });
      const to = uniq("out", "gmail.com");
      const r = await share(to);
      expect(r).toMatchObject({ emailed: false, notEmailed: "skipped" });
      expect(m.sent.some((x) => x.to === to)).toBe(false);
      for (const c of log.mock.calls) {
        const j = String(c[0]).match(/"reason":"(optout_[a-z]+)"/);
        if (j?.[1]) reasons.push(j[1]);
      }
    };
    await fails(
      {},
      {
        async check() {
          throw new Error("network");
        },
      },
    );
    await fails(
      {},
      {
        async check() {
          return [];
        },
      },
    );
    await fails({ OPTOUT_HASH_KEY: undefined });
    log.mockRestore();
    expect(new Set(reasons)).toEqual(
      new Set(["optout_unavailable", "optout_unconfigured"]),
    );
  });

  it("the default transport fails closed too: no gate, no email", async () => {
    optoutPlatform.impl = gateOptoutPlatform;
    const { m, share } = await world(HOSTED);
    const to = uniq("out", "gmail.com");
    expect(await share(to)).toMatchObject({
      emailed: false,
      notEmailed: "skipped",
    });
    expect(m.sent.some((x) => x.to === to)).toBe(false);
  });

  it("self-host never calls it, even with the variables set; hosted without the switch neither; an address at a login domain is never asked", async () => {
    const calls = fake();
    const selfHost = await world({ ...HOSTED, HOSTED: undefined });
    expect(await selfHost.share(uniq("out", "gmail.com"))).toMatchObject({
      emailed: true,
    });
    const off = await world({ ...HOSTED, OPTOUT_PLATFORM: undefined });
    expect(await off.share(uniq("out", "gmail.com"))).toMatchObject({
      emailed: true,
    });
    const on = await world(HOSTED);
    expect(await on.share(uniq("team", "a.com"))).toMatchObject({
      emailed: true,
    });
    expect(calls.check).toEqual([]);
    expect(calls.add).toEqual([]);
    // The links they sent are v1 tokens: nothing for the platform.
    const mail = selfHost.m.sent.at(-1);
    expect(tokenIn(mail).startsWith("v1.")).toBe(true);
  });
});

describe("a new opt-out", () => {
  it("hosted: the POST suppresses here and reports the HMAC and the minted token to the platform", async () => {
    const calls = fake();
    const { m, e, share } = await world(HOSTED);
    const to = uniq("out", "gmail.com");
    await share(to);
    const t = tokenIn(m.sent.find((x) => x.to === to));
    const path = `${SHARE_OPTOUT_PATH}?t=${encodeURIComponent(t)}`;
    // GET changes nothing, here or at the platform.
    expect((await app.fetch(new Request(`${APP}${path}`), e, ctx)).status).toBe(
      200,
    );
    expect(calls.add).toEqual([]);
    expect((await post(path, e)).status).toBe(200);
    expect(calls.add).toEqual([[await optoutHash(e, to), "tok1x0"]]);
    // Suppressed here too: the next share is skipped without asking again.
    const again = await share(to);
    expect(again).toMatchObject({ emailed: false, notEmailed: "skipped" });
  });

  it("a platform that can't take it is logged; the person still sees done and the local opt-out holds", async () => {
    fake({
      async add() {
        throw new Error("down");
      },
    });
    const { m, e, share } = await world(HOSTED);
    const to = uniq("out", "gmail.com");
    await share(to);
    const t = tokenIn(m.sent.find((x) => x.to === to));
    const r = await post(`${SHARE_OPTOUT_PATH}?t=${encodeURIComponent(t)}`, e);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("You won&#39;t get emails from");
  });

  it("self-host, or an older v1 link: no platform call", async () => {
    const calls = fake();
    const { e } = await world(HOSTED);
    const v1 = await signOptoutToken(e, uniq("old", "gmail.com"));
    expect(
      (await post(`${SHARE_OPTOUT_PATH}?t=${encodeURIComponent(v1)}`, e))
        .status,
    ).toBe(200);
    const v2 = await signOptoutToken(e, uniq("new", "gmail.com"), {
      h: "hh",
      p: "pp",
    });
    const self = { ...e, HOSTED: undefined } as Env;
    expect(
      (await post(`${SHARE_OPTOUT_PATH}?t=${encodeURIComponent(v2)}`, self))
        .status,
    ).toBe(200);
    expect(calls.add).toEqual([]);
  });

  it("v2 tokens: a tampered platform part or signature is refused", async () => {
    const t = await signOptoutToken(env, uniq("tam", "gmail.com"), {
      h: "hh",
      p: "pp",
    });
    const parts = t.split(".");
    expect(await verifyOptoutToken(env, t)).not.toBeNull();
    expect(
      await verifyOptoutToken(
        env,
        [...parts.slice(0, 3), "zz", parts[4]].join("."),
      ),
    ).toBeNull();
    expect(
      await verifyOptoutToken(
        env,
        [parts[0], parts[1], "xx", ...parts.slice(3)].join("."),
      ),
    ).toBeNull();
    expect(await verifyOptoutToken(env, `${t}.extra`)).toBeNull();
    // A v2 token's signature never verifies as a v1.
    expect(
      await verifyOptoutToken(env, `v1.${parts[1]}.${parts[4]}`),
    ).toBeNull();
  });
});
