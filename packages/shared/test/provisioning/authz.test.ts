import { describe, expect, it } from "vitest";
import {
  AUTHZ,
  AUTHZ_COLUMNS,
  authorize,
  CREATE_FIELDS,
  canTransition,
  checkCreateFields,
  checkPurgeFields,
  createFieldRule,
  InstallStateSchema,
  JobKindSchema,
  OIDC_LIMITS,
  oidcMayCreate,
  oidcOwns,
  PROTOCOL_ROUTES,
  PURGE_FIELD_RULES,
  ROUTE_IDS,
  ROUTES,
  TOKEN_DELETING_PURGE,
  TokenScopeSchema,
  TRANSITIONS,
} from "../../src/provisioning/index.js";

const ALL_SCOPES = TokenScopeSchema.options;

describe("authz table", () => {
  it("covers every route x principal column", () => {
    expect(Object.keys(AUTHZ).sort()).toEqual([...ROUTE_IDS].sort());
    for (const id of ROUTE_IDS)
      for (const c of AUTHZ_COLUMNS)
        expect(AUTHZ[id][c], `${id} ${c}`).toBeDefined();
  });

  it("no auth is 401 everywhere except the sign-in routes", () => {
    for (const id of ROUTE_IDS) {
      const d = authorize(id, null, "prod");
      if (id === "R22" || id === "R23") expect(d.ok, id).toBe(true);
      else expect(d, id).toEqual({ ok: false, code: "unauthenticated" });
    }
  });

  it("a token needs the row's scope; every token row with a scope refuses without it", () => {
    for (const id of ROUTE_IDS) {
      const r = AUTHZ[id].token;
      if (!r.allow || !r.scope) continue;
      expect(authorize(id, { kind: "token", scopes: [] }, "prod"), id).toEqual({
        ok: false,
        code: "forbidden",
      });
      expect(
        authorize(id, { kind: "token", scopes: [r.scope] }, "prod").ok,
        id,
      ).toBe(true);
    }
  });

  it("tokens cannot mint, manage tokens, release leases, cancel, or get redline creds", () => {
    for (const id of ["R13", "R19", "R20", "R21", "R25", "R26"] as const)
      expect(
        authorize(id, { kind: "token", scopes: ALL_SCOPES }, "prod"),
        id,
      ).toEqual({
        ok: false,
        code: "forbidden",
      });
  });

  it("pins the scope per token row", () => {
    const scope = (id: (typeof ROUTE_IDS)[number]) => {
      const r = AUTHZ[id].token;
      return r.allow ? (r.scope ?? null) : r.code;
    };
    expect(scope("R1")).toBeNull();
    for (const id of ["R2", "R3", "R14", "R15", "R16", "R18", "R27"] as const)
      expect(scope(id), id).toBe("installs:read");
    for (const id of ["R4", "R5", "R6", "R7", "R8", "R12"] as const)
      expect(scope(id), id).toBe("installs:write");
    for (const id of ["R9", "R10", "R11"] as const)
      expect(scope(id), id).toBe("installs:delete");
    expect(scope("R17")).toBe("audit:read");
  });

  it("admin session reaches every API route but R26", () => {
    for (const id of ROUTE_IDS) {
      const d = authorize(id, { kind: "admin" }, "prod");
      if (id === "R26") expect(d, id).toEqual({ ok: false, code: "forbidden" });
      else expect(d.ok, id).toBe(true);
    }
  });

  it("self-serve user: own installs only, never operator routes", () => {
    const u = (id: (typeof ROUTE_IDS)[number]) =>
      authorize(id, { kind: "user" }, "prod");
    for (const id of ["R2", "R3", "R4", "R9", "R10", "R14", "R15"] as const)
      expect(u(id), id).toEqual({ ok: true, reach: "own" });
    for (const id of [
      "R5",
      "R6",
      "R7",
      "R8",
      "R11",
      "R12",
      "R13",
      "R16",
      "R17",
      "R19",
      "R20",
      "R21",
      "R25",
      "R26",
      "R27",
    ] as const)
      expect(u(id), id).toEqual({ ok: false, code: "forbidden" });
    expect(u("R18")).toEqual({ ok: true, reach: "all" });
  });

  it("system never goes through a route", () => {
    for (const id of ROUTE_IDS)
      expect(authorize(id, { kind: "system" }, "staging").ok, id).toBe(false);
  });
});

