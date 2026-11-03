import { describe, expect, it } from "vitest";
import {
  ADMIN_TOOLS,
  AUTHZ,
  authorize,
  canTransition,
  JOB_ERROR_RETRY,
  JOB_STEPS,
  JobKindSchema,
  jobStepsFor,
  NO_TOOL,
  OAuthCopySchema,
  oauthCopyJobArgs,
  oauthJobOf,
  oauthStoreJobArgs,
  parseOAuthJob,
  ROUTES,
  SetOAuthStoreSchema,
} from "../src/index.js";

// #1008 PR1's shared contract. The expected values here are typed out from
// the issue's build requirements, not read from the code under test.

describe("R29 and R30", () => {
  it("route to the update kind on the two paths", () => {
    expect(ROUTES.R29).toMatchObject({
      method: "POST",
      path: "/installs/:id/vars",
      status: 202,
      write: true,
      job: "update",
    });
    expect(ROUTES.R30).toMatchObject({
      method: "POST",
      path: "/installs/:id/oauth-copy",
      status: 202,
      write: true,
      job: "update",
    });
  });

  it("R29 takes OAUTH_STORE alone, one of the three modes", () => {
    const requestId = "a".repeat(16);
    for (const m of ["kv", "dual", "d1"])
      expect(
        SetOAuthStoreSchema.safeParse({
          requestId,
          vars: { OAUTH_STORE: m },
        }).success,
      ).toBe(true);
    for (const vars of [
      {},
      { OAUTH_STORE: "x" },
      { OAUTH_STORE: "dual", TIER: "team" },
      { TIER: "team" },
    ])
      expect(SetOAuthStoreSchema.safeParse({ requestId, vars }).success).toBe(
        false,
      );
    expect(
      SetOAuthStoreSchema.safeParse({
        requestId,
        vars: { OAUTH_STORE: "dual" },
        extra: 1,
      }).success,
    ).toBe(false);
  });

  it("R30 takes a request id and nothing else", () => {
    const requestId = "a".repeat(16);
    expect(OAuthCopySchema.safeParse({ requestId }).success).toBe(true);
    expect(OAuthCopySchema.safeParse({ requestId, cursor: "c" }).success).toBe(
      false,
    );
  });

  describe("reach: an OAuth grant with installs:write, and nothing else", () => {
    const write = ["installs:write"] as const;
    const all = [
      "installs:read",
      "installs:write",
      "installs:delete",
      "installs:pii",
      "audit:read",
    ] as const;
    const forbidden = { ok: false, code: "forbidden" };
    describe.each(["R29", "R30"] as const)("%s", (r) => {
      it.each(["staging", "prod"] as const)("allowed on %s", (env) => {
        expect(
          authorize(
            r,
            { kind: "token", tokenKind: "oauth", scopes: write },
            env,
          ),
        ).toEqual({ ok: true, reach: "all" });
      });
      it.each(["staging", "prod"] as const)("refused on %s", (env) => {
        const refused = [
          { kind: "admin" },
          { kind: "admin", tokenKind: "oauth", scopes: all },
          { kind: "token", tokenKind: "oauth", scopes: [] },
          {
            kind: "token",
            tokenKind: "oauth",
            scopes: all.filter((x) => x !== "installs:write"),
          },
          { kind: "token", tokenKind: "oat", scopes: all },
          { kind: "token", scopes: all },
          { kind: "oidc", tokenKind: "oauth", scopes: all },
          { kind: "test-admin", tokenKind: "oauth", scopes: all },
          { kind: "user", tokenKind: "oauth", scopes: all },
          { kind: "system", tokenKind: "oauth", scopes: all },
        ] as const;
        for (const p of refused)
          expect(authorize(r, p, env).ok, JSON.stringify(p)).toBe(false);
        expect(authorize(r, { kind: "admin" }, env)).toEqual(forbidden);
      });
      it("no credential is 401", () => {
        expect(authorize(r, null, "prod")).toEqual({
          ok: false,
          code: "unauthenticated",
        });
      });
    });
    it("the table shows the rule, and no other route has one", () => {
      const withKind = Object.entries(AUTHZ)
        .filter(([, c]) =>
          Object.values(c).some((x) => x.allow && x.tokenKind !== undefined),
        )
        .map(([id]) => id);
      expect(withKind).toEqual(["R29", "R30"]);
      for (const r of ["R29", "R30"] as const)
        expect(AUTHZ[r].token).toMatchObject({
          allow: true,
          scope: "installs:write",
          tokenKind: "oauth",
        });
    });
  });

  it("only a token actor moves an active install (A is admin and OIDC)", () => {
    expect(canTransition("active", "update", "T")).toBe(true);
    for (const a of ["A", "U", "S"] as const)
      expect(canTransition("active", "update", a)).toBe(false);
    for (const s of [
      "suspended",
      "deleting",
      "failed",
      "provisioning",
      "deleted",
    ] as const)
      expect(canTransition(s, "update", "T")).toBe(false);
  });
});

