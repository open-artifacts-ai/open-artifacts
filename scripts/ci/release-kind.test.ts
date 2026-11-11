import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BACKOFF_MS,
  decide,
  type Exec,
  RETRY_MS,
  TOTAL_WAIT_CAP_MS,
  Undecided,
} from "./release-kind.ts";

const REPO = "open-artifacts-ai/open-artifacts";
const A = "a".repeat(40); // an older commit
const B = "b".repeat(40); // the release commit
const C = "c".repeat(40); // a later commit
const LIST_URL = `repos/${REPO}/issues?state=closed&labels=autorelease:%20pending&per_page=100`;
const NO_OWN_RUN =
  /is merged and still labelled "autorelease: pending".*its own run did not create the release.*gh run rerun/s;

type Pr = { merged: boolean; sha: string | null; labels: string[] };
type World = {
  subject: Record<string, string>;
  pulls: Record<number, Pr>;
  /** What the closed-issues list returns: possibly stale. */
  list: { number: number; merged: boolean }[];
  /** Successive reads of pulls/1775, the last repeated: a lagging read first. */
  seq?: Pr[];
  /** compare status by "from...to" */
  compare?: Record<string, string>;
  /** A path matching this fails this many times (default forever). */
  fail?: { match: RegExp; times?: number };
  /** A path matching this answers this text instead. */
  raw?: { match: RegExp; text: string };
};

/** A fake `gh api` over a fixed world; logs every path it is asked for. */
function fake(w: World) {
  const calls: string[] = [];
  let reads = 0;
  let failed = 0;
  const exec: Exec = (_cmd, args) => {
    const path = args[1];
    calls.push(path);
    const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" });
    if (w.fail?.match.test(path) && failed < (w.fail.times ?? Infinity)) {
      failed++;
      return { code: 1, stdout: "", stderr: "HTTP 502" };
    }
    if (w.raw?.match.test(path)) return ok(w.raw.text);
    let m = /^repos\/[^/]+\/[^/]+\/commits\/(\w+)$/.exec(path);
    if (m) return ok(w.subject[m[1]] ?? "feat: something (#9)");
    m = /\/pulls\/(\d+)$/.exec(path);
    if (m) {
      const pr =
        w.seq && m[1] === "1775"
          ? (w.seq[Math.min(reads++, w.seq.length - 1)] as Pr)
          : w.pulls[Number(m[1])];
      if (!pr) return { code: 1, stdout: "", stderr: "404" };
      return ok(
        JSON.stringify({
          merged: pr.merged,
          merged_at: pr.merged ? "2026-11-09T03:29:54Z" : null,
          merge_commit_sha: pr.sha,
          labels: pr.labels.map((name) => ({ name })),
        }),
      );
    }
    if (path === LIST_URL) {
      return ok(
        JSON.stringify(
          w.list.map((i) => ({
            number: i.number,
            pull_request: {
              merged_at: i.merged ? "2026-11-09T03:29:54Z" : null,
            },
          })),
        ),
      );
    }
    m = /\/compare\/(\w+)\.\.\.(\w+)$/.exec(path);
    if (m) return ok(w.compare?.[`${m[1]}...${m[2]}`] ?? "diverged");
    return { code: 1, stdout: "", stderr: `unexpected ${path}` };
  };
  return { exec, calls };
}

const PENDING = ["autorelease: pending"];
const noWait = () => {};
const run = (w: World, sha: string) => {
  const waits: number[] = [];
  const f = fake(w);
  const go = () => decide(f.exec, REPO, sha, undefined, (ms) => waits.push(ms));
  return { go, waits, calls: f.calls };
};
const releaseWorld = (over: Partial<World> = {}): World => ({
  subject: { [B]: "chore(main): release 0.139.0 (#1775)" },
  pulls: { 1775: { merged: true, sha: B, labels: PENDING } },
  list: [], // stale: the just-merged release PR is missing
  ...over,
});
const plain = (over: Partial<World> = {}): World =>
  releaseWorld({ subject: { [C]: "feat(x): y (#7)" }, ...over });
