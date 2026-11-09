import { describe, expect, it } from "vitest";
import { decide, type Exec, Undecided } from "./release-kind.ts";

const REPO = "open-artifacts-ai/open-artifacts";
const A = "a".repeat(40); // the older commit
const B = "b".repeat(40); // the release commit
const C = "c".repeat(40); // a later commit

type Pr = { merged: boolean; sha: string; labels: string[] };
type World = {
  subject: Record<string, string>;
  pulls: Record<number, Pr>;
  /** What the closed-issues list returns: possibly stale. */
  list: { number: number; merged: boolean }[];
  /** compare status by "from...to" */
  compare?: Record<string, string>;
};

/** A fake `gh api` over a fixed world; logs every path it is asked for. */
function fake(w: World) {
  const calls: string[] = [];
  const exec: Exec = (_cmd, args) => {
    const path = args[1];
    const jq = args[2] === "-q" ? args[3] : undefined;
    calls.push(path);
    const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" });
    let m = /^repos\/[^/]+\/[^/]+\/commits\/(\w+)$/.exec(path);
    if (m) return ok(w.subject[m[1]] ?? "feat: something (#9)");
    m = /\/pulls\/(\d+)$/.exec(path);
    if (m) {
      const pr = w.pulls[Number(m[1])];
      if (!pr) return { code: 1, stdout: "", stderr: "404" };
      if (jq === ".merge_commit_sha") return ok(pr.sha);
      return ok(
        JSON.stringify({
          merged: pr.merged,
          merged_at: pr.merged ? "2026-11-09T03:29:54Z" : null,
          merge_commit_sha: pr.sha,
          labels: pr.labels.map((name) => ({ name })),
        }),
      );
    }
    if (path.includes("/issues?")) {
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
const releaseWorld = (over: Partial<World> = {}): World => ({
  subject: { [B]: "chore(main): release 0.139.0 (#1775)" },
  pulls: { 1775: { merged: true, sha: B, labels: PENDING } },
  list: [], // stale: the just-merged release PR is missing
  ...over,
});

describe("release-kind", () => {
  it("the release commit's own run is a release while the closed-issues list is stale", () => {
    const { exec, calls } = fake(releaseWorld());
    const d = decide(exec, REPO, B);
    expect(d.isRelease).toBe(true);
    // Decided from the commit and its PR, never from a list endpoint.
    expect(calls.some((c) => c.includes("/issues?"))).toBe(false);
    expect(d.log.join("\n")).toContain("pulls/1775: merged=true");
  });

  it("a look-alike subject naming another PR is not a release", () => {
    const w = releaseWorld({
      subject: { [C]: "chore(main): release 0.139.0 (#1775)" },
    });
    const { exec } = fake(w);
    // #1775's merge commit is B, not C; the list is empty: plain commit.
    expect(decide(exec, REPO, C).isRelease).toBe(false);
  });

  it("a look-alike whose PR is not labelled pending is not a release", () => {
    const w = releaseWorld({
      pulls: {
        1775: { merged: true, sha: B, labels: ["autorelease: tagged"] },
      },
    });
    expect(decide(fake(w).exec, REPO, B).isRelease).toBe(false);
  });

  it("a look-alike whose PR is not merged is not a release", () => {
    const w = releaseWorld({
      pulls: { 1775: { merged: false, sha: B, labels: PENDING } },
    });
    expect(decide(fake(w).exec, REPO, B).isRelease).toBe(false);
  });

  it("a non-release commit with no pending release PR is not a release", () => {
    const w = releaseWorld({ subject: { [A]: "feat(x): y (#5)" } });
    expect(decide(fake(w).exec, REPO, A).isRelease).toBe(false);
  });

  it("an older commit leaves a newer release commit to its own run", () => {
    const w = releaseWorld({
      subject: { [A]: "feat(x): y (#5)" },
      list: [{ number: 1775, merged: true }],
      compare: { [`${A}...${B}`]: "ahead" },
    });
    const d = decide(fake(w).exec, REPO, A);
    expect(d.isRelease).toBe(false);
    expect(d.log.join("\n")).toContain("is newer");
  });

  it("two merged pending release PRs fail loudly", () => {
    const w = releaseWorld({
      subject: { [C]: "feat(x): y (#7)" },
      list: [
        { number: 1700, merged: true },
        { number: 1775, merged: true },
      ],
    });
    expect(() => decide(fake(w).exec, REPO, C)).toThrow(Undecided);
    expect(() => decide(fake(w).exec, REPO, C)).toThrow(/more than one/);
  });

  it("a later commit after a missed release fails, saying what happened and what to do", () => {
    const w = releaseWorld({
      subject: { [C]: "feat(x): y (#7)" },
      list: [{ number: 1775, merged: true }],
      compare: { [`${C}...${B}`]: "behind" },
    });
    expect(() => decide(fake(w).exec, REPO, C)).toThrow(
      /its own run did not create the release.*gh run rerun/s,
    );
  });

  it("a full list fails instead of guessing", () => {
    const w = releaseWorld({
      subject: { [C]: "feat(x): y (#7)" },
      list: Array.from({ length: 100 }, (_, i) => ({
        number: i,
        merged: false,
      })),
    });
    expect(() => decide(fake(w).exec, REPO, C)).toThrow(/full/);
  });

  it("a gh failure fails instead of skipping the release", () => {
    const w = releaseWorld({ pulls: {} });
    expect(() => decide(fake(w).exec, REPO, B)).toThrow(Undecided);
  });
});
