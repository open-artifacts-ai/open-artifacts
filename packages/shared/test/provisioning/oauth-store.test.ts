import { describe, expect, it } from "vitest";
import {
  ADMIN_TOOL_NAMES,
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
} from "../../src/provisioning/index.js";

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

  it("reach admins on both envs and no one else", () => {
    for (const r of ["R29", "R30"] as const) {
      for (const env of ["staging", "prod"] as const)
        expect(authorize(r, { kind: "admin" }, env)).toEqual({
          ok: true,
          reach: "all",
        });
      const scopes = [
        "installs:read",
        "installs:write",
        "installs:delete",
      ] as const;
      expect(authorize(r, { kind: "token", scopes }, "prod").ok).toBe(false);
      expect(authorize(r, { kind: "oidc" }, "staging").ok).toBe(false);
      expect(authorize(r, { kind: "test-admin" }, "staging").ok).toBe(false);
      expect(authorize(r, { kind: "user" }, "prod").ok).toBe(false);
      expect(authorize(r, null, "prod").ok).toBe(false);
      expect(AUTHZ[r]["test-admin"].allow).toBe(false);
    }
  });

  it("only an admin moves an active install", () => {
    expect(canTransition("active", "update", "A")).toBe(true);
    for (const a of ["T", "U", "S"] as const)
      expect(canTransition("active", "update", a)).toBe(false);
    for (const s of [
      "suspended",
      "deleting",
      "failed",
      "provisioning",
      "deleted",
    ] as const)
      expect(canTransition(s, "update", "A")).toBe(false);
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
  it("are decided with authz: a tool never fronts a route tokens can't use", () => {
    for (const r of ["R29", "R30"] as const) {
      const tool = ADMIN_TOOLS.find((t) => t.route === r);
      expect(tool !== undefined || r in NO_TOOL, r).toBe(true);
    }
    expect(ADMIN_TOOL_NAMES.length).toBe(ADMIN_TOOLS.length);
  });
});
