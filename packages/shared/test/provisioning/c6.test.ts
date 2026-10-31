// C6 contract follow-ups: R26 revoke, its steps and args, the redline PAT
// scope rule W3 implements, zod-free constants for Backend, and the
// Workflow wrapper's translation (unit; the workerd pin is test-workerd/).
import { describe, expect, it } from "vitest";
import { bodyHash } from "../../src/provisioning/bodyhash.js";
import * as CONSTANTS from "../../src/provisioning/constants.js";
import {
  DCR_COUNTER_PREFIX,
  FAILED_SECRET_RETENTION_MS,
  isTokenStatus,
  LIVE_TOKENS_PER_ADMIN,
  OAUTH_CLIENT_TTL_MS,
  OAUTH_CLIENT_UNCLAIMED_MS,
  parseSignupsEnabled,
  SIGNUPS_ENABLED_VALUES,
  TOKEN_EXPIRING_DAYS,
  ULID_RE,
} from "../../src/provisioning/constants.js";
import { JOB_STEPS, jobStepsFor } from "../../src/provisioning/enum-values.js";
import { REDLINE_SCOPE_FIXTURE } from "../../src/provisioning/fixtures.js";
import * as PATTERNS from "../../src/provisioning/id-patterns.js";
import * as INDEX from "../../src/provisioning/index.js";
import {
  isRedlinePatLabel,
  REDLINE_PAT_PREFIX,
  redlinePatsToRevoke,
} from "../../src/provisioning/redline.js";
import { TokenStatusSchema } from "../../src/provisioning/rpc.js";
import {
  RedlineCredsSchema,
  redlineCredsJobArgs,
} from "../../src/provisioning/schemas.js";
import {
  createWorkflowInstance,
  getWorkflowInstance,
  isWorkflowExists,
  isWorkflowNotFound,
  WorkflowExistsError,
  type WorkflowLike,
  WorkflowNotFoundError,
} from "../../src/provisioning/workflow.js";

const rid = "req_0123456789abcdef";
const key = Buffer.alloc(32, 7).toString("base64url");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe("RedlineCreds: mint or revoke (R26)", () => {
  const ok = (b: unknown) => RedlineCredsSchema.safeParse(b).success;

  it("an absent revoke is a mint, and parses to revoke: false", () => {
    const p = RedlineCredsSchema.parse({ requestId: rid, recipientKey: key });
    expect(p).toEqual({ requestId: rid, recipientKey: key, revoke: false });
  });

  it("revoke: false is a mint", () => {
    expect(
      RedlineCredsSchema.parse({
        requestId: rid,
        revoke: false,
        recipientKey: key,
      }),
    ).toEqual({ requestId: rid, recipientKey: key, revoke: false });
  });

  it("revoke: true needs no key", () => {
    expect(RedlineCredsSchema.parse({ requestId: rid, revoke: true })).toEqual({
      requestId: rid,
      revoke: true,
    });
  });

  it("refuses revoke with a recipientKey, a mint without one, and extras", () => {
    expect(ok({ requestId: rid, revoke: true, recipientKey: key })).toBe(false);
    expect(ok({ requestId: rid })).toBe(false);
    expect(ok({ requestId: rid, revoke: false })).toBe(false);
    expect(ok({ requestId: rid, recipientKey: key, x: 1 })).toBe(false);
    expect(ok({ requestId: rid, revoke: true, x: 1 })).toBe(false);
    expect(ok({ requestId: rid, revoke: "true" })).toBe(false);
    expect(ok({ revoke: true })).toBe(false);
  });

  it("the job args record which variant ran (a mint also its recipientKey)", () => {
    const mint = RedlineCredsSchema.parse({
      requestId: rid,
      recipientKey: key,
    });
    const rev = RedlineCredsSchema.parse({ requestId: rid, revoke: true });
    expect(redlineCredsJobArgs(mint)).toEqual({
      revoke: false,
      recipientKey: key,
    });
    expect(redlineCredsJobArgs(rev)).toEqual({ revoke: true });
  });

  it("the body hash covers revoke: same requestId, mint vs revoke, differs (409)", async () => {
    const inst = "ileoabcdefg2";
    const mint = RedlineCredsSchema.parse({
      requestId: rid,
      recipientKey: key,
    });
    const rev = RedlineCredsSchema.parse({ requestId: rid, revoke: true });
    expect(await bodyHash("R26", inst, mint)).not.toBe(
      await bodyHash("R26", inst, rev),
    );
    // A mint sent with and without revoke: false is one request (a replay).
    const explicit = RedlineCredsSchema.parse({
      requestId: rid,
      revoke: false,
      recipientKey: key,
    });
    expect(await bodyHash("R26", inst, explicit)).toBe(
      await bodyHash("R26", inst, mint),
    );
  });
});

