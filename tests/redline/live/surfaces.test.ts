import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withCred } from "../src/http.ts";
import { crossProbe, prepareSide, type Side } from "../src/refused.ts";
import { proof } from "../src/report.ts";
import {
  cleanWorld,
  coverageGaps,
  probeCases,
  probeCred,
  seedWorld,
  viaTarget,
  type World,
} from "../src/surfaces.ts";
import { loadTargets, type Target, type Targets } from "../src/targets.ts";

// P5 Task 3b: every Backend surface probe (apps/server/test/authz/surfaces.ts)
// with A's credentials against B's ids, through crossProbe. Read-only probes
// only; the rest report why they can't run, never pass. Each case is listed
// in live/manifest.json.

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

afterAll(async () => {
  for (const s of [A, B]) {
    if (!s) continue;
    const w = worlds.get(s.t);
    if (w) await cleanWorld(s, w);
    await fetch(
      `${s.t.app}/api/v1/artifacts/${encodeURIComponent(s.markerId)}`,
      withCred(s.pat, { method: "DELETE" }),
    ).then((r) => r.body?.cancel());
  }
});

const world = (t: Target): World => {
  const w = worlds.get(t);
  if (!w) throw new Error(`${t.name}: no probe world`);
  return w;
};

describe("surface probes (cross-install)", () => {
  it("every ROUTE_POLICY route, MCP tool and content route has a case", () => {
    expect(coverageGaps()).toEqual([]);
  });

  for (const c of probeCases())
    it(c.name, async (ctx) => {
      if (c.skip) return proof(ctx, c.skip.level, c.skip.reason);
      const { run, variant } = c;
      if (!run || !variant) throw new Error("a runnable case needs run and variant");
      await crossProbe((cred, t, f) => run(cred, t, world(t), viaTarget(t, f)), {
        a: T.a,
        b: T.b,
        credA: probeCred(A, variant),
        credB: probeCred(B, variant),
      });
    });
});
