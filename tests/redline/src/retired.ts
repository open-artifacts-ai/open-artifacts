import { type Citation, resolveCitations } from "./surfaces.ts";

// #1235: live cases taken out of the red-line run, each with the failure it
// was mapped to in the failure model (#1137, artifact hqiYYAsXZiP7Bxeu) and
// the tests that guard that failure instead. A retired case must not come
// back into live/manifest.json unnoticed, and every citation must resolve
// (retiredGaps, run by the fake suite on every PR).

/** A retired live case: its file, full name, the failure, and its replacements. */
export interface Retired {
  file: string;
  /** The full name the reporter gave it ("describe > test"). */
  name: string;
  /** The failure-model id it guarded, or "none". */
  guards: string;
  why: string;
  coveredBy: readonly Citation[];
}

const GUARD = "tests/redline/live/guard.test.ts";
const MATRIX = "apps/server/test/authz.surface-matrix.test.ts";
const HARNESS = "credentials (harness smoke)";

/** The matrix's foreign PAT on every data and storage route, and its proof (#1224). */
const FOREIGN_PAT_ON_DATA: Citation[] = [
  { file: MATRIX, describe: "artifact surfaces (sync stale 8 days)" },
  { file: MATRIX, describe: "refusal mode writes nothing on the world space" },
  {
    file: MATRIX,
    describe: "foreign credentials: another install's, valid there (#1137)",
    test: "each works at A, the install that issued it, as B's owner id; at B it is no one",
  },
];
/** The live PAT checks that stay: A's PAT at B on deployed installs (CRED-2). */
const LIVE_PAT: Citation[] = [
  {
    file: GUARD,
    describe: HARNESS,
    test: "A's admin PAT at B: /api/v1/me",
  },
  {
    file: GUARD,
    describe: HARNESS,
    test: "A's admin PAT at B: the host's own marker artifact",
  },
];
/** The fake that proves a kept crossCheck fails when B accepts A's credential. */
const CROSS_FAILS: Citation = {
  file: "tests/redline/test/harness.test.ts",
  describe: "crossCheck",
  test: "fails when B accepts A's credential",
};

const DATA_WHY =
  "A's PAT reaches the data and storage routes only through enforcePolicy's resolveSession (apps/server/src/runtime/routes.ts: gate needs authzAt), so the route can't change the answer. The matrix runs the foreign PAT on each of them on every PR; the live PAT smokes stay";

const data = (name: string): Retired => ({
  file: "live/live.test.ts",
  name: `data API at B with A's PAT > ${name}`,
  guards: "CRED-2",
  why: DATA_WHY,
  coveredBy: [...FOREIGN_PAT_ON_DATA, ...LIVE_PAT, CROSS_FAILS],
});

export const RETIRED: readonly Retired[] = [
  {
    file: "live/guard.test.ts",
    name: "agent guides > a: /llms.txt is on the app host only; robots.txt opens only the guides",
    guards: "none",
    why: "a product smoke with no isolation failure (failure model group C); the server's own tests pin the same text and statuses",
    coveredBy: [
      {
        file: "apps/server/test/llms.test.ts",
        describe: "GET /llms.txt",
        test: "app host: 200 plain text, cacheable, ETag/304, HEAD",
      },
      {
        file: "apps/server/test/llms.test.ts",
        describe: "GET /llms.txt",
        test: "content host: 404; every other method: 405",
      },
      {
        file: "apps/server/test/skeleton.test.ts",
        describe: "skeleton",
        test: "robots.txt on the app host: only the agent guides are open",
      },
      {
        file: "apps/server/test/skeleton.test.ts",
        describe: "skeleton",
        test: "robots.txt on the content host: everything is disallowed",
      },
    ],
  },
  {
    file: "live/guard.test.ts",
    name: "agent guides > b: /llms.txt is on the app host only; robots.txt opens only the guides",
    guards: "none",
    why: "the same as a: one release, one bundle",
    coveredBy: [
      {
        file: "apps/server/test/llms.test.ts",
        describe: "GET /llms.txt",
        test: "app host: 200 plain text, cacheable, ETag/304, HEAD",
      },
      {
        file: "apps/server/test/skeleton.test.ts",
        describe: "skeleton",
        test: "robots.txt on the content host: everything is disallowed",
      },
    ],
  },
  {
    file: "live/edge.test.ts",
    name: "scheduler > no /__oa/nightly route on either install",
    guards: "none",
    why: "the route was never built; enforcePolicy answers 404 for any route not in ROUTE_POLICY (failure model group C)",
    coveredBy: [
      {
        file: "apps/server/test/fixes.test.ts",
        describe: "app host SPA fallback",
        test: "API paths 404 as JSON, not SPA",
      },
      {
        file: MATRIX,
        describe: "coverage (derived from the router and the registries)",
      },
    ],
  },
  {
    file: "live/credentials.test.ts",
    name: "credentials > A's admin PAT at B: /api/v1/me",
    guards: "CRED-2",
    why: "the same crossCheck on the same request as the harness smoke, which stays",
    coveredBy: [LIVE_PAT[0] as Citation, CROSS_FAILS],
  },
  {
    file: "live/credentials.test.ts",
    name: "credentials > A's session cookie at B: replayed on B's app host",
    guards: "CRED-1",
    why: "the same crossCheck on the same request as the harness smoke, which stays",
    coveredBy: [
      {
        file: GUARD,
        describe: HARNESS,
        test: "A's session cookie at B: /api/v1/me",
      },
      CROSS_FAILS,
    ],
  },
  {
    file: "live/credentials.test.ts",
    name: "credentials > A's admin PAT at B: /api/v1/artifacts",
    guards: "CRED-2",
    why: "A's PAT is refused in resolveSession before the list route runs; the matrix runs the foreign PAT on the list route on every PR, and the live PAT smokes stay",
    coveredBy: [...FOREIGN_PAT_ON_DATA, ...LIVE_PAT, CROSS_FAILS],
  },
  data("GET data/:col/:doc"),
  data("GET data/:col (list)"),
  data("POST data/:col/query"),
  data("PUT data/:col/:doc: refused, and B's doc is unchanged"),
  data("PATCH data/:col/:doc: refused, and B's doc is unchanged"),
  data("DELETE data/:col/:doc: refused, and B's doc is unchanged"),
  data("PUT data (reset): refused, and B's data is unchanged"),
  data("GET storage (list)"),
  data("GET storage/:key"),
  data("PUT storage/:key: refused, and B's key is unchanged"),
  data("DELETE storage/:key: refused, and B's key is unchanged"),
];

/**
 * What's wrong with the retired list: a retired case back in the manifest
 * (by file and name), a duplicate, or a citation that doesn't resolve. Empty
 * when every retired case is out and accounted for.
 */
export function retiredGaps(
  manifest: readonly { file: string; name: string }[],
  read: (repoPath: string) => string | null,
): string[] {
  const key = (x: { file: string; name: string }) => `${x.file} > ${x.name}`;
  const listed = new Set(manifest.map(key));
  const seen = new Set<string>();
  const gaps: string[] = [];
  for (const r of RETIRED) {
    if (listed.has(key(r))) gaps.push(`retired but still required: ${key(r)}`);
    if (seen.has(key(r))) gaps.push(`retired twice: ${key(r)}`);
    seen.add(key(r));
    if (r.guards !== "none" && !/^[A-Z]+-\d+$/.test(r.guards))
      gaps.push(`${key(r)}: guards no failure-model id (${r.guards})`);
  }
  return [
    ...gaps,
    ...resolveCitations(
      RETIRED.map((r) => [key(r), r.coveredBy] as const),
      read,
    ),
  ];
}