describe("JOB_STEPS for redline_creds", () => {
  it("revoke is its own step list under the one job kind", () => {
    expect([...JOB_STEPS.redline_creds_revoke]).toEqual([
      "recheck",
      "revoke",
      "done",
    ]);
    expect(jobStepsFor("redline_creds", { revoke: true })).toBe(
      JOB_STEPS.redline_creds_revoke,
    );
    for (const args of [{ revoke: false }, {}, undefined, { revoke: "true" }])
      expect(jobStepsFor("redline_creds", args)).toBe(JOB_STEPS.redline_creds);
  });

  it("every other kind ignores revoke", () => {
    expect(jobStepsFor("upgrade", { revoke: true })).toBe(JOB_STEPS.upgrade);
    expect(jobStepsFor("create")).toBe(JOB_STEPS.create);
  });
});

describe("redline PAT scope: only the target install's redline-* PATs (W3 must satisfy)", () => {
  const F = REDLINE_SCOPE_FIXTURE;

  it("the label rule is redline-<run id>", () => {
    expect(REDLINE_PAT_PREFIX).toBe("redline-");
    expect(isRedlinePatLabel("redline-123")).toBe(true);
    for (const l of ["redline-", "Redline-1", "xredline-1", "ss-1", "", null])
      expect(isRedlinePatLabel(l), String(l)).toBe(false);
  });

  it("the fixture has two installs, each with redline and other PATs", () => {
    expect(new Set(F.pats.map((p) => p.installId))).toEqual(
      new Set([F.target, F.other]),
    );
    for (const id of [F.target, F.other]) {
      const mine = F.pats.filter((p) => p.installId === id);
      expect(mine.some((p) => p.label.startsWith("redline-"))).toBe(true);
      expect(mine.some((p) => !p.label.startsWith("redline-"))).toBe(true);
    }
  });

  it("mint revokes the target's older redline-* PATs, never the new one", () => {
    expect(
      redlinePatsToRevoke(F.target, F.pats, { keep: F.minted }).sort(),
    ).toEqual([...F.expect.mint].sort());
  });

  it("revoke revokes every live redline-* PAT of the target only", () => {
    expect(redlinePatsToRevoke(F.target, F.pats).sort()).toEqual(
      [...F.expect.revoke].sort(),
    );
  });

  it("never another install's PAT, nor a non-redline or revoked one", () => {
    for (const opts of [undefined, { keep: F.minted }])
      for (const id of redlinePatsToRevoke(F.target, F.pats, opts)) {
        const p = F.pats.find((x) => x.id === id);
        expect(p?.installId).toBe(F.target);
        expect(p?.label.startsWith("redline-")).toBe(true);
        expect(p?.revokedAt).toBeNull();
      }
  });

  it("a repeat revoke has nothing to revoke: an empty set, so a no-op done", () => {
    const after = F.pats.map((p) =>
      F.expect.revoke.includes(p.id) ? { ...p, revokedAt: 1 } : p,
    );
    expect(redlinePatsToRevoke(F.target, after)).toEqual([]);
  });
});

