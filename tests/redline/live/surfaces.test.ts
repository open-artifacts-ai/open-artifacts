import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  crossProbe,
  crossWrite,
  prepareSide,
  type Side,
} from "../src/refused.ts";
import {
  carries,
  citationGaps,
  cleanup,
  coverageGaps,
  dispose,
  probeCases,
  probeCred,
  readRepoFile,
  seedWorld,
  snapshot,
  sweep,
  type Throwaway,
  throwaway,
  viaTarget,
  type World,
} from "../src/surfaces.ts";
import { loadTargets, type Target, type Targets } from "../src/targets.ts";

// P5 Task 3b: every Backend surface probe (apps/server/test/authz/surfaces.ts)
// with A's credentials against B's ids. Read-only probes go through
// crossProbe on a seeded world; mutating ones through crossWrite on
// throwaways each install makes for itself, deleted even on failure. The
// world is fixed hook spaces and artifacts, reused every run.
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
    it(c.name, async () => {
      const pair = {
        a: T.a,
        b: T.b,
        credA: probeCred(A, c.variant),
        credB: probeCred(B, c.variant),
        carries,
      };
      if (c.write) {
        const { fresh, run } = c.write;
        await crossWrite(
          (cred, t, x: Throwaway, f) => run(cred, t, x, viaTarget(t, f)),
          {
            ...pair,
            fresh: (t) => throwaway(side(t), world(t), fresh),
            snapshot: (t, x) => snapshot(side(t), x),
            dispose: (t, x) => dispose(side(t), x),
          },
        );
        return;
      }
      const { run } = c;
      if (!run) throw new Error("a case needs run or write");
      await crossProbe(
        (cred, t, f) => run(cred, t, world(t), viaTarget(t, f)),
        pair,
      );
    });
});
