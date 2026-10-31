import type { AuditEntry } from "@oa/shared/provisioning";
import { describe, expect, it } from "vitest";
import type { Principal } from "../src/principal.js";
import {
  isEmailValue,
  mayReadPii,
  REDACTED_LABEL,
  redactAuditEntry,
} from "../src/services/pii.js";

const P = (kind: Principal["kind"], scopes: Principal["scopes"] = []) =>
  ({ kind, actorKey: "x", rateKey: "x", label: "x", scopes }) as Principal;
const entry = (detail: AuditEntry["detail"]): AuditEntry => ({
  id: "api:1",
  at: 1,
  source: "api",
  actor: { kind: "token", label: "ci" },
  action: "token.used",
  installId: null,
  jobId: null,
  outcome: "ok",
  code: null,
  count: 1,
  detail,
});

describe("R17 email rule (4.9): tokens without installs:pii see no email detail", () => {
  it("only a token principal without installs:pii is redacted", () => {
    expect(mayReadPii(P("admin"))).toBe(true);
    expect(mayReadPii(P("oidc"))).toBe(true);
    expect(mayReadPii(P("token", ["audit:read", "installs:pii"]))).toBe(true);
    expect(mayReadPii(P("token", ["audit:read"]))).toBe(false);
  });

  it("recognizes email values, not other strings", () => {
    for (const v of ["me@leourbina.com", "A.B+c@x.co", " me@x.io "])
      expect(isEmailValue(v), v).toBe(true);
    for (const v of ["@me", "me@", "user:abc", "a@b", "x", 1, null, "a b@c.d"])
      expect(isEmailValue(v), String(v)).toBe(false);
  });

  it("nulls every email-valued field, nested and in arrays, by value not by key", () => {
    const d = {
      admin: "me@leourbina.com",
      ownerEmail: "owner@acme.test",
      // Post-M1 rows may carry emails under any key (14.4).
      args: { to: "new@acme.test", version: "1.2.3" },
      cc: ["a@acme.test", "n/a"],
      route: "R2",
      count: 3,
    };
    expect(
      redactAuditEntry(entry(d), P("token", ["audit:read"])).detail,
    ).toEqual({
      admin: null,
      ownerEmail: null,
      args: { to: null, version: "1.2.3" },
      cc: [null, "n/a"],
      route: "R2",
      count: 3,
    });
  });

  it("nulls a string that holds an email among other text", () => {
    const d = {
      message: "invite to a@acme.test failed",
      owner: "Ann <ann@acme.test>",
      note: "no email here",
      nested: { why: "sent to b@acme.test" },
    };
    expect(
      redactAuditEntry(entry(d), P("token", ["audit:read"])).detail,
    ).toEqual({
      message: null,
      owner: null,
      note: "no email here",
      nested: { why: null },
    });
  });

  it("keeps detail.admin on the caller's own admin's rows (9A.8)", () => {
    const me = {
      ...P("token", ["audit:read"]),
      email: "Me@LeoUrbina.com",
    } as Principal;
    const d = { admin: "me@leourbina.com", ownerEmail: "owner@acme.test" };
    expect(redactAuditEntry(entry(d), me).detail).toEqual({
      admin: "me@leourbina.com",
      ownerEmail: null,
    });
    expect(
      redactAuditEntry(entry({ admin: "other@leourbina.com" }), me).detail,
    ).toEqual({ admin: null });
  });

  it("an email actor label is hidden, unless it is the caller's own admin", () => {
    const me = {
      ...P("token", ["audit:read"]),
      email: "me@leourbina.com",
    } as Principal;
    const other = {
      ...entry(null),
      actor: { kind: "user", label: "owner@acme.test" },
    } as AuditEntry;
    expect(redactAuditEntry(other, me).actor).toEqual({
      kind: "user",
      label: REDACTED_LABEL,
    });
    const own = {
      ...entry(null),
      actor: { kind: "admin", label: "me@leourbina.com" },
    } as AuditEntry;
    expect(redactAuditEntry(own, me)).toEqual(own);
    expect(redactAuditEntry(other, P("admin"))).toBe(other);
  });

  it("leaves everything as is for a principal that may read PII", () => {
    const e = entry({ admin: "me@leourbina.com" });
    expect(redactAuditEntry(e, P("admin"))).toBe(e);
    expect(
      redactAuditEntry(e, P("token", ["audit:read", "installs:pii"])),
    ).toBe(e);
  });

  it("null detail stays null; nothing else in the entry changes", () => {
    const e = entry(null);
    expect(redactAuditEntry(e, P("token", ["audit:read"]))).toEqual(e);
  });
});
