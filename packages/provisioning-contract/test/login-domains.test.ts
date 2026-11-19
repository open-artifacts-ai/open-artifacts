// The shapes an install and the platform share for an owner's login-domain
// change (#2520). Both repos run this.
import { describe, expect, it } from "vitest";
import {
  LOGIN_DOMAINS_PATH,
  LoginDomainsAcceptedSchema,
  LoginDomainsBodySchema,
  LoginDomainsErrorSchema,
} from "../src/login-domains.js";

const NONCE = "AAAAAAAAAAAAAAAAAAAAAA";
const ok = {
  ts: 1_794_000_000_000,
  nonce: NONCE,
  ownerUserId: "u_abc-123",
  hd: "acme.io",
  domains: ["acme.io"],
  autoJoin: true,
};

describe("login-domains contract", () => {
  it("the path is fixed", () => {
    expect(LOGIN_DOMAINS_PATH).toBe("/login-domains");
  });

  it("the body is exactly the six fields", () => {
    expect(LoginDomainsBodySchema.parse(ok)).toEqual(ok);
    expect(
      LoginDomainsBodySchema.parse({ ...ok, hd: "", domains: [] }).hd,
    ).toBe("");
    for (const bad of [
      { ...ok, extra: 1 },
      { ...ok, install: "iabc123456789" },
      { ...ok, nonce: "short" },
      { ...ok, ownerUserId: "has space" },
      { ...ok, ownerUserId: "" },
      { ...ok, hd: "ACME.io" },
      { ...ok, hd: "localhost" },
      { ...ok, domains: "acme.io" },
      { ...ok, autoJoin: "yes" },
      { ts: ok.ts, nonce: NONCE },
    ])
      expect(
        LoginDomainsBodySchema.safeParse(bad).success,
        JSON.stringify(bad),
      ).toBe(false);
  });

  it("the answer is { ok: true, applying: true } and nothing else", () => {
    expect(
      LoginDomainsAcceptedSchema.parse({ ok: true, applying: true }),
    ).toEqual({
      ok: true,
      applying: true,
    });
    for (const bad of [
      {},
      { ok: true },
      { ok: false, applying: true },
      { ok: true, applying: true, x: 1 },
    ])
      expect(LoginDomainsAcceptedSchema.safeParse(bad).success).toBe(false);
  });

  it("a refusal's code is one of the platform's fixed ones", () => {
    for (const c of [
      "replay",
      "plan_required",
      "rate_limited",
      "apply_pending",
      "bad_domain",
    ])
      expect(LoginDomainsErrorSchema.safeParse(c).success).toBe(true);
    expect(LoginDomainsErrorSchema.safeParse("something_else").success).toBe(
      false,
    );
  });
});
