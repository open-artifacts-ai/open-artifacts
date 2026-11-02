// #1088: the provisioner re-checks signups.vars itself (2.5 item 3), so
// EMAIL_CODE_DOMAIN must pass there, and only under the rules the server needs.
import { describe, expect, it } from "vitest";
import { strictVars } from "../../src/recheck.js";

const opts = {
  source: "admin",
  selfServeTier: "free",
  testHooks: false,
  env: "staging",
} as const;
/** The refusal's detail: its message is the fixed public text. */
const why = (raw: string, o: Parameters<typeof strictVars>[1] = opts) => {
  try {
    strictVars(raw, o);
  } catch (e) {
    return (e as { detail?: string }).detail;
  }
  return "no refusal";
};
const vars = (o: Record<string, string> = {}) =>
  JSON.stringify({
    AUTH_PROVIDERS: "email",
    AUTH_DOMAINS: "acme.test",
    TIER: "business",
    EMAIL_CODE_DOMAIN: "on",
    ...o,
  });

describe("strictVars: EMAIL_CODE_DOMAIN", () => {
  it("on passes through to what create renders", () => {
    expect(strictVars(vars(), opts)).toMatchObject({ EMAIL_CODE_DOMAIN: "on" });
  });
  it("absent stays absent", () => {
    const raw = JSON.stringify({
      AUTH_PROVIDERS: "email",
      AUTH_DOMAINS: "",
      TIER: "business",
    });
    expect(strictVars(raw, opts)).not.toHaveProperty("EMAIL_CODE_DOMAIN");
  });
  it("refuses any value but on", () => {
    expect(why(vars({ EMAIL_CODE_DOMAIN: "off" }))).toMatch(
      /EMAIL_CODE_DOMAIN/,
    );
  });
  it("refuses it with no email, with google, or with no domain", () => {
    for (const o of [
      { AUTH_PROVIDERS: "google" },
      { AUTH_PROVIDERS: "google,email" },
      { AUTH_DOMAINS: "" },
    ])
      expect(why(vars(o)), JSON.stringify(o)).toMatch(/EMAIL_CODE_DOMAIN/);
  });
  it("refuses it on self-serve", () => {
    expect(
      why(vars({ TIER: "free" }), { ...opts, source: "self-serve" }),
    ).toMatch(/EMAIL_CODE_DOMAIN/);
  });
  it("other extra vars are still refused", () => {
    expect(why(vars({ EXTRA: "x" }))).toMatch(/not allowed/);
  });
});
