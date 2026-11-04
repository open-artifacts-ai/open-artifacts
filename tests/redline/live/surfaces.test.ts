import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hook } from "../src/http.ts";
import { crossWrite, prepareSide, type Side } from "../src/refused.ts";
import { proof } from "../src/report.ts";
import {
  carries,
  citationGaps,
  cleanup,
  coverageGaps,
  dispose,
  probeCases,
  probeCred,
  readRepoFile,
  runRead,
  seedWorld,
  settle,
  snapshot,
  sweep,
  type Throwaway,
  throwaway,
  viaTarget,
  type World,
} from "../src/surfaces.ts";
import { loadTargets, type Target, type Targets } from "../src/targets.ts";

// P5 Task 3b: every Backend surface probe (apps/server/test/authz/surfaces.ts)
// on both installs. Read-only probes run on a seeded world (runRead);
// mutating ones through crossWrite on throwaways each install makes for
// itself, deleted even on failure. The world is fixed hook spaces and
// artifacts, reused every run.
// #1137 group B and #1235: each case runs B's own credential at B. A's
// credential at B is the in-server matrix's foreign callers, on every PR;
// A's at A is the same leg on the other install plus the in-server tests in
// A_AT_A. One case per credential kind keeps live A-at-B (SMOKES in
// src/surfaces.ts), with A at A as its positive control; the eleven deny-only
// cases keep their A-at-B leg.
// Surfaces with no possible success leg are dropped through DROPPED (P5
// plan, Task 3b). Each case is listed in live/manifest.json.

let T: Targets;
let A: Side;
let B: Side;
const worlds = new Map<Target, World>();

beforeAll(async () => {
  T = await loadTargets();
  A = await prepareSide(T.a);
  B = await prepareSide(T.b);
  worlds.set(T.a, await seedWorld(A));
  worlds.set(T.b, await seedWorld(B));
});

// Runs even when beforeAll throws partway (vitest runs afterAll then):
// every cleanup is tried, and any unexpected status fails the file.
afterAll(async () => {
  const errors: unknown[] = [];
  for (const s of [A, B]) {
    if (!s) continue;
    await sweep(s).catch((e) => errors.push(e));
    await cleanup(
      s,
      `/api/v1/artifacts/${encodeURIComponent(s.markerId)}`,
    ).catch((e) => errors.push(e));
  }
  if (errors.length) throw errors[0];
});

const world = (t: Target): World => {
  const w = worlds.get(t);
  if (!w) throw new Error(`${t.name}: no probe world`);
  return w;
};
const side = (t: Target): Side => (t === T.a ? A : B);

describe("surface probes (cross-install)", () => {
  it("every ROUTE_POLICY route, MCP tool and content route has a case", () => {
    expect(coverageGaps()).toEqual([]);
    // Every drop's covering tests exist (file, describe and test names).
    expect(citationGaps(readRepoFile)).toEqual([]);
  });

  for (const c of probeCases())
    it(
      c.name,
      async (ctx) => {
        if (c.variant === "oauth") {
          // Local installs serve http, while the provider's /mcp resource is
          // https://<APP_HOST>/mcp: an OAuth bearer at /mcp isn't served over
          // local http (B's own token gets 401), so only staging proves this.
          if (T.mode === "local")
            return proof(
              ctx,
              "staging-only",
              "OAuth bearer at /mcp needs the https resource; local installs serve http",
            );
          // A's access token, minted by A's real OAuth provider (the hook
          // credentials.test.ts uses); only A's credential at B runs.
          await runRead(c, {
            a: T.a,
            b: T.b,
            credA: { token: await oauthToken(T.a) },
            world,
          });
          return;
        }
        const pair = {
          a: T.a,
          b: T.b,
          credA: probeCred(A, c.variant),
          credB: probeCred(B, c.variant),
        };
        if (c.write) {
          const { fresh, run } = c.write;
          await crossWrite(
            (cred, t, x: Throwaway, f) => run(cred, t, x, viaTarget(t, f)),
            {
              ...pair,
              carries,
              ownOnly: c.legs === "own",
              fresh: (t) => throwaway(side(t), world(t), fresh),
              settle: (t, x) => settle(side(t), x),
              snapshot: (t, x) => snapshot(side(t), x),
              dispose: (t, x) => dispose(side(t), x),
            },
          );
          return;
        }
        await runRead(c, { ...pair, world });
      },
      c.timeout,
    );
});

/** An OAuth access token on `t` (the oauth-client hook: its real provider). */
async function oauthToken(t: Target): Promise<string> {
  const r = (await hook(t, "/__test/oauth-client")) as {
    accessToken?: unknown;
  };
  if (typeof r.accessToken !== "string")
    throw new Error(`${t.name} oauth-client hook: no token`);
  return r.accessToken;
}