describe("OIDC principal (Q1: staging only, rl- test installs)", () => {
  it("prod refuses OIDC on every route", () => {
    for (const id of ROUTE_IDS)
      expect(authorize(id, { kind: "oidc" }, "prod"), id).toEqual({
        ok: false,
        code: "unauthenticated",
      });
  });

  it("staging: own rl- installs for writes and reads, never tokens, leases, cancel or world", () => {
    const o = (id: (typeof ROUTE_IDS)[number]) =>
      authorize(id, { kind: "oidc" }, "staging");
    for (const id of [
      "R2",
      "R3",
      "R4",
      "R5",
      "R6",
      "R7",
      "R8",
      "R9",
      "R10",
      "R11",
      "R12",
      "R14",
      "R15",
      "R17",
      "R26",
    ] as const)
      expect(o(id), id).toEqual({ ok: true, reach: "own" });
    for (const id of ["R1", "R16", "R18"] as const)
      expect(o(id).ok, id).toBe(true);
    for (const id of ["R13", "R19", "R20", "R21", "R25", "R27"] as const)
      expect(o(id), id).toEqual({ ok: false, code: "forbidden" });
  });

  it("limits: rl- slug, testHooks and a @STAGING_TEST_DOMAIN owner", () => {
    expect(OIDC_LIMITS).toEqual({
      envs: ["staging"],
      slugPrefix: "rl-",
      testHooks: true,
    });
    const D = "test.example";
    const ok = { slug: "rl-a", testHooks: true, ownerEmail: "ci@test.example" };
    expect(oidcMayCreate(ok, D)).toBe(true);
    expect(oidcMayCreate({ ...ok, ownerEmail: "CI@Test.Example" }, D)).toBe(
      true,
    );
    expect(oidcMayCreate({ ...ok, testHooks: undefined }, D)).toBe(false);
    expect(oidcMayCreate({ ...ok, slug: "acme" }, D)).toBe(false);
    expect(oidcMayCreate({ ...ok, ownerEmail: "ci@acme.com" }, D)).toBe(false);
    expect(
      oidcMayCreate({ ...ok, ownerEmail: "ci@evil.test.example" }, D),
    ).toBe(false);
    expect(oidcMayCreate({ ...ok, ownerEmail: undefined }, D)).toBe(false);
    expect(oidcOwns({ slug: "rl-b", testHooks: true })).toBe(true);
    expect(oidcOwns({ slug: "rl-b", testHooks: false })).toBe(false);
    expect(oidcOwns({ slug: "leo", testHooks: true })).toBe(false);
  });
});

describe("protocol routes", () => {
  it("are not API routes; host placement is fixed", () => {
    const at = (p: string) => PROTOCOL_ROUTES.find((r) => r.path === p)?.host;
    expect(at("/mcp")).toBe("api");
    expect(at("/oauth/authorize")).toBe("admin");
    expect(at("/oauth/token")).toBe("api");
    expect(at("/oauth/register")).toBe("api");
    expect(
      PROTOCOL_ROUTES.filter((r) => r.path === "/oauth/authorize").map(
        (r) => `${r.method} ${r.host}`,
      ),
    ).toEqual(["GET admin", "POST admin"]);
    // RFC 9728, the path WWW-Authenticate's resource_metadata names (9A.3).
    expect(at("/.well-known/oauth-protected-resource/mcp")).toBe("api");
    expect(at("/.well-known/oauth-protected-resource")).toBeUndefined();
    for (const r of PROTOCOL_ROUTES)
      expect(
        Object.values(ROUTES).some((x) => x.path === r.path),
        r.path,
      ).toBe(false);
  });
});

