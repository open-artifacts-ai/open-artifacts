import { describe, expect, it } from "vitest";
import {
  AUTHZ,
  AUTHZ_COLUMNS,
  authorize,
  canTransition,
  InstallStateSchema,
  JobKindSchema,
  OIDC_LIMITS,
  oidcMayCreate,
  oidcOwns,
  PROTOCOL_ROUTES,
  ROUTE_IDS,
  ROUTES,
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

  it("limits: rl- slug with testHooks only", () => {
    expect(OIDC_LIMITS).toEqual({
      envs: ["staging"],
      slugPrefix: "rl-",
      testHooks: true,
    });
    expect(oidcMayCreate({ slug: "rl-a", testHooks: true })).toBe(true);
    expect(oidcMayCreate({ slug: "rl-a" })).toBe(false);
    expect(oidcMayCreate({ slug: "acme", testHooks: true })).toBe(false);
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
