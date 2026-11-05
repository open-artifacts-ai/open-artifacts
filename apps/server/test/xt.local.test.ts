import { generateKeyPair } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import worker from "../src/index.js";
import { direct, mailer } from "./auth-helpers.js";
import { type FakeGoogle, fakeGoogle } from "./fixtures/fake-google.js";
import {
  type Install,
  resetCodeCaps,
  SIGNIN_NEGATIVE_CASES,
  XT_DOMAIN,
} from "./xt/signin-negative.js";

// P2 Task 13: the sign-in negative catalog against two local installs (one
// worker, two envs: different secrets, install ids, hosts and hook keys).
// Cases that need separate D1/KV per install or real DNS run live only.
const m = mailer();
let g: FakeGoogle;
let attacker: CryptoKey;
beforeAll(async () => {
  g = await fakeGoogle();
  attacker = (await generateKeyPair("RS256")).privateKey;
});
afterAll(() => g.restore());

function local(id: string, secret: string, hookKey: string): Install {
  const appHost = `${id}.localhost`;
  const contentHost = `${id}-content.localhost`;
  const e = {
    ...direct({
      INSTALL_ID: id,
      SESSION_SECRET: secret,
      APP_HOST: appHost,
      CONTENT_HOST: contentHost,
    }),
    ...m.env,
    TEST_HOOKS: "1",
    TEST_HOOK_KEY: hookKey,
    // #393: hook sessions only for addresses under TEST_DOMAIN.
    TEST_DOMAIN: XT_DOMAIN,
  } as Env;
  return {
    origin: `http://${appHost}`,
    contentOrigin: `http://${contentHost}`,
    hookKey,
    sessionCookie: "oa_session",
    codeCookie: "oa_code",
    // Signed by a key Google never published.
    forgeGoogleCode: async ({ nonce, challenge }) =>
      g.issueCode({ nonce }, challenge, attacker),
    async fetch(req) {
      const waits: Promise<unknown>[] = [];
      // The edge routes by Host: a swapped Host header reaches this worker
      // as that hostname.
      const url = new URL(req.url);
      const host = req.headers.get("host");
      if (host) url.host = host;
      const r = await worker.fetch(
        new Request(url, {
          method: req.method,
          body: req.body,
          redirect: "manual",
          headers: new Headers([
            ...req.headers,
            [
              "cf-connecting-ip",
              `198.51.100.${Math.floor(Math.random() * 250)}`,
            ],
          ]),
        }) as never,
        e,
        {
          waitUntil: (p: Promise<unknown>) => waits.push(p),
          passThroughOnException() {},
        } as never,
      );
      await Promise.all(waits);
      return r;
    },
  };
}
const A = local("xt-a", "a".repeat(40), "A".repeat(32));
const B = local("xt-b", "b".repeat(40), "B".repeat(32));

describe("sign-in negative catalog (local)", () => {
  for (const c of SIGNIN_NEGATIVE_CASES) {
    const t = c.liveOnly ? it.skip : it;
    t(c.name, () => c.run(A, B));
  }

  it("resetCodeCaps (the live beforeAll's reset) answers 200 with a count", async () => {
    expect(await resetCodeCaps(A)).toBeGreaterThanOrEqual(0);
    expect(await resetCodeCaps(B)).toBeGreaterThanOrEqual(0);
  });

  it("a failing case's message holds no key, code or cookie", async () => {
    const leak =
      SIGNIN_NEGATIVE_CASES[0] as (typeof SIGNIN_NEGATIVE_CASES)[number];
    let msg = "";
    try {
      await leak.run(A, A);
    } catch (e) {
      msg = String(e instanceof Error ? `${e.message}\n${e.stack}` : e);
    }
    expect(msg).toMatch(/got 200 \(body sha256 [0-9a-f]{12}\)/);
    for (const secret of [A.hookKey, "oa_session=", "Bearer"])
      expect(msg).not.toContain(secret);
    expect(msg).not.toMatch(/\b\d{8}\b/);
  });

  // The catalog must fail when B is really A (same secret): it can catch a leak.
  it.each(SIGNIN_NEGATIVE_CASES.filter((c) => !c.liveOnly).slice(0, 2))(
    "catches a broken install: $name",
    async (c) => {
      await expect(c.run(A, A)).rejects.toThrow();
    },
  );
});
