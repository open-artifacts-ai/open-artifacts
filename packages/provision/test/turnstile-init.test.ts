// P1 Task 8: turnstile-init, the one-time per-env Turnstile widget, against
// the in-memory Cloudflare. Idempotent; a same-named widget that differs is
// refused, and the secret never appears in a result or an error.
import { describe, expect, it } from "vitest";
import { cfClient } from "../src/cf.js";
import { platformNames } from "../src/names.js";
import {
  type TurnstileKeys,
  TurnstileRefused,
  turnstileInit,
} from "../src/turnstile.js";
import { HOSTED_DOMAINS } from "../src/wfp.js";
import { FakeCf } from "./fake-cf.js";

function setup(env: "staging" | "prod" = "staging") {
  const fake = new FakeCf();
  const cf = cfClient({
    accountId: fake.accountId,
    token: fake.token,
    fetch: fake.fetch,
    sleep: async () => {},
  });
  let saved: TurnstileKeys | null = null;
  const writes: TurnstileKeys[] = [];
  const store = {
    read: async () => saved,
    write: async (k: TurnstileKeys) => {
      writes.push(k);
      saved = k;
    },
  };
  return {
    fake,
    cf,
    env,
    store,
    writes,
    saved: () => saved,
    setSaved: (k: TurnstileKeys | null) => {
      saved = k;
    },
  };
}

const posts = (fake: FakeCf) =>
  fake.log.filter(
    (e) => e.method === "POST" && /\/challenges\/widgets$/.test(e.path),
  ).length;

describe("turnstileInit", () => {
  it("creates the env's widget once, stores its keys, and a rerun is a no-op", async () => {
    const s = setup();
    const r = await turnstileInit({ cf: s.cf, env: s.env, store: s.store });
    expect(r).toEqual({ created: true, stored: true });
    const [w] = [...s.fake.turnstile.values()];
    expect(w).toMatchObject({
      name: platformNames("staging").turnstile,
      domains: [HOSTED_DOMAINS.staging.app],
      mode: "managed",
    });
    expect(s.saved()).toEqual({ sitekey: w?.sitekey, secret: w?.secret });
    expect(JSON.stringify(r)).not.toContain(String(w?.secret));

    const again = await turnstileInit({ cf: s.cf, env: s.env, store: s.store });
    expect(again).toEqual({ created: false, stored: false });
    expect(posts(s.fake)).toBe(1);
    expect(s.writes).toHaveLength(1);
  });

  it("a widget made earlier whose keys were never stored is stored, not recreated", async () => {
    const s = setup();
    await turnstileInit({ cf: s.cf, env: s.env, store: s.store });
    s.setSaved(null);
    const r = await turnstileInit({ cf: s.cf, env: s.env, store: s.store });
    expect(r).toEqual({ created: false, stored: true });
    expect(posts(s.fake)).toBe(1);
  });

  it.each([
    ["other domains", { domains: ["example.com"] }],
    ["two domains", { domains: ["open-artifacts-staging.app", "x.app"] }],
    ["another mode", { mode: "invisible" }],
  ])("refuses a same-named widget with %s, writing nothing", async (_n, d) => {
    const s = setup();
    s.fake.turnstile.set("0xEXISTING", {
      sitekey: "0xEXISTING",
      name: platformNames("staging").turnstile,
      domains: [HOSTED_DOMAINS.staging.app],
      mode: "managed",
      secret: "0xsecret-existing-value",
      ...d,
    });
    const e = await turnstileInit({
      cf: s.cf,
      env: s.env,
      store: s.store,
    }).catch((x) => x);
    expect(e).toBeInstanceOf(TurnstileRefused);
    expect(String(e.message)).toMatch(/differs/);
    expect(String(e.message)).not.toContain("0xsecret-existing-value");
    expect(posts(s.fake)).toBe(0);
    expect(s.writes).toEqual([]);
  });

  it("refuses two widgets with the env's name, and stored keys of another widget", async () => {
    const s = setup();
    for (const k of ["0xA", "0xB"])
      s.fake.turnstile.set(k, {
        sitekey: k,
        name: platformNames("staging").turnstile,
        domains: [HOSTED_DOMAINS.staging.app],
        mode: "managed",
        secret: `secret-${k}`,
      });
    await expect(
      turnstileInit({ cf: s.cf, env: s.env, store: s.store }),
    ).rejects.toThrow(/2 widgets/);

    const t = setup();
    await turnstileInit({ cf: t.cf, env: t.env, store: t.store });
    t.setSaved({ sitekey: "0xOTHER", secret: "x" });
    await expect(
      turnstileInit({ cf: t.cf, env: t.env, store: t.store }),
    ).rejects.toThrow(/keychain/);

    const u = setup();
    u.setSaved({ sitekey: "0xGONE", secret: "x" });
    await expect(
      turnstileInit({ cf: u.cf, env: u.env, store: u.store }),
    ).rejects.toThrow(/keychain/);
    expect(posts(u.fake)).toBe(0);
  });

  it("the other env's widget is not the env's widget", async () => {
    const s = setup("prod");
    s.fake.turnstile.set("0xSTG", {
      sitekey: "0xSTG",
      name: platformNames("staging").turnstile,
      domains: [HOSTED_DOMAINS.staging.app],
      mode: "managed",
      secret: "s",
    });
    const r = await turnstileInit({ cf: s.cf, env: "prod", store: s.store });
    expect(r.created).toBe(true);
    const made = [...s.fake.turnstile.values()].find(
      (w) => w.sitekey !== "0xSTG",
    );
    expect(made).toMatchObject({
      name: platformNames("prod").turnstile,
      domains: [HOSTED_DOMAINS.prod.app],
    });
  });
});
