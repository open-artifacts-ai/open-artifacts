import { beforeAll, describe, it } from "vitest";
import { PROBE_TIMEOUT_MS, PROBES, type Run } from "../src/provisioning.ts";
import { liveRun, rawTargets } from "../src/provisioning-live.ts";
import { label, proof } from "../src/report.ts";

// The provisioning probes (design v7 12.2) against the staging Provisioning
// API as the GitHub OIDC principal. In order: later probes use what earlier
// ones made (P13's rl-p install, P44's client). Every case is listed in
// live/manifest.json. Local mode has no API: each case is not-applicable.

let run: Run | undefined;
let why: string | undefined;

beforeAll(() => {
  const env = process.env;
  if (!env.REDLINE_RELEASE) {
    why =
      "no REDLINE_RELEASE: the provisioning probes run only in redline-staging";
    return;
  }
  run = liveRun(env, rawTargets(env.REDLINE_TARGETS));
});

describe("provisioning", () => {
  for (const p of PROBES)
    it(
      `${p.id}: ${p.title}`,
      async (ctx) => {
        if (!run) return proof(ctx, "not-applicable", why ?? "not configured");
        const o = await p.run(run);
        if (o.level === "pass") {
          if (o.note) label(ctx, o.note);
          return;
        }
        proof(ctx, o.level, o.reason);
      },
      PROBE_TIMEOUT_MS,
    );
});
