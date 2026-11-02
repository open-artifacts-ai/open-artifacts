import { beforeAll, describe, it } from "vitest";
import { adminCreds } from "../src/http.ts";
import { note } from "../src/notes.ts";
import { proof } from "../src/report.ts";
import { snoozeOwnerPath } from "../src/snooze.ts";
import { loadTargets, type Targets } from "../src/targets.ts";

// #1078: the held-sweep snooze owner path (#854, #412) on a live install.
// Target A first; B when A can't run it (not on Google sync, or its owner is
// outside the test domain). Neither: unproven-live with both reasons. The
// case takes its hold off again whatever happens. Listed in
// live/manifest.json.

let T: Targets;

beforeAll(async () => {
  T = await loadTargets();
});

describe("held-sweep snooze", () => {
  it("the org owner snoozes a held sweep (off heldSweeps, snoozedUntil set), cancels it (counts again), both audited", async (ctx) => {
    const why: string[] = [];
    for (const t of [T.a, T.b]) {
      const { pat } = await adminCreds(t);
      const r = await snoozeOwnerPath(t, pat);
      if (r.level === "pass") {
        note(`ran on ${r.target}`);
        return;
      }
      why.push(`${t.name}: ${r.reason}`);
    }
    proof(ctx, "unproven-live", why.join("; "));
  });
});
