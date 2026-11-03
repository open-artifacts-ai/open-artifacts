// #1088: `auth.domainCodes` on a create: code sign-in for the install's
// domains, EMAIL_CODE_DOMAIN=on. The refusals name the field.
import { describe, expect, it } from "vitest";
import { AuthSchema } from "../src/schemas.js";

const ok = { providers: ["email"], domains: ["acme.test"], domainCodes: true };
const paths = (v: unknown) => {
  const r = AuthSchema.safeParse(v);
  return r.success ? [] : r.error.issues.map((i) => i.path.join("."));
};

describe("AuthSchema: domainCodes", () => {
  it("is optional, so an existing create still parses and hashes the same", () => {
    const body = { providers: ["email"], domains: [] };
    expect(AuthSchema.parse(body)).toEqual(body);
  });
  it("true needs email, a domain, and no google", () => {
    expect(paths(ok)).toEqual([]);
    expect(paths({ ...ok, domainCodes: false })).toEqual([]);
    expect(paths({ ...ok, domains: [] })).toEqual(["domainCodes"]);
    expect(paths({ ...ok, providers: ["google"] })).toEqual(["domainCodes"]);
    expect(paths({ ...ok, providers: ["google", "email"] })).toEqual([
      "domainCodes",
    ]);
  });
  it("false never refuses what true would", () => {
    expect(
      paths({ providers: ["google"], domains: ["a.test"], domainCodes: false }),
    ).toEqual([]);
  });
  it("is a boolean", () => {
    expect(paths({ ...ok, domainCodes: "on" })).toEqual(["domainCodes"]);
  });
});
