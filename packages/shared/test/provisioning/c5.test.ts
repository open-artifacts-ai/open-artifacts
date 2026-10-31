// C5 contract follow-ups for the scheduler (W7): platform_state keys,
// scheduler constants, system jobs, the typed Workflow not-found, and
// zod-free subpath exports.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as ALERTS from "../../src/provisioning/alerts.js";
import { bodyHash, canonicalJson } from "../../src/provisioning/bodyhash.js";
import * as ENUM_VALUES from "../../src/provisioning/enum-values.js";
import {
  ALERT_KEYS,
  EnvSchema,
  HealthSchema,
  InstallStateSchema,
  JobKindSchema,
  JobStatusSchema,
  PrincipalKindSchema,
  ServingModeSchema,
  TokenKindSchema,
  TokenScopeSchema,
} from "../../src/provisioning/enums.js";
import * as ERROR_CODES from "../../src/provisioning/error-codes.js";
import {
  API_ERROR_STATUS,
  ApiErrorCodeSchema,
  JOB_ERROR_RETRY,
  JobErrorCodeSchema,
} from "../../src/provisioning/errors.js";
import { FakeWorkflow } from "../../src/provisioning/fakes.js";
import { REQUEST_ID_RE, ULID_RE } from "../../src/provisioning/ids.js";
import * as INDEX from "../../src/provisioning/index.js";
import {
  ALERT_STATE_SUFFIXES,
  AUDIT_REFUSAL_RETENTION_MS,
  alertStateKey,
  DCR_COUNTER_RETENTION_MS,
  EXPIRED_AUTH_RETENTION_MS,
  HEALTH_GATE_KEY,
  HEALTH_INTERVAL_MS,
  HEALTH_ROUND_KEY,
  JOB_START_GRACE_MS,
  PLATFORM_STATE_0006_KEYS,
  RATE_COUNTER_RETENTION_MS,
  SCHEDULER_STALE_MS,
  SCHEDULER_TICK_KEY,
  SELF_SERVE_STALE_MS,
  SWEEP_CURSOR_KEY,
  SWEEP_TERMINATED_PREFIX,
  sweepTerminatedKey,
} from "../../src/provisioning/state.js";
import {
  cleanupRequestId,
  newJobId,
  PURGE_MAX_TRIES,
  purgeRequestId,
  SYSTEM_ACTOR,
  systemJobBodyHash,
  systemRouteKey,
} from "../../src/provisioning/system.js";
import {
  isWorkflowNotFound,
  WorkflowNotFoundError,
} from "../../src/provisioning/workflow.js";

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

