import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { sandbox, script } from "./stubs.ts";

// staging-first-gate.sh: prod's platform-db, provisioner and provisioning
// targets need a green redline-staging.yml dispatch on main for the same tag
// (run-name "redline-staging <tag>"), within 7 days, whose
// redline-staged-version artifact's version.txt is the tag's version. Lookup
// errors fail closed. The clock is pinned (GATE_NOW).
const SCRIPT = script("staging-first-gate.sh");
const REPO = "open-artifacts-ai/open-artifacts";
const NOW = Date.parse("2026-10-31T12:00:00Z") / 1000;
const TAG = "v0.80.0";
const SHA = "c".repeat(40);

/** A one-file zip, stored (what upload-artifact's download holds). */
const zipOf = (name: string, body: string) => {
  const n = Buffer.from(name);
  const d = Buffer.from(body);
  const crc = crc32(d);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(d.length, 18);
  local.writeUInt32LE(d.length, 22);
  local.writeUInt16LE(n.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(d.length, 20);
  central.writeUInt32LE(d.length, 24);
  central.writeUInt16LE(n.length, 28);
  const cdOffset = local.length + n.length + d.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + n.length, 12);
  end.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([local, n, d, central, n, end]);
};

// gh api: the runs listing, a run's artifacts, an artifact's zip.
const gh = `
p="\${@: -1}"; p="\${p#repos/$GITHUB_REPOSITORY/}"
[ -f "$STATE/fail" ] && { echo "HTTP 502" >&2; exit 1; }
case "$p" in
  actions/workflows/redline-staging.yml/runs\\?*) cat "$STATE/runs.json" ;;
  compare/main...*) [ -f "$STATE/fail-compare" ] && exit 1; cat "$STATE/compare.json" ;;
  actions/runs/*/artifacts\\?*) [ -f "$STATE/fail-arts" ] && exit 1; id="\${p#actions/runs/}"; cat "$STATE/arts-\${id%%/*}.json" ;;
  actions/artifacts/*/zip) [ -f "$STATE/fail-zip" ] && exit 1; id="\${p#actions/artifacts/}"; cat "$STATE/zip-\${id%%/*}" ;;
  *) exit 1 ;;
esac`;
const runOf = (over: Record<string, unknown> = {}) => ({
  id: 7,
  html_url: "https://github.com/x/actions/runs/7",
  display_title: `redline-staging ${TAG}`,
  status: "completed",
  conclusion: "success",
  head_branch: "main",
  event: "workflow_dispatch",
  head_repository: { full_name: REPO },
  created_at: "2026-10-30T09:00:00Z",
  head_sha: SHA,
  ...over,
});
type Art = { id: number; name: string; expired: boolean };
const art = (over: Partial<Art> = {}): Art => ({
  id: 70,
  name: "redline-staged-version",
  expired: false,
  ...over,
});
const gate = (
  runs: unknown,
  opts: {
    fail?: "fail" | "fail-arts" | "fail-zip" | "fail-compare";
    /** compare/main...<head_sha>'s status (default behind). */
    compare?: string;
    tag?: string;
    /** run id -> its artifacts (default: run 7's one artifact). */
    arts?: Record<string, Art[] | string>;
    /** artifact id -> zip bytes (default: version.txt "0.80.0\n"). */
    zips?: Record<string, Buffer>;
  } = {},
) => {
  const sb = sandbox({ gh });
  writeFileSync(
    join(sb.dir, "runs.json"),
    typeof runs === "string" ? runs : JSON.stringify({ workflow_runs: runs }),
  );
  for (const [id, a] of Object.entries(opts.arts ?? { "7": [art()] }))
    writeFileSync(
      join(sb.dir, `arts-${id}.json`),
      typeof a === "string" ? a : JSON.stringify({ artifacts: a }),
    );
  for (const [id, z] of Object.entries(
    opts.zips ?? { "70": zipOf("version.txt", "0.80.0\n") },
  ))
    writeFileSync(join(sb.dir, `zip-${id}`), z);
  writeFileSync(
    join(sb.dir, "compare.json"),
    JSON.stringify({ status: opts.compare ?? "behind" }),
  );
  if (opts.fail) writeFileSync(join(sb.dir, opts.fail), "");
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
const NO_RUN = `no successful redline-staging.yml run for ${TAG}`;

describe("staging-first-gate.sh", () => {
  it("passes on a green dispatch of the tag on main this week whose staged version is the tag's", () => {
    const r = gate([runOf()]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toContain(
      `redline-staging.yml passed ${TAG} on version 0.80.0 (run 7)`,
    );
    expect(r.log).toEqual([
      `gh api -X GET repos/${REPO}/actions/workflows/redline-staging.yml/runs?branch=main&status=success&per_page=100&created=%3E%3D2026-10-24T12:00:00Z`,
      `gh api -X GET repos/${REPO}/compare/main...${SHA}`,
      `gh api -X GET repos/${REPO}/actions/runs/7/artifacts?name=redline-staged-version&per_page=100`,
      `gh api repos/${REPO}/actions/artifacts/70/zip`,
    ]);
  });
  it("the run's head_sha must be on main: identical or behind pass; ahead, diverged, an API error or no head_sha refuse", () => {
    for (const compare of ["identical", "behind"]) {
      const r = gate([runOf()], { compare });
      expect(r.code, compare).toBe(0);
    }
    for (const compare of ["ahead", "diverged", ""]) {
      const r = gate([runOf()], { compare });
      expect(r.code, compare).toBe(1);
      expect(r.err).toContain(`run 7's head_sha ${SHA} is not on main`);
      expect(r.log.some((l) => l.includes("/artifacts"))).toBe(false);
    }
    const err = gate([runOf()], { fail: "fail-compare" });
    expect(err.code).toBe(1);
    expect(err.err).toContain("GitHub API error comparing run 7's head_sha");
    for (const head_sha of [null, "", "main"]) {
      const r = gate([runOf({ head_sha })]);
      expect(r.code, String(head_sha)).toBe(1);
      expect(r.err).toContain("run 7 has no head_sha");
      expect(r.log.some((l) => l.includes("/compare/"))).toBe(false);
    }
  });
  it("refuses when there is no run", () => {
    const r = gate([]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(NO_RUN);
  });
  it("refuses a failed run", () => {
    const r = gate([runOf({ conclusion: "failure" })]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(NO_RUN);
  });
  it("refuses a run for another tag", () => {
    const r = gate([runOf({ display_title: "redline-staging v0.79.0" })]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(NO_RUN);
  });
  it("refuses a version mismatch: the run staged another version", () => {
    for (const v of ["0.79.0", "v0.80.0", "0.80.01", ""]) {
      const r = gate([runOf()], { zips: { "70": zipOf("version.txt", v) } });
      expect(r.code, v).toBe(1);
      expect(r.err).toContain(`run 7 staged version '${v}', want '0.80.0'`);
    }
  });
  // One test per case: each is a whole gate run.
  for (const [label, run] of [
    ["longer", runOf({ display_title: "redline-staging v0.80.01" })],
    ["rc", runOf({ display_title: "redline-staging v0.80.0-rc.1" })],
    ["no tag", runOf({ display_title: "redline-staging" })],
    ["not the run-name", runOf({ display_title: `rl (${TAG}) staging` })],
    ["two tags", runOf({ display_title: `redline-staging v0.79.0 ${TAG}` })],
    ["in progress", runOf({ status: "in_progress" })],
    ["branch", runOf({ head_branch: "feature" })],
    ["old", runOf({ created_at: "2026-10-24T11:59:59Z" })],
    ["push", runOf({ event: "push" })],
    ["fork", runOf({ head_repository: { full_name: "evil/open-artifacts" } })],
    ["no repo", runOf({ head_repository: null })],
  ] as const)
    it(`refuses a run that isn't this tag's green dispatch on main this week: ${label}`, () => {
      const r = gate([run]);
      expect(r.code, label).toBe(1);
      expect(r.err, label).toContain(NO_RUN);
    });
  it("checks the newest matching run's artifact", () => {
    const older = runOf({ id: 6, created_at: "2026-10-29T09:00:00Z" });
    const r = gate([runOf(), older], {
      arts: { "6": [art({ id: 60 })], "7": [art()] },
      zips: {
        "60": zipOf("version.txt", "0.80.0"),
        "70": zipOf("version.txt", "0.79.0"),
      },
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain("run 7 staged version '0.79.0'");
  });
  it("refuses a run without exactly one live redline-staged-version artifact, or without version.txt", () => {
    for (const [label, arts] of [
      ["none", []],
      ["expired", [art({ expired: true })]],
      ["another name", [art({ name: "redline-report" })]],
      ["two", [art(), art({ id: 71 })]],
    ] as const) {
      const r = gate([runOf()], { arts: { "7": [...arts] } });
      expect(r.code, label).toBe(1);
      expect(r.err, label).toContain(
        "run 7 has no single redline-staged-version artifact",
      );
    }
    const r = gate([runOf()], {
      zips: { "70": zipOf("other.txt", "0.80.0") },
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain("has no version.txt");
  });
  it("fails closed on an API error or an unparsable answer", () => {
    for (const fail of ["fail", "fail-arts", "fail-zip"] as const)
      expect(gate([runOf()], { fail }).code, fail).toBe(1);
    for (const bad of ["not json", "{}", '{"workflow_runs": 3}']) {
      const r = gate(bad);
      expect(r.code, bad).toBe(1);
    }
    for (const bad of ["not json", "{}", '{"artifacts": [{"id": "x"}]}']) {
      const r = gate([runOf()], { arts: { "7": bad } });
      expect(r.code, bad).toBe(1);
    }
    const r = gate([runOf()], { zips: { "70": Buffer.from("not a zip") } });
    expect(r.code).toBe(1);
  });
  it("refuses a tag that isn't a stable vX.Y.Z before any call", () => {
    for (const t of ["0.80.0", "v0.80.0-rc.1", "main", ""]) {
      const r = gate([runOf()], { tag: t });
      expect(r.code, t).toBe(2);
      expect(r.log).toEqual([]);
    }
  });
});