describe("zod-free constants (Backend minors)", () => {
  it("ULID_RE is the one id-patterns object", () => {
    expect(ULID_RE).toBe(PATTERNS.ULID_RE);
  });

  it("TOKEN_EXPIRING_DAYS is 30 (2.6) and rpc.ts uses the same", () => {
    expect(TOKEN_EXPIRING_DAYS).toBe(30);
    expect(INDEX.TOKEN_EXPIRING_DAYS).toBe(TOKEN_EXPIRING_DAYS);
  });

  it("isTokenStatus agrees with TokenStatusSchema", () => {
    const cases: unknown[] = [
      { status: "active", expiresAt: 1, daysLeft: 31 },
      { status: "expiring", expiresAt: 1, daysLeft: 30 },
      { status: "expiring", expiresAt: 1, daysLeft: 0 },
      { status: "invalid", expiresAt: null, daysLeft: null },
      { status: "invalid", expiresAt: 1, daysLeft: 3 },
      { status: "active", expiresAt: 1, daysLeft: 30 },
      { status: "expiring", expiresAt: 1, daysLeft: 31 },
      { status: "active", expiresAt: null, daysLeft: 40 },
      { status: "active", expiresAt: 1, daysLeft: null },
      { status: "nope", expiresAt: 1, daysLeft: 1 },
      { status: "active", expiresAt: "1", daysLeft: 40 },
      { status: "active", daysLeft: 40 },
      null,
      "active",
      [],
    ];
    for (const c of cases)
      expect(isTokenStatus(c), JSON.stringify(c)).toBe(
        TokenStatusSchema.safeParse(c).success,
      );
  });

  it("a failed signup's secret is kept 30 days (Manager, as #648's owner-email purge)", () => {
    expect(FAILED_SECRET_RETENTION_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it("5 live tokens per admin across both kinds (3.5, 4.1)", () => {
    expect(LIVE_TOKENS_PER_ADMIN).toBe(5);
  });

  it("DCR counters share one prefix", () => {
    expect(DCR_COUNTER_PREFIX).toBe("dcr:");
  });

  it("OAuth clients: unclaimed swept after 24 h, every client expires after 30 days (9A.3, 9A.7)", () => {
    expect(OAUTH_CLIENT_UNCLAIMED_MS).toBe(24 * HOUR);
    expect(OAUTH_CLIENT_TTL_MS).toBe(30 * DAY);
    expect(OAUTH_CLIENT_TTL_MS / 1000).toBe(2_592_000);
  });

  it("SIGNUPS_ENABLED: true, false, test-users; anything else is closed", () => {
    expect([...SIGNUPS_ENABLED_VALUES]).toEqual([
      "false",
      "true",
      "test-users",
    ]);
    expect(parseSignupsEnabled("true")).toBe("true");
    expect(parseSignupsEnabled("false")).toBe("false");
    expect(parseSignupsEnabled("test-users")).toBe("test-users");
    for (const v of [
      undefined,
      null,
      "",
      "TRUE",
      " true",
      "1",
      "yes",
      true,
      "test-user",
    ])
      expect(parseSignupsEnabled(v), String(v)).toBe("false");
  });

  it("the index re-exports the constants", () => {
    for (const k of Object.keys(CONSTANTS)) expect(INDEX, k).toHaveProperty(k);
  });
});

// The wrapper's matching (what the local binding throws is pinned in
// test-workerd/workflow.test.ts against a real binding).
type Fn = () => Promise<unknown>;
const binding = (get: Fn, create: Fn) =>
  ({ get, create }) as unknown as WorkflowLike;
const inst = {
  id: "x",
  status: async () => ({ status: "queued" as const }),
  terminate: async () => {},
};
const remoteErr = (message: string) =>
  Object.assign(new Error(message), { remote: true });

describe("Workflow wrapper (zod-free)", () => {
  it("get: instance.not_found becomes WorkflowNotFoundError", async () => {
    for (const m of [
      "instance.not_found",
      "(instance.not_found) Workflow instance not found",
    ]) {
      const b = binding(
        async () => {
          throw remoteErr(m);
        },
        async () => inst,
      );
      const e = await getWorkflowInstance(b, "abc").catch((x) => x);
      expect(e).toBeInstanceOf(WorkflowNotFoundError);
      expect(isWorkflowNotFound(e)).toBe(true);
      expect((e as WorkflowNotFoundError).instanceId).toBe("abc");
    }
  });

  it("create: instance.already_exists becomes WorkflowExistsError", async () => {
    const b = binding(
      async () => inst,
      async () => {
        throw remoteErr(
          '(instance.already_exists) Workflow instance with id "abc" already exists',
        );
      },
    );
    const e = await createWorkflowInstance(b, {
      id: "abc",
      params: { jobId: "01JD7Z9W5Q8X3N4M2K1H0G9F8E" },
    }).catch((x) => x);
    expect(e).toBeInstanceOf(WorkflowExistsError);
    expect(isWorkflowExists(e)).toBe(true);
    expect(isWorkflowNotFound(e)).toBe(false);
    expect((e as WorkflowExistsError).instanceId).toBe("abc");
  });

  it("passes success through", async () => {
    const b = binding(
      async () => inst,
      async () => inst,
    );
    expect(await getWorkflowInstance(b, "x")).toBe(inst);
    expect(
      await createWorkflowInstance(b, {
        id: "x",
        params: { jobId: "01JD7Z9W5Q8X3N4M2K1H0G9F8E" },
      }),
    ).toBe(inst);
  });

  it("rethrows everything else unchanged", async () => {
    const others: unknown[] = [
      remoteErr("Workflow instance has invalid id"),
      remoteErr("instance.not_found_soon"),
      remoteErr("something instance.not_found"),
      remoteErr("(instance.already_exists)x"),
      new TypeError("binding missing"),
      "instance.not_found",
      null,
    ];
    for (const thrown of others) {
      const b = binding(
        async () => {
          throw thrown;
        },
        async () => {
          throw thrown;
        },
      );
      expect(await getWorkflowInstance(b, "x").catch((x) => x)).toBe(thrown);
      expect(
        await createWorkflowInstance(b, {
          id: "x",
          params: { jobId: "01JD7Z9W5Q8X3N4M2K1H0G9F8E" },
        }).catch((x) => x),
      ).toBe(thrown);
    }
    // A not-found on create, or an exists on get, is not translated.
    const nf = remoteErr("instance.not_found");
    const ex = remoteErr("(instance.already_exists) x");
    const b = binding(
      async () => {
        throw ex;
      },
      async () => {
        throw nf;
      },
    );
    expect(await getWorkflowInstance(b, "x").catch((x) => x)).toBe(ex);
    expect(
      await createWorkflowInstance(b, {
        id: "x",
        params: { jobId: "01JD7Z9W5Q8X3N4M2K1H0G9F8E" },
      }).catch((x) => x),
    ).toBe(nf);
  });
});