describe("platform_state keys (5.8, 0006)", () => {
  it("the dead-man tick and its 10-min stale threshold", () => {
    expect(SCHEDULER_TICK_KEY).toBe("scheduler_tick_at");
    expect(SCHEDULER_STALE_MS).toBe(10 * MIN);
  });

  it("alert keys: 0006's three suffixes plus W7's sending marker", () => {
    expect([...ALERT_STATE_SUFFIXES]).toEqual([
      "opened_at",
      "notified_at",
      "cleared_at",
      "sending_at",
    ]);
    expect(alertStateKey("job_failed", "opened_at")).toBe(
      "job_failed_opened_at",
    );
    expect(alertStateKey("purge_stuck", "sending_at")).toBe(
      "purge_stuck_sending_at",
    );
    expect(() => alertStateKey("nope" as never, "opened_at")).toThrow(
      /unknown alert key/,
    );
    expect(() => alertStateKey("job_failed", "x" as never)).toThrow(
      /unknown alert state suffix/,
    );
  });

  it("the scheduler's own keys", () => {
    expect(HEALTH_GATE_KEY).toBe("health_checked_at");
    expect(HEALTH_ROUND_KEY).toBe("health_round_at");
    expect(SWEEP_CURSOR_KEY).toBe("sweep_open_cursor");
    expect(SWEEP_TERMINATED_PREFIX).toBe("sweep_terminated:");
    const id = "01JBQ4ZKXW5V9R3M2N8P6T7Y0A";
    expect(sweepTerminatedKey(id)).toBe(`sweep_terminated:${id}`);
    expect(() => sweepTerminatedKey("x")).toThrow(/job id/);
  });

  it("PLATFORM_STATE_0006_KEYS is exactly the key list in 0006's comment", () => {
    const sql = readFileSync(
      resolve(
        SRC,
        "../../../apps/platform-db/migrations/0006_platform_state.sql",
      ),
      "utf8",
    );
    const listed = [...sql.matchAll(/^--\s{3}(\S+)\s{2,}/gm)].map((m) => m[1]);
    expect(listed).toEqual([...PLATFORM_STATE_0006_KEYS]);
  });

  it("every key the scheduler writes is one 0006 lists or a named gap", () => {
    const in0006 = (k: string) =>
      k === SCHEDULER_TICK_KEY ||
      ["opened_at", "notified_at", "cleared_at"].some((s) =>
        ALERT_KEYS.some((a) => k === `${a}_${s}`),
      );
    expect(in0006(SCHEDULER_TICK_KEY)).toBe(true);
    expect(in0006(alertStateKey("job_failed", "cleared_at"))).toBe(true);
    // Not in 0006's list (a migration comment change, outside C5).
    for (const k of [
      alertStateKey("job_failed", "sending_at"),
      HEALTH_GATE_KEY,
      HEALTH_ROUND_KEY,
      SWEEP_CURSOR_KEY,
      sweepTerminatedKey("01JBQ4ZKXW5V9R3M2N8P6T7Y0A"),
    ])
      expect(in0006(k)).toBe(false);
  });
});

describe("scheduler intervals and retention (3.6, 4.9, 5.8)", () => {
  it("are the design's values", () => {
    expect(JOB_START_GRACE_MS).toBe(60_000);
    expect(SELF_SERVE_STALE_MS).toBe(15 * MIN);
    expect(HEALTH_INTERVAL_MS).toBe(60 * MIN);
    expect(AUDIT_REFUSAL_RETENTION_MS).toBe(90 * DAY);
    expect(RATE_COUNTER_RETENTION_MS).toBe(2 * 60 * MIN);
    expect(DCR_COUNTER_RETENTION_MS).toBe(48 * 60 * MIN);
    expect(EXPIRED_AUTH_RETENTION_MS).toBe(7 * DAY);
  });
});