describe("TRANSITIONS", () => {
  const states = ["none", ...InstallStateSchema.options] as const;

  it("is total: every state has a row, every target is a state, every kind is a job kind", () => {
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...states].sort());
    for (const s of states)
      for (const [kind, t] of Object.entries(TRANSITIONS[s])) {
        expect(JobKindSchema.options, `${s} ${kind}`).toContain(kind);
        for (const to of t?.to ?? [])
          expect(InstallStateSchema.options).toContain(to);
      }
  });

  it("pins the 5.1 table", () => {
    expect(canTransition("none", "create", "A")).toBe(true);
    expect(canTransition("none", "create", "U")).toBe(true);
    expect(canTransition("failed", "retry", "A")).toBe(true);
    expect(canTransition("failed", "purge", "A")).toBe(true);
    expect(canTransition("failed", "discard", "A")).toBe(true);
    expect(canTransition("active", "upgrade", "A")).toBe(true);
    expect(canTransition("active", "suspend", "A")).toBe(true);
    expect(canTransition("active", "delete", "U")).toBe(true);
    expect(canTransition("suspended", "delete", "A")).toBe(true);
    expect(canTransition("suspended", "delete", "U")).toBe(false);
    expect(canTransition("suspended", "upgrade", "A")).toBe(true);
    expect(canTransition("deleting", "restore", "U")).toBe(true);
    expect(canTransition("deleting", "purge", "A")).toBe(true);
    expect(canTransition("deleting", "purge", "S")).toBe(true);
    expect(canTransition("deleting", "purge", "U")).toBe(false);
    expect(TRANSITIONS.deleting.restore?.to).toEqual(["active", "suspended"]);
  });

  it("tokens (T): A's rows, but never purge a deleting install (4.1)", () => {
    expect(canTransition("failed", "purge", "T")).toBe(true);
    expect(canTransition("failed", "discard", "T")).toBe(true);
    expect(canTransition("deleting", "purge", "T")).toBe(false);
    expect(canTransition("active", "redline_creds", "T")).toBe(false);
    expect(canTransition("active", "release_lease", "T")).toBe(false);
    for (const [from, row] of Object.entries(TRANSITIONS))
      for (const [kind, t] of Object.entries(row))
        if (t?.actors.includes("T"))
          expect(t.actors, `${from} ${kind}`).toContain("A");
  });

  it("refuses what the table does not list", () => {
    expect(canTransition("active", "resume", "A")).toBe(false);
    expect(canTransition("active", "purge", "A")).toBe(false);
    expect(canTransition("deleted", "restore", "A")).toBe(false);
    expect(canTransition("provisioning", "upgrade", "A")).toBe(false);
    expect(canTransition("suspended", "suspend", "A")).toBe(false);
    for (const k of JobKindSchema.options)
      expect(canTransition("deleted", k, "A"), k).toBe(false);
  });
});

