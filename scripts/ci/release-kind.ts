// Is this push the release commit? (release-please.yml, step `kind`, #1782)
// Usage: node --experimental-strip-types scripts/ci/release-kind.ts --repo owner/name --sha <github.sha>
// Prints `is_release=true|false` on stdout (append it to $GITHUB_OUTPUT); every
// log line goes to stderr. Exit 1 with an ::error:: line when it cannot decide.
// Needs GH_TOKEN (reads only).
//
// Only the release commit's own run creates GitHub releases: the action reads
// main's head, not this run's sha, so any other run creating one could tag a
// commit that is not its own head_sha.
//
// Positive case, from data that cannot lag behind the push: the release
// commit's subject is `chore(main): release X (#N)`. Read pulls/N directly and
// require merged, merge_commit_sha == this sha and the `autorelease: pending`
// label. A list or search endpoint (the closed-issues list) can trail a
// just-merged PR by seconds; run 42556718364 skipped v0.139.0 that way. A
// look-alike (a subject naming some other PR) fails the merge_commit_sha test.
//
// Everything else uses the pending list, which may lag but only in a safe
// direction here: this run's own commit is not a release, so a missing entry
// changes nothing.
//   no merged pending release PR            not a release
//   one, merged after this commit           not a release (its own run is queued)
//   one, merged before this commit          fail: it missed its release (below)
//   more than one                           fail loudly
//
// A missed release is not recovered by a later run. The release gates accept a
// tag only for the commit whose own run created it, and a later run would be
// tagging an older commit from the wrong run. A person re-runs the release
// commit's own run, which now recognises itself (the failure message says how).
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export type ExecResult = { code: number; stdout: string; stderr: string };
export type Exec = (cmd: string, args: string[]) => ExecResult;
export type Decision = { isRelease: boolean; log: string[] };
export type Say = (line: string) => void;

const SUBJECT = /^chore\(main\): release \S+ \(#(\d+)\)$/;
const LABEL = "autorelease: pending";

export class Undecided extends Error {}

function api(exec: Exec, path: string, jq?: string): string {
  const r = exec("gh", ["api", path, ...(jq ? ["-q", jq] : [])]);
  if (r.code !== 0)
    throw new Undecided(
      `could not read ${path}: ${r.stderr.trim() || `exit ${r.code}`}`,
    );
  return r.stdout.trim();
}

export function decide(
  exec: Exec,
  repo: string,
  sha: string,
  out?: Say,
): Decision {
  const log: string[] = [];
  const say = (s: string) => {
    log.push(s);
    out?.(s);
  };
  const subject = api(exec, `repos/${repo}/commits/${sha}`, ".commit.message")
    .split("\n")[0]
    .trim();
  const named = SUBJECT.exec(subject);
  say(`commit ${sha} subject: ${subject}`);
  if (named) {
    const n = named[1];
    const pr = JSON.parse(api(exec, `repos/${repo}/pulls/${n}`));
    const merged = pr.merged === true || Boolean(pr.merged_at);
    const labels: string[] = (pr.labels ?? []).map(
      (l: { name?: string }) => l.name ?? "",
    );
    const own = pr.merge_commit_sha === sha;
    say(
      `pulls/${n}: merged=${merged} merge_commit_sha=${pr.merge_commit_sha} labels=[${labels.join(", ")}]`,
    );
    if (merged && own && labels.includes(LABEL)) {
      say(`decision: release commit (#${n}); this run creates the release`);
      return { isRelease: true, log };
    }
    say(
      `#${n} is not this commit's pending release PR; checking the pending list`,
    );
  } else {
    say("subject is not a release commit's; checking the pending list");
  }
  const issues = JSON.parse(
    api(
      exec,
      `repos/${repo}/issues?state=closed&labels=autorelease:%20pending&per_page=100`,
    ),
  );
  // One page, no pagination: a full page could hide the pending PR.
  if (issues.length >= 100)
    throw new Undecided(
      "pending-label list is full (100); can't decide: see docs/ops/hosted.md, Release recovery, in open-artifacts-cloud",
    );
  const pending: number[] = issues
    .filter((i: { pull_request?: { merged_at?: string | null } }) =>
      Boolean(i.pull_request?.merged_at),
    )
    .map((i: { number: number }) => i.number);
  say(`merged pending release PRs: [${pending.join(", ")}]`);
  if (pending.length === 0) {
    say("decision: not a release commit");
    return { isRelease: false, log };
  }
  if (pending.length > 1)
    throw new Undecided(
      `more than one merged release PR is pending (${pending.join(" ")}): remove "${LABEL}" from the stranded ones: see docs/ops/hosted.md, Release recovery, in open-artifacts-cloud`,
    );
  const n = pending[0];
  const merge = api(exec, `repos/${repo}/pulls/${n}`, ".merge_commit_sha");
  if (!/^[0-9a-f]{40}$/.test(merge))
    throw new Undecided(`could not read #${n}'s merge commit`);
  if (merge === sha) {
    // The list caught up but the subject did not match (an edited squash title).
    say(
      `decision: #${n}'s merge commit is this commit; this run creates the release`,
    );
    return { isRelease: true, log };
  }
  const status = api(
    exec,
    `repos/${repo}/compare/${sha}...${merge}`,
    ".status",
  );
  if (status === "ahead") {
    say(
      `decision: release commit ${merge} (#${n}) is newer; its own run creates the release`,
    );
    return { isRelease: false, log };
  }
  throw new Undecided(
    `release commit ${merge} (#${n}) is merged and still labelled "${LABEL}", so its own run did not create the release, and this run (${sha}) is a different commit and cannot. Re-run the release-please run of commit ${merge} (gh run list --workflow release-please.yml --commit ${merge}, then gh run rerun <id>). If it never ran, remove "${LABEL}" from #${n} and ship a new release (Release-As footer): see docs/ops/hosted.md, Release recovery, in open-artifacts-cloud`,
  );
}

const real: Exec = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return {
    code: r.status ?? 1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
};

function main(argv: string[]): number {
  const get = (f: string) => argv[argv.indexOf(f) + 1];
  const repo = get("--repo");
  const sha = get("--sha");
  if (!repo || !sha) {
    console.error("usage: release-kind.ts --repo owner/name --sha <sha>");
    return 2;
  }
  try {
    const d = decide(real, repo, sha, (l) => console.error(l));
    console.log(`is_release=${d.isRelease}`);
    return 0;
  } catch (e) {
    if (!(e instanceof Undecided)) throw e;
    console.error(`::error::${e.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exit(main(process.argv.slice(2)));