describe("system jobs (3.1, 4.1, 5.8)", () => {
  it("the scheduler's actor is system:scheduler", () => {
    expect(SYSTEM_ACTOR).toEqual({
      kind: "system",
      key: "system:scheduler",
      label: "scheduler",
    });
    expect(PrincipalKindSchema.parse(SYSTEM_ACTOR.kind)).toBe("system");
    expect(Object.isFrozen(SYSTEM_ACTOR)).toBe(true);
  });

  it("newJobId is a ULID whose time part sorts by now", () => {
    const a = newJobId(1_790_000_000_000);
    const b = newJobId(1_790_000_000_001);
    expect(a).toMatch(ULID_RE);
    expect(b).toMatch(ULID_RE);
    expect(a.slice(0, 10) < b.slice(0, 10)).toBe(true);
    // 2^48 - 1 ms is the last ULID time; "7ZZZZZZZZZ".
    expect(newJobId(2 ** 48 - 1).slice(0, 10)).toBe("7ZZZZZZZZZ");
    expect(newJobId(0).slice(0, 10)).toBe("0000000000");
    for (const bad of [-1, 2 ** 48, 1.5, Number.NaN])
      expect(() => newJobId(bad)).toThrow(/ULID time/);
    const many = new Set(Array.from({ length: 200 }, () => newJobId(1)));
    expect(many.size).toBe(200);
  });

  it("purgeRequestId is purge-<id>-<purge_at>-<n>, n the failed purges so far, cap 3", () => {
    expect(PURGE_MAX_TRIES).toBe(3);
    expect(PURGE_MAX_TRIES).toBe(ALERTS.PURGE_STUCK_FAILURES);
    const r = purgeRequestId("iabc123def45", 1_790_000_000_000, 0);
    expect(r).toBe("purge-iabc123def45-1790000000000-0");
    expect(r).toMatch(REQUEST_ID_RE);
    expect(purgeRequestId("iabc123def45", 1, 2)).toBe("purge-iabc123def45-1-2");
    for (const n of [-1, 3, 1.5])
      expect(() => purgeRequestId("iabc123def45", 1, n)).toThrow(/try/);
    expect(() => purgeRequestId("nope", 1, 0)).toThrow(/install id/);
    expect(() => purgeRequestId("iabc123def45", -1, 0)).toThrow(/purge_at/);
  });

  it("cleanupRequestId is cleanup-<parent job id>", () => {
    const id = "01JBQ4ZKXW5V9R3M2N8P6T7Y0A";
    expect(cleanupRequestId(id)).toBe(`cleanup-${id}`);
    expect(cleanupRequestId(id)).toMatch(REQUEST_ID_RE);
    expect(() => cleanupRequestId("x")).toThrow(/job id/);
  });

  it("bodyHash takes a system route key; it never equals an API route's", async () => {
    expect(systemRouteKey("purge")).toBe("system:purge");
    expect(systemRouteKey("cleanup")).toBe("system:cleanup");
    const args = { purgeAt: 1, n: 0 };
    const h = await systemJobBodyHash("purge", "iabc123def45", args);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).toBe(await bodyHash("system:purge", "iabc123def45", args));
    expect(h).not.toBe(await bodyHash("R11", "iabc123def45", args));
    // Same canonical form as a route's: { route, installId, body }.
    const want = new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(
          canonicalJson({
            route: "system:purge",
            installId: "iabc123def45",
            body: args,
          }),
        ),
      ),
    );
    expect(h).toBe(
      Array.from(want, (b) => b.toString(16).padStart(2, "0")).join(""),
    );
    const c = await systemJobBodyHash("cleanup", "iabc123def45", {
      parentJobId: "01JBQ4ZKXW5V9R3M2N8P6T7Y0A",
    });
    expect(c).not.toBe(h);
    await expect(
      systemJobBodyHash("upgrade" as never, "iabc123def45", {} as never),
    ).rejects.toThrow(/system job kind/);
  });
});

describe("WorkflowLike.get not found (C1 fakes)", () => {
  it("the fake throws WorkflowNotFoundError for an unknown id", async () => {
    const wf = new FakeWorkflow();
    const e = await wf.get("01JBQ4ZKXW5V9R3M2N8P6T7Y0A").catch((x) => x);
    expect(e).toBeInstanceOf(WorkflowNotFoundError);
    expect(e.instanceId).toBe("01JBQ4ZKXW5V9R3M2N8P6T7Y0A");
    expect(e.name).toBe("WorkflowNotFoundError");
    expect(isWorkflowNotFound(e)).toBe(true);
    expect(() => wf.setStatus("x", "running")).toThrow(WorkflowNotFoundError);
  });

  it("isWorkflowNotFound is the typed error only, never a message", () => {
    expect(isWorkflowNotFound(new Error("instance.not_found"))).toBe(false);
    expect(isWorkflowNotFound(new Error("instance x not found"))).toBe(false);
    expect(isWorkflowNotFound("instance.not_found")).toBe(false);
    expect(isWorkflowNotFound(null)).toBe(false);
  });
});

