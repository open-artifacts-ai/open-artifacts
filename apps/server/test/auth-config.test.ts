import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import { authConfig } from "../src/auth/config.js";
import type { Env } from "../src/env.js";
import { CID, direct, TEST_BROKER_KEY, trial } from "./auth-helpers.js";

const base = (over: Partial<Env>) =>
  ({ ...env, AUTH_PROVIDERS: undefined, ...over }) as Env;

describe("authConfig", () => {
  test("unset is access only; guests uncapped; invite only", () => {
    const c = authConfig(base({}));
    expect([...c.providers]).toEqual(["access"]);
    expect(c.guestsReadOnly).toBe(false);
    expect(c.domainJoin).toBe("invite");
    expect(c.google).toBeNull();
    expect(c.problems).toEqual([]);
  });

  test("direct: google direct transport and codes", () => {
    const c = authConfig(direct());
    expect([...c.providers].sort()).toEqual(["email", "google"]);
    expect(c.domains).toEqual(["a.com"]);
    expect(c.google).toEqual({
      clientId: CID,
      transport: { kind: "direct", secret: "s" },
    });
    expect(c.domainJoin).toBe("member");
    expect(c.problems).toEqual([]);
  });

  test("unknown providers are dropped with a problem; none left means none", () => {
    const c = authConfig(base({ AUTH_PROVIDERS: "saml" }));
    expect(c.providers.size).toBe(0);
    expect(c.problems).toContain("AUTH_PROVIDERS: unknown provider saml");
  });

  test("FEATURES can't set the guest cap; direct sign-in always does", () => {
    expect(
      authConfig(base({ FEATURES: "guests_read_only" })).guestsReadOnly,
    ).toBe(false);
    expect(authConfig(direct({ FEATURES: "" })).guestsReadOnly).toBe(true);
    expect(
      authConfig(base({ AUTH_PROVIDERS: "access,email" })).guestsReadOnly,
    ).toBe(true);
  });

  test("features are parsed by the shared parser", () => {
    expect(
      authConfig(base({ FEATURES: "spaces,nope,guests_read_only" })).features,
    ).toEqual(["spaces"]);
  });

  test("google without domains is disabled, fail closed", () => {
    const c = authConfig(direct({ AUTH_DOMAINS: "" }));
    expect(c.google).toBeNull();
    expect(c.problems).toContain("google: AUTH_DOMAINS is empty");
  });

  test("google without a client id or secret is disabled", () => {
    expect(authConfig(direct({ GOOGLE_CLIENT_ID: "" })).google).toBeNull();
    expect(authConfig(direct({ GOOGLE_CLIENT_SECRET: "" })).google).toBeNull();
  });

  test("invalid domains are dropped with a problem", () => {
    const c = authConfig(direct({ AUTH_DOMAINS: "a.com,bad domain" }));
    expect(c.domains).toEqual(["a.com"]);
    expect(c.problems).toContain("AUTH_DOMAINS: invalid domain bad domain");
  });

  test("domain codes need email, no google, turnstile and domains", () => {
    expect(authConfig(trial()).domainCodes).toBe(true);
    expect(
      authConfig(trial({ AUTH_PROVIDERS: "google,email" })).domainCodes,
    ).toBe(false);
    expect(authConfig(trial({ TURNSTILE_SECRET: "" })).domainCodes).toBe(false);
    expect(authConfig(trial({ AUTH_DOMAINS: "" })).domainCodes).toBe(false);
    expect(authConfig(trial({ EMAIL_CODE_DOMAIN: "yes" })).domainCodes).toBe(
      false,
    );
  });

  test("turnstile needs both keys", () => {
    expect(authConfig(trial()).turnstile).toEqual({
      siteKey: "k",
      secret: "s",
    });
    const c = authConfig(trial({ TURNSTILE_SITE_KEY: "" }));
    expect(c.turnstile).toBeNull();
    expect(c.problems).toContain(
      "turnstile: TURNSTILE_SITE_KEY and TURNSTILE_SECRET are both required",
    );
  });

  test("broker transport needs https, INSTALL_ID and a PKCS8 Ed25519 key", () => {
    const ok = direct({
      AUTH_BROKER_URL: "https://auth.h.test",
      BROKER_SIGNING_KEY: TEST_BROKER_KEY,
    });
    expect(authConfig(ok).google?.transport).toEqual({
      kind: "broker",
      url: "https://auth.h.test",
      installId: "inst-a",
      signingKey: TEST_BROKER_KEY,
    });
    for (const over of [
      { BROKER_SIGNING_KEY: "not-a-key" },
      { BROKER_SIGNING_KEY: undefined },
      { INSTALL_ID: undefined },
      { AUTH_BROKER_URL: "http://auth.h.test" },
    ])
      expect(authConfig({ ...ok, ...over } as Env).google).toBeNull();
  });

  test("HOSTED=1 fails closed unless the broker transport is configured", () => {
    const hostedDirect = authConfig(direct({ HOSTED: "1" }));
    expect(hostedDirect.google).toBeNull();
    expect(hostedDirect.problems).toContain(
      "google: HOSTED=1 requires the broker transport (AUTH_BROKER_URL)",
    );

    // A tenant-supplied shared secret is never accepted on a hosted install:
    // only the broker transport is allowed.
    const hostedBroker = authConfig(
      direct({
        HOSTED: "1",
        GOOGLE_CLIENT_SECRET: "tenant-supplied",
        AUTH_BROKER_URL: "https://auth.h.test",
        BROKER_SIGNING_KEY: TEST_BROKER_KEY,
      }),
    );
    expect(hostedBroker.google?.transport).toMatchObject({ kind: "broker" });

    // A broken broker URL still refuses direct.
    for (const url of ["http://auth.h.test", "not a url"]) {
      const c = authConfig(
        direct({
          HOSTED: "1",
          AUTH_BROKER_URL: url,
          BROKER_SIGNING_KEY: TEST_BROKER_KEY,
        }),
      );
      expect(c.google).toBeNull();
    }
  });

  test("HOSTED=1 admits by invite only: member is refused with a problem", () => {
    const hosted = (over: Partial<Env>) =>
      authConfig(
        direct({
          HOSTED: "1",
          AUTH_BROKER_URL: "https://auth.h.test",
          BROKER_SIGNING_KEY: TEST_BROKER_KEY,
          ...over,
        }),
      );
    const member = hosted({ AUTH_DOMAIN_JOIN: "member" });
    expect(member.domainJoin).toBe("invite");
    expect(member.problems).toContain(
      "AUTH_DOMAIN_JOIN: HOSTED=1 allows invite only",
    );
    for (const join of [undefined, "invite"]) {
      const c = hosted({ AUTH_DOMAIN_JOIN: join });
      expect(c.domainJoin).toBe("invite");
      expect(c.problems).toEqual([]);
    }
    // Self-host is unchanged.
    expect(authConfig(direct({ AUTH_DOMAIN_JOIN: "member" })).domainJoin).toBe(
      "member",
    );
  });

  test("code email pool: 1..10000, default 200", () => {
    expect(authConfig(direct()).codeEmailsPerDay).toBe(200);
    expect(
      authConfig(direct({ CODE_EMAILS_PER_DAY: "50" })).codeEmailsPerDay,
    ).toBe(50);
    for (const v of ["0", "10001", "abc", "1.5", ""])
      expect(
        authConfig(direct({ CODE_EMAILS_PER_DAY: v })).codeEmailsPerDay,
      ).toBe(200);
  });

  test("installKey falls back to APP_HOST", () => {
    expect(authConfig(direct()).installKey).toBe("inst-a");
    expect(authConfig(direct({ INSTALL_ID: undefined })).installKey).toBe(
      env.APP_HOST,
    );
  });

  test("memoized per env object", () => {
    const e = direct();
    expect(authConfig(e)).toBe(authConfig(e));
  });
});
