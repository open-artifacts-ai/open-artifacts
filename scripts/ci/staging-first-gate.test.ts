import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sandbox, script } from "./stubs.ts";

// staging-first-gate.sh: prod's provisioner and provisioning targets need a
// green redline-staging.yml run for the same tag, on main, within 7 days.
// Lookup errors fail closed. The clock is pinned (GATE_NOW).
const SCRIPT = script("staging-first-gate.sh");
const REPO = "open-artifacts-ai/open-artifacts";
const NOW = Date.parse("2026-10-31T12:00:00Z") / 1000;
const TAG = "v0.80.0";

const gh = `
[ -f "$STATE/fail" ] && { echo "HTTP 502" >&2; exit 1; }
cat "$STATE/runs.json"`;
const runOf = (over: Record<string, unknown> = {}) => ({
  id: 7,
  html_url: "https://github.com/x/actions/runs/7",
  display_title: `redline-staging ${TAG}`,
  status: "completed",
  conclusion: "success",
  head_branch: "main",
  created_at: "2026-10-30T09:00:00Z",
  ...over,
});
const gate = (runs: unknown, opts: { fail?: boolean; tag?: string } = {}) => {
  const sb = sandbox({ gh });
  writeFileSync(
    join(sb.dir, "runs.json"),
    typeof runs === "string" ? runs : JSON.stringify({ workflow_runs: runs }),
  );
  if (opts.fail) writeFileSync(join(sb.dir, "fail"), "");
  const r = sb.run(["bash", SCRIPT, opts.tag ?? TAG], {
    env: {
      STATE: sb.dir,
      GH_TOKEN: "t",
      GITHUB_REPOSITORY: REPO,
      GATE_NOW: String(NOW),
    },
  });
  return { ...r, log: sb.log() };
};

describe("staging-first-gate.sh", () => {
  it("passes on a green run for the tag, on main, this week; asks only for runs since 7 days back", () => {
    const r = gate([runOf()]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toContain(`redline-staging.yml passed ${TAG} (run 7)`);
    expect(r.log).toEqual([
      `gh api -X GET repos/${REPO}/actions/workflows/redline-staging.yml/runs?branch=main&status=success&per_page=100&created=%3E%3D2026-10-24T12:00:00Z`,
    ]);
  });
  it("refuses another tag, a near-miss tag, a failed run, another branch or an old run", () => {
    for (const [label, run] of [
      ["other tag", runOf({ display_title: "redline-staging v0.79.0" })],
      ["longer", runOf({ display_title: "redline-staging v0.80.01" })],
      ["rc", runOf({ display_title: "redline-staging v0.80.0-rc.1" })],
      ["no tag", runOf({ display_title: "redline-staging" })],
      ["failed", runOf({ conclusion: "failure" })],
      ["branch", runOf({ head_branch: "feature" })],
      ["old", runOf({ created_at: "2026-10-24T11:59:59Z" })],
    ] as const) {
      const r = gate([run]);
      expect(r.code, label).toBe(1);
      expect(r.err, label).toContain(`no successful redline-staging.yml run for ${TAG}`);
    }
    expect(gate([]).code).toBe(1);
    // The tag anywhere in the name, as a word.
    expect(gate([runOf({ display_title: `rl (${TAG}) staging` })]).code).toBe(0);
  });
  it("fails closed on an API error or an unparsable answer", () => {
    expect(gate([runOf()], { fail: true }).code).toBe(1);
    for (const bad of ["not json", "{}", '{"workflow_runs": 3}']) {
      const r = gate(bad);
      expect(r.code, bad).toBe(1);
    }
  });
  it("refuses a tag that isn't a stable vX.Y.Z before any call", () => {
    for (const t of ["0.80.0", "v0.80.0-rc.1", "main", ""]) {
      const r = gate([runOf()], { tag: t });
      expect(r.code, t).toBe(2);
      expect(r.log).toEqual([]);
    }
  });
});