describe("zod-free constants modules keep their values", () => {
  it("enum values are the schemas' options", () => {
    const V = ENUM_VALUES;
    expect([...V.INSTALL_STATES]).toEqual(InstallStateSchema.options);
    expect([...V.SERVING_MODES]).toEqual(ServingModeSchema.options);
    expect([...V.HEALTH_VALUES]).toEqual(HealthSchema.options);
    expect([...V.JOB_KINDS]).toEqual(JobKindSchema.options);
    expect([...V.JOB_STATUSES]).toEqual(JobStatusSchema.options);
    expect([...V.TOKEN_SCOPES]).toEqual(TokenScopeSchema.options);
    expect([...V.PRINCIPAL_KINDS]).toEqual(PrincipalKindSchema.options);
    expect([...V.TOKEN_KINDS]).toEqual(TokenKindSchema.options);
    expect([...V.PROVISIONING_ENVS]).toEqual(EnvSchema.options);
    expect(V.ALERT_KEYS).toBe(ALERT_KEYS);
  });

  it("error codes are the schemas' options", () => {
    expect(ERROR_CODES.API_ERROR_STATUS).toBe(API_ERROR_STATUS);
    expect(ERROR_CODES.JOB_ERROR_RETRY).toBe(JOB_ERROR_RETRY);
    expect([...ERROR_CODES.API_ERROR_CODES]).toEqual(
      ApiErrorCodeSchema.options,
    );
    expect([...ERROR_CODES.JOB_ERROR_CODES]).toEqual(
      JobErrorCodeSchema.options,
    );
  });

  it("the index re-exports every new name", () => {
    for (const k of [
      "SCHEDULER_TICK_KEY",
      "SCHEDULER_STALE_MS",
      "alertStateKey",
      "sweepTerminatedKey",
      "JOB_START_GRACE_MS",
      "SYSTEM_ACTOR",
      "newJobId",
      "purgeRequestId",
      "cleanupRequestId",
      "systemJobBodyHash",
      "WorkflowNotFoundError",
      "isWorkflowNotFound",
      "JOB_KINDS",
      "API_ERROR_CODES",
    ])
      expect(INDEX).toHaveProperty(k);
  });
});

// Runtime imports only: `import type` and `export type` lines are erased.
function runtimeImports(file: string): string[] {
  const src = readFileSync(file, "utf8");
  const out: string[] = [];
  const re =
    /^\s*(?:import|export)\s+(?!type\b)(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']/gms;
  for (const m of src.matchAll(re)) out.push(m[1] as string);
  return out;
}

function graph(entry: string): Set<string> {
  const seen = new Set<string>();
  const walk = (f: string) => {
    if (seen.has(f)) return;
    seen.add(f);
    for (const spec of runtimeImports(f)) {
      if (!spec.startsWith(".")) {
        seen.add(spec);
        continue;
      }
      walk(join(dirname(f), spec.replace(/\.js$/, ".ts")));
    }
  };
  walk(entry);
  return seen;
}

const CONST_SUBPATHS = {
  "./provisioning/alerts": "provisioning/alerts.ts",
  "./provisioning/enums": "provisioning/enum-values.ts",
  "./provisioning/errors": "provisioning/error-codes.ts",
  "./provisioning/state": "provisioning/state.ts",
  "./provisioning/system": "provisioning/system.ts",
  "./provisioning/workflow": "provisioning/workflow.ts",
} as const;

describe("narrow subpath exports (no zod)", () => {
  const pkg = JSON.parse(
    readFileSync(resolve(SRC, "../package.json"), "utf8"),
  ) as { exports: Record<string, Record<string, string>> };

  it("each subpath is a package export of its dist module", () => {
    for (const [sub, src] of Object.entries(CONST_SUBPATHS)) {
      const js = `./dist/${src.replace(/\.ts$/, ".js")}`;
      expect(pkg.exports[sub]).toEqual({
        types: js.replace(/\.js$/, ".d.ts"),
        import: js,
        default: js,
      });
    }
  });

  it("no constants module imports zod, directly or through another module", () => {
    for (const src of Object.values(CONST_SUBPATHS)) {
      const deps = graph(join(SRC, src));
      expect([...deps].filter((d) => !d.startsWith("/"))).toEqual([]);
      expect([...deps].some((d) => /zod/.test(d))).toBe(false);
    }
  });

  it("the walker sees zod where it is imported (guard)", () => {
    expect(graph(join(SRC, "provisioning/enums.ts")).has("zod")).toBe(true);
    expect(graph(join(SRC, "provisioning/rpc.ts")).has("zod")).toBe(true);
  });
});
