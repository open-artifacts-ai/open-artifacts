import { afterAll, beforeAll, describe, it } from "vitest";
import {
  CLEANUP_TIMEOUT_MS,
  caseTimeoutMs,
  cleanupInstalls,
  type Outcome,
  PROBES,
  type Run,
  settledTimeoutMs,
  startChains,
} from "../src/provisioning.ts";
import { liveRun, rawTargets } from "../src/provisioning-live.ts";
import { label, proof } from "../src/report.ts";

// The provisioning probes (design v7 12.2) against the staging Provisioning
// API as the GitHub OIDC principal. The probes run as chains, all at once
// (src/provisioning.ts CHAINS): rl-p's create, upgrade, rollback and purge;
// rl-l's suspend, resume and restore; the API checks. Inside a
// chain, later probes use what earlier ones made. Each case awaits its own
// probe; every case is listed in live/manifest.json. Local mode has no API:
// each case is not-applicable.

let run: Run | undefined;
let why: string | undefined;
let plan: ReturnType<typeof startChains> | undefined;

beforeAll(() => {
  const env = process.env;
  if (!env.REDLINE_RELEASE) {
    why =
      "no REDLINE_RELEASE: the provisioning probes run only in redline-staging";
    return;
  }
  run = liveRun(env, rawTargets(env.REDLINE_TARGETS));
  plan = startChains(run);
});

// Once every chain is done (so it never races one): whatever a probe created
// and didn't remove, e.g. rl-p after a failed P13 blocks P23.
afterAll(async () => {
  if (plan) await plan.settled;
  if (run) await cleanupInstalls(run);
}, CLEANUP_TIMEOUT_MS + settledTimeoutMs());

describe("provisioning", () => {
  for (const p of PROBES)
    it(
      `${p.id}: ${p.title}`,
      async (ctx) => {
        if (!run || !plan)
          return proof(ctx, "not-applicable", why ?? "not configured");
        const o: Outcome = await (plan.outcomes.get(p.id) ??
          Promise.reject(new Error(`${p.id} is in no chain`)));
        if (o.level === "pass") {
          if (o.note) label(ctx, o.note);
          return;
        }
        proof(ctx, o.level, o.reason);
      },
      caseTimeoutMs(p.id),
    );
});