describe("R4 field rules (3.3)", () => {
  const D = "test.example";
  const auth = { providers: ["google"], domains: ["acme.com"] };
  const full = { ownerEmail: "o@acme.com", tier: "team", auth };

  it("admin testHooks: staging allowed, prod 403 forbidden", () => {
    expect(createFieldRule("testHooks", "admin", "staging")).toBe("optional");
    expect(createFieldRule("testHooks", "admin", "prod")).toBe("forbidden");
    expect(
      checkCreateFields({ ...full, testHooks: true }, "admin", "staging", D),
    ).toBeNull();
    expect(
      checkCreateFields({ ...full, testHooks: true }, "admin", "prod", D),
    ).toEqual({ field: "testHooks", code: "forbidden" });
  });

  it("token: ownerEmail's domain must be in auth.domains", () => {
    expect(checkCreateFields(full, "token", "prod", D)).toBeNull();
    expect(
      checkCreateFields(
        { ...full, ownerEmail: "o@ACME.com" },
        "token",
        "prod",
        D,
      ),
    ).toBeNull();
    expect(
      checkCreateFields(
        { ...full, ownerEmail: "o@evil.com" },
        "token",
        "prod",
        D,
      ),
    ).toEqual({ field: "ownerEmail", code: "forbidden" });
    for (const f of ["sendWelcome", "testHooks"] as const)
      expect(
        checkCreateFields({ ...full, [f]: true }, "token", "prod", D),
      ).toEqual({ field: f, code: "forbidden" });
  });

  it("oidc: testHooks true and an @STAGING_TEST_DOMAIN owner", () => {
    const o = {
      ...full,
      slug: "rl-a",
      ownerEmail: "ci@test.example",
      testHooks: true,
    };
    expect(checkCreateFields(o, "oidc", "staging", D)).toBeNull();
    expect(
      checkCreateFields(
        { ...o, ownerEmail: "o@acme.com" },
        "oidc",
        "staging",
        D,
      ),
    ).toEqual({ field: "ownerEmail", code: "forbidden" });
    expect(
      checkCreateFields({ ...o, testHooks: false }, "oidc", "staging", D),
    ).toEqual({ field: "testHooks", code: "forbidden" });
    expect(
      checkCreateFields({ ...o, testHooks: undefined }, "oidc", "staging", D),
    ).toEqual({ field: "testHooks", code: "invalid_input" });
  });

  it("oidc slug: rl- only on staging, refused on prod; one call enforces it", () => {
    const o = {
      ...full,
      slug: "rl-a",
      ownerEmail: "ci@test.example",
      testHooks: true,
    };
    expect(checkCreateFields(o, "oidc", "staging", D)).toBeNull();
    expect(
      checkCreateFields({ ...o, slug: "rl-q-123" }, "oidc", "staging", D),
    ).toBeNull();
    expect(
      checkCreateFields({ ...o, slug: "acme" }, "oidc", "staging", D),
    ).toEqual({ field: "slug", code: "forbidden" });
    expect(
      checkCreateFields({ ...o, slug: undefined }, "oidc", "staging", D),
    ).toEqual({ field: "slug", code: "invalid_input" });
    expect(checkCreateFields(o, "oidc", "prod", D)).toEqual({
      field: "slug",
      code: "forbidden",
    });
    // Other principals: any slug.
    for (const p of ["admin", "token"] as const)
      expect(
        checkCreateFields({ ...full, slug: "acme" }, p, "prod", D),
      ).toBeNull();
  });

  it("user: server-set and forbidden fields are 403 if present; turnstile is its own step", () => {
    expect(checkCreateFields({}, "user", "prod", D)).toBeNull();
    for (const f of [
      "ownerEmail",
      "tier",
      "auth",
      "version",
      "sendWelcome",
      "testHooks",
    ] as const)
      expect(checkCreateFields({ [f]: "x" }, "user", "prod", D), f).toEqual({
        field: f,
        code: "forbidden",
      });
  });

  it("missing required fields are 400; forbidden ones come first", () => {
    expect(
      checkCreateFields({ tier: "team", auth }, "admin", "prod", D),
    ).toEqual({ field: "ownerEmail", code: "invalid_input" });
    expect(checkCreateFields({ testHooks: true }, "admin", "prod", D)).toEqual({
      field: "testHooks",
      code: "forbidden",
    });
  });

  it("every field has a rule for every principal and env", () => {
    for (const f of CREATE_FIELDS)
      for (const p of ["admin", "token", "oidc", "user"] as const)
        for (const e of ["staging", "prod"] as const)
          expect(typeof createFieldRule(f, p, e), `${f} ${p} ${e}`).toBe(
            "string",
          );
  });
});

describe("R11 field rules (3.4, 4.2)", () => {
  it("skipDirectoryRevoke is admin session only", () => {
    const body = { skipDirectoryRevoke: { reason: "directory gone" } };
    expect(PURGE_FIELD_RULES.skipDirectoryRevoke).toEqual({
      admin: "optional",
      token: "forbidden",
      oidc: "forbidden",
      user: "forbidden",
    });
    expect(checkPurgeFields(body, "admin")).toBeNull();
    for (const p of ["token", "oidc", "user"] as const)
      expect(checkPurgeFields(body, p), p).toEqual({
        field: "skipDirectoryRevoke",
        code: "forbidden",
      });
    expect(checkPurgeFields({}, "token")).toBeNull();
  });

  it("a token purging a deleting install gets details.needs admin_session", () => {
    expect(TOKEN_DELETING_PURGE.code).toBe("forbidden");
    expect(
      TOKEN_DELETING_PURGE.details("https://admin.example.com", "iabcdefgh234"),
    ).toEqual({
      needs: "admin_session",
      url: "https://admin.example.com/installs/iabcdefgh234",
    });
  });
});