const fails = (w: World, sha: string, re: RegExp) => {
  const r = run(w, sha);
  expect(r.go).toThrow(Undecided);
  expect(r.go).toThrow(re);
};

describe("release-kind: the release commit's own run", () => {
  it("is a release while the closed-issues list is stale", () => {
    const r = run(releaseWorld(), B);
    const d = r.go();
    expect(d.isRelease).toBe(true);
    expect(d.log.join("\n")).toContain("pulls/1775: merged=true");
    expect(r.calls[1]).toBe(`repos/${REPO}/pulls/1775`);
  });

  it("reads the list with the pending label filter, one page of 100", () => {
    const r = run(releaseWorld(), B);
    r.go();
    expect(r.calls).toContain(
      `repos/${REPO}/issues?state=closed&labels=autorelease:%20pending&per_page=100`,
    );
  });

  it("is a release when the list shows only itself", () => {
    const w = releaseWorld({ list: [{ number: 1775, merged: true }] });
    expect(run(w, B).go().isRelease).toBe(true);
  });

  it("a lagging read of the PR, then confirmed, is a release", () => {
    const w = releaseWorld({
      seq: [
        { merged: false, sha: C, labels: PENDING },
        { merged: false, sha: C, labels: PENDING },
        { merged: true, sha: B, labels: PENDING },
      ],
    });
    const r = run(w, B);
    expect(r.go().isRelease).toBe(true);
    expect(r.waits).toEqual(BACKOFF_MS.slice(0, 2));
  });

  it("a PR still unconfirmed after every retry fails naming it, never skips", () => {
    const w = releaseWorld({
      seq: [{ merged: false, sha: C, labels: PENDING }],
    });
    const r = run(w, B);
    expect(r.go).toThrow(/#1775.*merged=false.*merge_commit_sha=c{40}/);
    expect(r.waits).toEqual(BACKOFF_MS);
    expect(r.waits.reduce((a, b) => a + b, 0)).toBeLessThan(30_000);
  });

  it("fails when another merged release PR is pending too (F2)", () => {
    const w = releaseWorld({
      list: [
        { number: 1700, merged: true },
        { number: 1775, merged: true },
      ],
    });
    fails(w, B, /more than one merged release PR is pending \(1775 1700\)/);
  });

  it("fails on a full list even on the positive path", () => {
    const list = Array.from({ length: 100 }, (_, i) => ({
      number: i,
      merged: false,
    }));
    fails(releaseWorld({ list }), B, /full \(100\)/);
  });
});

describe("release-kind: look-alikes and other commits", () => {
  it("a look-alike naming a pending PR merged as another commit fails, never skips", () => {
    const w = releaseWorld({
      subject: { [C]: "chore(main): release 0.139.0 (#1775)" },
    });
    fails(w, C, /#1775.*merge_commit_sha=b{40}/);
  });

  it("a look-alike whose PR is not labelled pending is not a release", () => {
    const w = releaseWorld({
      pulls: {
        1775: { merged: true, sha: B, labels: ["autorelease: tagged"] },
      },
    });
    expect(run(w, B).go().isRelease).toBe(false);
  });

  it("a non-release commit with no pending release PR is not a release", () => {
    expect(run(plain(), C).go().isRelease).toBe(false);
  });

  it("a closed, unmerged pending PR is ignored (merged_at filter)", () => {
    const w = plain({ list: [{ number: 1700, merged: false }] });
    const r = run(w, C);
    expect(r.go().isRelease).toBe(false);
    // Ignored in the list, so no pulls/N read follows.
    expect(r.calls.some((c) => c.includes("/pulls/"))).toBe(false);
  });

  it("two merged pending release PRs fail", () => {
    const w = plain({
      list: [
        { number: 1700, merged: true },
        { number: 1775, merged: true },
      ],
    });
    fails(w, C, /more than one merged release PR is pending \(1700 1775\)/);
  });

  it("the list's one merged pending PR with this commit as its merge commit is a release", () => {
    const w = plain({
      list: [{ number: 1775, merged: true }],
      pulls: { 1775: { merged: true, sha: C, labels: PENDING } },
    });
    const d = run(w, C).go();
    expect(d.isRelease).toBe(true);
    expect(d.log.join("\n")).toContain("merge commit is this commit");
  });
});

describe("release-kind: a newer or a missed release commit", () => {
  const w = (status?: string) =>
    plain({
      list: [{ number: 1775, merged: true }],
      compare: status === undefined ? {} : { [`${C}...${B}`]: status },
    });
  it("a newer release commit is left to its own run (ahead)", () => {
    const d = run(w("ahead"), C).go();
    expect(d.isRelease).toBe(false);
    expect(d.log.join("\n")).toContain("is newer");
  });
  it.each(["behind", "diverged", "identical", ""])(
    "a pending release PR merged before this commit (compare: %j) fails, saying what to do",
    (status) => {
      const world = w(status);
      world.raw = { match: /\/compare\//, text: status };
      fails(world, C, NO_OWN_RUN);
    },
  );
  it("a PR that is in the list but already tagged is not a release (F4)", () => {
    const world = plain({
      list: [{ number: 1775, merged: true }],
      pulls: {
        1775: { merged: true, sha: B, labels: ["autorelease: tagged"] },
      },
    });
    const d = run(world, C).go();
    expect(d.isRelease).toBe(false);
    expect(d.log.join("\n")).toContain("already tagged");
  });
});

describe("release-kind: bad answers fail closed", () => {
  const listed = (sha: string | null) =>
    plain({
      list: [{ number: 1775, merged: true }],
      pulls: { 1775: { merged: true, sha, labels: PENDING } },
    });
  it.each([null, "null", "", "XYZ", "a".repeat(39)])(
    "a merge commit of %j is refused",
    (sha) => {
      fails(listed(sha), C, /could not read #1775's merge commit/);
    },
  );
  it("a full list of 100 fails, 99 does not", () => {
    const filler = (k: number) =>
      Array.from({ length: k }, (_, i) => ({
        number: 2000 + i,
        merged: false,
      }));
    const at = (k: number) =>
      plain({ list: [{ number: 1775, merged: true }, ...filler(k - 1)] });
    fails(at(100), C, /full \(100\)/);
    const w99 = at(99);
    w99.pulls = { 1775: { merged: true, sha: C, labels: PENDING } };
    expect(run(w99, C).go().isRelease).toBe(true);
  });
  it.each([
    ["the list", LIST_URL, plain()],
    [
      "the compare",
      "/compare/",
      plain({ list: [{ number: 1775, merged: true }] }),
    ],
    [
      "the list path's PR read",
      "/pulls/1775",
      plain({ list: [{ number: 1775, merged: true }] }),
    ],
    ["the commit", "/commits/", plain()],
  ] as const)(
    "a gh failure on %s fails after the retries",
    (_n, frag, world) => {
      const w = { ...world, fail: { match: new RegExp(reEscape(frag)) } };
      const r = run(w, C);
      expect(r.go).toThrow(/could not read .* after 4 tries: HTTP 502/);
      expect(r.waits).toEqual(RETRY_MS);
    },
  );
  it("one bad gateway is retried and the run goes on", () => {
    const w = {
      ...plain(),
      fail: { match: /\/commits\//, times: 1 },
    };
    const r = run(w, C);
    expect(r.go().isRelease).toBe(false);
    expect(r.waits).toEqual([RETRY_MS[0]]);
  });
  it("non-JSON from the list or a PR read fails", () => {
    fails(
      { ...plain(), raw: { match: /\/issues\?/, text: "not json" } },
      C,
      /could not parse/,
    );
    fails(
      { ...releaseWorld(), raw: { match: /\/pulls\//, text: "<html>" } },
      B,
      /could not parse/,
    );
  });
  it("a run never waits more than the cap in all", () => {
    const w = releaseWorld({
      seq: [
        ...Array.from({ length: 5 }, () => ({
          merged: false,
          sha: C,
          labels: PENDING,
        })),
        { merged: true, sha: B, labels: PENDING },
      ],
      fail: { match: /\/issues\?/ },
    });
    const r = run(w, B);
    expect(r.go).toThrow(Undecided);
    const total = r.waits.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(BACKOFF_MS.reduce((a, b) => a + b, 0));
    expect(total).toBeLessThanOrEqual(TOTAL_WAIT_CAP_MS);
  });
});

function reEscape(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The real command line, on a stub gh that serves fixture files. */
describe("release-kind: the command line", () => {
  const script = join(
    dirname(fileURLToPath(import.meta.url)),
    "release-kind.ts",
  );
  const STUB = `#!/usr/bin/env bash
[ "$1" = api ] || exit 2
path=$2; q=
if [ "$3" = -q ]; then q=$4; fi
f="$FIX/$(printf '%s' "$path" | tr '/?&=:%' '______')"
[ -f "$f" ] || exit 3
if [ -n "$q" ]; then jq -r "$q" < "$f"; else cat "$f"; fi
`;
  const key = (p: string) => p.replace(/[/?&=:%]/g, "_");
  function cli(files: Record<string, unknown>, args?: string[]) {
    const dir = mkdtempSync(join(tmpdir(), "rk-"));
    const fix = join(dir, "fix");
    const bin = join(dir, "bin");
    mkdirSync(fix);
    mkdirSync(bin);
    writeFileSync(join(bin, "gh"), STUB, { mode: 0o755 });
    for (const [p, v] of Object.entries(files))
      writeFileSync(join(fix, key(p)), JSON.stringify(v));
    const r = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--no-warnings",
        script,
        ...(args ?? ["--repo", REPO, "--sha", B]),
      ],
      {
        encoding: "utf8",
        env: { PATH: `${bin}:${process.env.PATH}`, FIX: fix },
      },
    );
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  }
  const base = (labels: string[], list: unknown[] = []) => ({
    [`repos/${REPO}/commits/${B}`]: {
      commit: { message: "chore(main): release 0.139.0 (#1775)\n\nbody" },
    },
    [`repos/${REPO}/pulls/1775`]: {
      merged: true,
      merge_commit_sha: B,
      labels: labels.map((name) => ({ name })),
    },
    [LIST_URL]: list,
  });

  it("prints is_release=true for the release commit and exits 0", () => {
    const r = cli(base(PENDING));
    expect(r.stdout).toBe("is_release=true\n");
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("decision: release commit (#1775)");
  });
  it("prints is_release=false for an already tagged one and exits 0", () => {
    const r = cli(base(["autorelease: tagged"]));
    expect(r.stdout).toBe("is_release=false\n");
    expect(r.code).toBe(0);
  });
  it("prints nothing on stdout and exits 1 with ::error:: when it cannot decide", () => {
    const r = cli(
      base(PENDING, [
        { number: 1700, pull_request: { merged_at: "x" } },
        { number: 1775, pull_request: { merged_at: "x" } },
      ]),
    );
    expect(r.stdout).toBe("");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("::error::more than one merged release PR");
  });
  it("prints nothing and exits 1 when gh keeps failing", () => {
    const r = cli({});
    expect(r.stdout).toBe("");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("::error::could not read");
  });
  it("exits 2 without its arguments", () => {
    const r = cli({}, []);
    expect(r.stdout).toBe("");
    expect(r.code).toBe(2);
  });
});
