import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { brokerKey } from "./broker-key.ts";
import {
  alertPinProblems,
  committedRateLimits,
  committedSignups,
  committedVars,
  stripJsonc,
} from "./wrangler-env.ts";

// The read-backs compare to the committed config through wrangler-env.ts;
// the provisioning target's admin broker key comes from broker-key.ts.
const root = join(import.meta.dirname, "../..");
const cfg = (app: string) =>
  readFileSync(join(root, "apps", app, "wrangler.jsonc"), "utf8");

describe("wrangler-env.ts", () => {
  it("the provisioning vars: committed values, the repository id filled", () => {
    const v = committedVars(cfg("provisioning"), "staging", {
      GITHUB_REPOSITORY_ID: "123456",
      SIGNUP_DAILY_CAP: "20",
    });
    expect(v.SIGNUP_DAILY_CAP).toBe("20");
    expect(v.OA_ENV).toBe("staging");
    expect(v.OIDC_REPOSITORY_ID).toBe("123456");
    expect(v.MCP_REDIRECT_URIS).toBe("https://claude.ai/api/mcp/auth_callback");
    expect(JSON.stringify(v)).not.toContain("{{");
    // Prod has no OIDC_* and needs only the cap.
    const p = committedVars(cfg("provisioning"), "prod", {
      SIGNUP_DAILY_CAP: "50",
    });
    expect(Object.keys(p).filter((k) => k.startsWith("OIDC_"))).toEqual([]);
  });
  it("signups: the committed SIGNUPS_ENABLED, a literal or as filled; null when absent", () => {
    expect(committedSignups(cfg("provisioning"), "prod", {})).toBe("false");
    expect(
      committedSignups(cfg("provisioner"), "prod", { SIGNUPS_ENABLED: "true" }),
    ).toBe("true");
    expect(() => committedSignups(cfg("provisioner"), "prod", {})).toThrow(
      "has no value",
    );
    expect(committedSignups(cfg("dispatch"), "prod", {})).toBeNull();
  });
  it("refuses a placeholder with no value, or another env's", () => {
    expect(() =>
      committedVars(cfg("provisioning"), "staging", { SIGNUP_DAILY_CAP: "20" }),
    ).toThrow(
      /OIDC_REPOSITORY_ID: \{\{GITHUB_REPOSITORY_ID_STAGING\}\} has no value/,
    );
    const src = `{"env":{"prod":{"vars":{"A":"{{X_STAGING}}"}}}}`;
    expect(() => committedVars(src, "prod", { X: "1" })).toThrow(/no value/);
  });
  it("the rate limits, sorted by name, ids as strings", () => {
    // The expected list comes from the committed config, read here without
    // wrangler-env.ts, so a new binding needs no edit to this test.
    const raw = (env: "staging" | "prod") =>
      (
        JSON.parse(stripJsonc(cfg("provisioning"))).env[env].ratelimits as {
          name: string;
          namespace_id: string | number;
          simple: { limit: number; period: number };
        }[]
      )
        .map((x) => ({
          name: x.name,
          namespace_id: `${x.namespace_id}`,
          limit: x.simple.limit,
          period: x.simple.period,
        }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const env of ["staging", "prod"] as const) {
      const want = raw(env);
      expect(want.length).toBeGreaterThan(0);
      expect(committedRateLimits(cfg("provisioning"), env)).toEqual(want);
    }
    expect(committedRateLimits(cfg("provisioning"), "prod")).toContainEqual({
      name: "RL_PV_OAUTH_IP",
      namespace_id: "1156",
      limit: 20,
      period: 60,
    });
    // Numeric ids and unsorted input come out as strings, sorted by name.
    const src = `{"env":{"prod":{"ratelimits":[
      {"name":"B","namespace_id":2,"simple":{"limit":1,"period":10}},
      {"name":"A","namespace_id":"1","simple":{"limit":3,"period":60}}]}}}`;
    expect(committedRateLimits(src, "prod")).toEqual([
      { name: "A", namespace_id: "1", limit: 3, period: 60 },
      { name: "B", namespace_id: "2", limit: 1, period: 10 },
    ]);
  });
  it("strips comments outside strings only, and trailing commas", () => {
    const src = `{
      // a comment
      "env": { "prod": { "vars": { "U": "https://x/y", /* b */ "V": "a//b", }, }, },
    }`;
    expect(committedVars(src, "prod", {})).toEqual({
      U: "https://x/y",
      V: "a//b",
    });
  });
});

describe("broker-key.ts", () => {
  it("kid derives from x as provision's brokerKid; pkcs8 is the matching private key", async () => {
    const k = brokerKey();
    // packages/provision/src/wfp.ts brokerKid.
    const kid = createHash("sha256")
      .update(Buffer.from(k.x, "base64url"))
      .digest("base64url")
      .slice(0, 16);
    expect(k.kid).toBe(kid);
    expect(k.x).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const priv = await crypto.subtle.importKey(
      "pkcs8",
      Buffer.from(k.pkcs8, "base64url"),
      { name: "Ed25519" },
      true,
      ["sign"],
    );
    const jwk = (await crypto.subtle.exportKey("jwk", priv)) as JsonWebKey;
    expect(jwk.x).toBe(k.x);
    expect(brokerKey().kid).not.toBe(k.kid);
  });
  it("alert pins: each var and ALERT_EMAIL's destination must be this env's placeholder", () => {
    const conf = (prod: Record<string, unknown>) =>
      JSON.stringify({ env: { prod } });
    const vars = {
      ALERT_TO: "{{ALERT_TO_PROD}}",
      ALERT_FROM: "{{ALERT_FROM_PROD}}",
      SIGNUP_DAILY_CAP: "{{SIGNUP_DAILY_CAP_PROD}}",
      SIGNUPS_ENABLED: "{{SIGNUPS_ENABLED_PROD}}",
    };
    const mail = [
      { name: "ALERT_EMAIL", destination_address: "{{ALERT_TO_PROD}}" },
    ];
    expect(alertPinProblems(conf({ vars, send_email: mail }), "prod")).toEqual(
      [],
    );
    expect(
      alertPinProblems(
        conf({ vars: { ...vars, ALERT_TO: "a@b.com" }, send_email: mail }),
        "prod",
      ),
    ).toEqual(["vars.ALERT_TO is not {{ALERT_TO_PROD}}"]);
    for (const send_email of [
      undefined,
      [{ name: "ALERT_EMAIL" }],
      [{ name: "ALERT_EMAIL", destination_address: "{{ALERT_TO_STAGING}}" }],
      [...mail, ...mail],
    ])
      expect(alertPinProblems(conf({ vars, send_email }), "prod")).toEqual([
        "send_email ALERT_EMAIL needs destination_address {{ALERT_TO_PROD}}",
      ]);
  });
});
