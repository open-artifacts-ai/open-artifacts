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
// Positive case, read directly from the PR, not from a list: the release
// commit's subject is `chore(main): release X (#N)`. Read pulls/N directly and
// require merged, merge_commit_sha == this sha and the `autorelease: pending`
// label. A list or search endpoint (the closed-issues list) can trail a
// just-merged PR by seconds; run 42556718364 skipped v0.139.0 that way. A
// look-alike (a subject naming some other PR) fails the merge_commit_sha test.
// A direct read can lag too: a subject naming a PR labelled pending that does
// not yet show as merged as this sha is re-read with a backoff (BACKOFF_MS),
// then fails loudly. It never falls through to "not a release", so the lag
// that caused #1782 cannot skip a release silently. A named PR without the
// label (tagged already, or a look-alike) goes to the list below.
//
// On the positive path the list is read too: any other merged pending PR
// fails loudly, because release-please would tag it at its own sha. Each gh
// read is tried again with a short backoff (RETRY_MS); a run never waits more
// than TOTAL_WAIT_CAP_MS in all.
//
// Everything else uses the pending list, which may lag but only in a safe
// direction here: this run's own commit is not a release, so a missing entry
// changes nothing.
//   no merged pending release PR            not a release
//   one, merged after this commit           not a release (its own run is queued)
//   one, no longer labelled pending         not a release (tagged; the list lags)
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

/** Waits between re-reads of an unconfirmed pending PR: 25 s in all. */
export const BACKOFF_MS = [1000, 2000, 4000, 8000, 10000];
/** Waits between tries of one failed gh call: 7 s in all. */
export const RETRY_MS = [1000, 2000, 4000];
/** No run waits longer than this in all, across every call and re-read. */
export const TOTAL_WAIT_CAP_MS = 30_000;
const sleep = (ms: number) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export class Undecided extends Error {}

type Ctx = {
  exec: Exec;
  wait: (ms: number) => void;
  spent: number;
};

/** Waits ms if the run's total wait stays under the cap; false if it would not. */
function pause(c: Ctx, ms: number): boolean {
  if (c.spent + ms > TOTAL_WAIT_CAP_MS) return false;
  c.spent += ms;
  c.wait(ms);
  return true;
}

/** One gh api read; a failure (a 502, a timeout) is tried again with a short backoff. */
function api(c: Ctx, path: string, jq?: string): string {
  for (let i = 0; ; i++) {
    const r = c.exec("gh", ["api", path, ...(jq ? ["-q", jq] : [])]);
    if (r.code === 0) return r.stdout.trim();
    if (i >= RETRY_MS.length || !pause(c, RETRY_MS[i]))
      throw new Undecided(
        `could not read ${path} after ${i + 1} tries: ${r.stderr.trim() || `exit ${r.code}`}`,
      );
  }
}

function json(path: string, text: string) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Undecided(`could not parse the answer for ${path}`);
  }
}

const labelsOf = (pr: { labels?: { name?: string }[] }): string[] =>
  (pr.labels ?? []).map((l) => l.name ?? "");

export function decide(
  exec: Exec,
  repo: string,
  sha: string,
  out?: Say,
  wait: (ms: number) => void = sleep,
): Decision {
  const c: Ctx = { exec, wait, spent: 0 };
  const log: string[] = [];
  const say = (s: string) => {
    log.push(s);
    out?.(s);
  };
  const subject = api(c, `repos/${repo}/commits/${sha}`, ".commit.message")
    .split("\n")[0]
    .trim();
  const named = SUBJECT.exec(subject);
  say(`commit ${sha} subject: ${subject}`);
  // The number of this commit's own release PR, once pulls/N confirms it.
  let own: number | undefined;
  if (named) {
    const n = named[1];
    let tries = 0;
    for (;;) {
      const path = `repos/${repo}/pulls/${n}`;
      const pr = json(path, api(c, path));
      const merged = pr.merged === true || Boolean(pr.merged_at);
      const labels = labelsOf(pr);
      say(
        `pulls/${n}: merged=${merged} merge_commit_sha=${pr.merge_commit_sha} labels=[${labels.join(", ")}] (read ${tries + 1})`,
      );
      if (!labels.includes(LABEL)) {
        say(
          `#${n} is not labelled "${LABEL}" (tagged already, or a look-alike); checking the pending list`,
        );
        break;
      }
      if (merged && pr.merge_commit_sha === sha) {
        own = Number(n);
        break;
      }
      // Pending but unconfirmed: a read that lags the merge shows merged=false
      // and the test-merge sha. Never skip on that; read again, then fail.
      if (tries >= BACKOFF_MS.length || !pause(c, BACKOFF_MS[tries++]))
        throw new Undecided(
          `this commit's subject names release PR #${n}, labelled "${LABEL}", but after ${tries} re-reads it is merged=${merged} with merge_commit_sha=${pr.merge_commit_sha}, not ${sha}. Not skipping the release on that: re-run this run once GitHub shows #${n} merged as ${sha}.`,
        );
      say(`#${n} is pending but not confirmed as ${sha}; read again`);
    }
  } else {
    say("subject is not a release commit's; checking the pending list");
  }
  const listPath = `repos/${repo}/issues?state=closed&labels=autorelease:%20pending&per_page=100`;
  const issues = json(listPath, api(c, listPath));
  // One page, no pagination: a full page could hide a pending PR.
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
  if (own !== undefined) {
    // release-please tags every merged pending release PR at its own merge
    // sha, so any other one would tag a commit that is not this run's. Lag can
    // only hide entries here, which is the old behaviour.
    const others = pending.filter((x) => x !== own);
    if (others.length > 0)
      throw new Undecided(
        `more than one merged release PR is pending (${[...new Set([own, ...others])].join(" ")}): remove "${LABEL}" from the stranded ones: see docs/ops/hosted.md, Release recovery, in open-artifacts-cloud`,
      );
    say(`decision: release commit (#${own}); this run creates the release`);
    return { isRelease: true, log };
  }
  if (pending.length === 0) {
    say("decision: not a release commit");
    return { isRelease: false, log };
  }
  if (pending.length > 1)
    throw new Undecided(
      `more than one merged release PR is pending (${pending.join(" ")}): remove "${LABEL}" from the stranded ones: see docs/ops/hosted.md, Release recovery, in open-artifacts-cloud`,
    );
  const n = pending[0];
  const prPath = `repos/${repo}/pulls/${n}`;
  const pr = json(prPath, api(c, prPath));
  if (!labelsOf(pr).includes(LABEL)) {
    // The list still shows it after its own run tagged it and swapped the label.
    say(
      `decision: #${n} is in the list but no longer labelled "${LABEL}" (already tagged); not a release commit`,
    );
    return { isRelease: false, log };
  }
  const merge = String(pr.merge_commit_sha ?? "");
  if (!/^[0-9a-f]{40}$/.test(merge))
    throw new Undecided(`could not read #${n}'s merge commit`);
  if (merge === sha) {
    // The list caught up but the subject did not match (an edited squash title).
    say(
      `decision: #${n}'s merge commit is this commit; this run creates the release`,
    );
    return { isRelease: true, log };
  }
  const status = api(c, `repos/${repo}/compare/${sha}...${merge}`, ".status");
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
    console.error(`::error::${(e as Error).message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exit(main(process.argv.slice(2)));