describe("the update kind's job args", () => {
  it("is a job kind; oauth_copy is its args variant, like redline_creds_revoke", () => {
    expect(JobKindSchema.safeParse("update").success).toBe(true);
    // 0008's CHECK has no oauth_copy, so it is never a jobs.kind.
    expect(JobKindSchema.safeParse("oauth_copy").success).toBe(false);
    expect(jobStepsFor("update", {})).toEqual([
      "recheck",
      "precheck",
      "update_vars",
      "mode_live",
      "done",
    ]);
    expect(jobStepsFor("update", { oauthCopy: true })).toEqual([
      "recheck",
      "precheck",
      "put_key",
      "key_live",
      "copy",
      "drop_key",
      "verify",
      "done",
    ]);
    expect(JOB_STEPS.update).not.toContain("put_key");
  });

  it("round-trips, and refuses anything else", () => {
    expect(
      parseOAuthJob(oauthStoreJobArgs({ vars: { OAUTH_STORE: "d1" } })),
    ).toEqual({ op: "set", mode: "d1" });
    expect(parseOAuthJob(oauthCopyJobArgs())).toEqual({ op: "copy" });
    // Counts land on the copy's args as it finishes; it stays a copy.
    expect(parseOAuthJob({ oauthCopy: true, counts: { copied: 3 } })).toEqual({
      op: "copy",
    });
    expect(oauthJobOf('{"oauthCopy":true}')).toEqual({ op: "copy" });
    expect(oauthJobOf("{}")).toBeNull();
    expect(oauthJobOf("not json")).toBeNull();
    for (const bad of [
      {},
      { vars: {} },
      { vars: { OAUTH_STORE: "x" } },
      { vars: { OAUTH_STORE: "dual", TIER: "team" } },
      { vars: { OAUTH_STORE: "dual" }, oauthCopy: true },
      { oauthCopy: false },
      { oauthCopy: "true" },
    ])
      expect(parseOAuthJob(bad), JSON.stringify(bad)).toBeNull();
  });
});

describe("job codes", () => {
  it("are terminal: a refusal or a left key is never retried", () => {
    for (const c of [
      "mode_not_live",
      "copy_key_left",
      "copy_not_dual",
      "copy_markers",
      "copy_incomplete",
      "copy_key_not_live",
      "leave_d1_refused",
    ])
      expect(JOB_ERROR_RETRY[c as keyof typeof JOB_ERROR_RETRY], c).toBe(
        "terminal",
      );
  });
});

describe("MCP tools", () => {
  const tool = (n: string) => ADMIN_TOOLS.find((t) => t.name === n);

  it("name the two routes, and are the only tools behind an OAuth-only rule", () => {
    expect(tool("set_oauth_store")?.route).toBe("R29");
    expect(tool("copy_oauth_store")?.route).toBe("R30");
    expect(
      ADMIN_TOOLS.filter((t) => {
        const r = AUTHZ[t.route].token;
        return r.allow && r.tokenKind !== undefined;
      }).map((t) => t.name),
    ).toEqual(["set_oauth_store", "copy_oauth_store"]);
    expect(NO_TOOL).not.toHaveProperty("R29");
    expect(NO_TOOL).not.toHaveProperty("R30");
  });

  it("say each needs the user's yes for that install and env", () => {
    for (const n of ["set_oauth_store", "copy_oauth_store"])
      expect(tool(n)?.description).toMatch(
        /explicit yes for this install and this environment/,
      );
  });

  it("are annotated as the other writes are", () => {
    const other = tool("upgrade_install");
    for (const n of ["set_oauth_store", "copy_oauth_store"])
      expect(tool(n)?.annotations).toEqual(other?.annotations);
  });
});
