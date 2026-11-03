// Which live files may run at the same time (scripts/redline.ts). A file runs
// beside another only when no state or rate-limit bucket it claims could make
// a check pass, or fail, that would not when the files run one at a time.
//
// The plan is a list of phases, run one after another. A phase is a list of
// lanes, run at the same time; a lane is a list of files, run one at a time
// (vitest.live.config.ts keeps fileParallelism off inside each lane).
// test/lanes.test.ts fails when two lanes of one phase claim the same thing.

import type { CaseResult } from "./report.ts";

/**
 * What a file touches. `state` is state another file could change or read:
 * "write" changes it (or reads it exactly, as a before/after snapshot does),
 * "use" only uses it in a way another "use" can't disturb. Two lanes conflict
 * on a state key unless both only "use" it. `bucket` is a rate-limit bucket:
 * any two lanes on one bucket conflict, so each bucket's rate is what the
 * serial run, already proven, spends.
 */
export interface Claims {
  state: Record<string, "write" | "use">;
  buckets: string[];
}

/** Install-plane state: every file that calls loadTargets() holds both installs. */
const installs = (): Claims["state"] => ({
  // The admin test user's artifacts, tokens, spaces, grants and sessions,
  // the hook spaces and members, guests: everything a file seeds or reads.
  "rl-a": "write",
  "rl-b": "write",
  // The admin PAT's lastUsedAt (written at most once a minute per use).
  "rl-a/admin-pat": "use",
  "rl-b/admin-pat": "use",
});

/**
 * The install-plane buckets, from apps/server (namespace ids are account-wide,
 * so a key without the install in it is shared by every staging install):
 * - hooks: RL_ANON test:<install>:<ip>, 30 a minute; the suite paces 25
 *   (src/http.ts), over it a bare 404;
 * - codes: RL_AUTH <install>:<ip>, 20 a minute (one-time code requests);
 * - anon-ip: RL_ANON reg:ip, tok:ip, ip, sub:ip and anonid:ip keys, 30 a
 *   minute each, shared by rl-a and rl-b (no install in the key).
 */
const installBuckets = [
  "rl-a/hooks",
  "rl-b/hooks",
  "rl-a/codes",
  "rl-b/codes",
  "anon-ip",
];

export const CLAIMS: Record<string, Claims> = {
  "live/guard.test.ts": { state: installs(), buckets: installBuckets },
  "live/credentials.test.ts": { state: installs(), buckets: installBuckets },
  "live/live.test.ts": { state: installs(), buckets: installBuckets },
  "live/surfaces.test.ts": { state: installs(), buckets: installBuckets },
  "live/edge.test.ts": {
    state: {
      ...installs(),
      // csrfWrites snapshots GET /api/v1/tokens whole, lastUsedAt included:
      // another lane's use of the admin PAT inside that window changes it.
      "rl-a/admin-pat": "write",
      "rl-b/admin-pat": "write",
    },
    buckets: installBuckets,
  },
  "live/signin.test.ts": {
    state: installs(),
    // brokerState and the tamper case go through the staging auth broker
    // from this runner: RL_BROKER_IP, 60 a minute per IP.
    buckets: [...installBuckets, "broker-ip"],
  },
  "live/provisioning.test.ts": {
    state: {
      // Its own installs (rl-p-<run>, P50's), jobs, clients and audit rows.
      "provisioning-plane": "write",
      // P36 uses the R26 admin PAT on rl-a's /api/v1/me; nothing else of
      // rl-a or rl-b is written (P11/P12 are refusals, the rest reads).
      "rl-a/admin-pat": "use",
    },
    buckets: [
      // P34 spends RL_BROKER_IP past its limit on purpose.
      "broker-ip",
      // RL_PV_* (P25 spends RL_PV_SIGNIN_IP past its limit on purpose).
      "provisioning-api",
    ],
  },
};

export type Lane = readonly string[];
export type Phase = readonly Lane[];

/**
 * The run. Phase 1: signin (the broker) and edge (the token snapshot), with
 * nothing beside them. Phase 2: the other install files, one at a time,
 * beside provisioning, which touches neither install's state.
 */
export const PLAN: readonly Phase[] = [
  [["live/signin.test.ts", "live/edge.test.ts"]],
  [
    [
      "live/credentials.test.ts",
      "live/live.test.ts",
      "live/guard.test.ts",
      "live/surfaces.test.ts",
    ],
    ["live/provisioning.test.ts"],
  ],
];

/** Every claim two lanes of one phase share and may not, as readable lines. */
export function conflicts(
  plan: readonly Phase[] = PLAN,
  claims: Record<string, Claims> = CLAIMS,
): string[] {
  const out: string[] = [];
  const of = (f: string): Claims => {
    const c = claims[f];
    if (!c) throw new Error(`${f}: no claims`);
    return c;
  };
  plan.forEach((phase, p) => {
    for (let i = 0; i < phase.length; i++)
      for (let j = i + 1; j < phase.length; j++)
        for (const x of phase[i] ?? [])
          for (const y of phase[j] ?? []) {
            const cx = of(x);
            const cy = of(y);
            for (const [k, m] of Object.entries(cx.state)) {
              const n = cy.state[k];
              if (n && (m === "write" || n === "write"))
                out.push(`phase ${p + 1}: ${x} and ${y} both hold ${k}`);
            }
            for (const b of cx.buckets)
              if (cy.buckets.includes(b))
                out.push(`phase ${p + 1}: ${x} and ${y} both spend ${b}`);
          }
  });
  return out;
}

/** A lane's name: its first file's base name (for output prefixes and parts). */
export const laneName = (lane: Lane): string =>
  (lane[0] ?? "empty").replace(/^live\//, "").replace(/\.test\.ts$/, "");

/** What one lane's vitest run left: its exit code and its part (null: none). */
export interface LaneResult {
  lane: Lane;
  exit: number;
  part: { cases: CaseResult[]; fileNotes: FileNote[] } | null;
}
type FileNote = { file: string; note: string };

/**
 * The run's cases from every lane. A lane with no part, or with a case from a
 * file outside the lane (it ran where the plan did not put it), adds a fail
 * case, so the gate can't pass on a lane that didn't report or ran wrong.
 * runExit is the first non-zero lane exit.
 */
export function mergeLanes(results: readonly LaneResult[]): {
  cases: CaseResult[];
  fileNotes: FileNote[];
  runExit: number;
} {
  const cases: CaseResult[] = [];
  const fileNotes: FileNote[] = [];
  let runExit = 0;
  for (const r of results) {
    if (r.exit !== 0 && runExit === 0) runExit = r.exit;
    const name = laneName(r.lane);
    if (!r.part) {
      cases.push({
        name: `lane ${name}: no results`,
        level: "fail",
        reason: `the lane's vitest run wrote no part (exit ${r.exit})`,
      });
      continue;
    }
    for (const c of r.part.cases) {
      if (c.file !== undefined && !r.lane.includes(c.file))
        cases.push({
          name: `lane ${name}: ran ${c.file}`,
          level: "fail",
          reason: "a file outside the lane ran in it",
        });
      cases.push(c);
    }
    fileNotes.push(...r.part.fileNotes);
  }
  return { cases, fileNotes, runExit };
}
