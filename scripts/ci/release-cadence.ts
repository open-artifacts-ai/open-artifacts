// Release cadence: put the release-please PR at the front of the merge queue
// as soon as it is green, and keep one `blocker` issue open while a release is
// stuck. There is no wait for the queue to drain: the release PR jumps ahead of
// any queued code PRs (GraphQL enqueuePullRequest with jump: true), so its merge
// group holds only the release and keeps the release-only fast path. Code PRs
// queued behind it go into the next release.
// Usage: node --experimental-strip-types scripts/ci/release-cadence.ts <plan|arm|blocker> --repo owner/name
// `plan` prints `write=true|false` (does arm need the App token?).
// Needs GH_TOKEN in the environment. `arm` runs with the release App's token
// (so the merge triggers workflows); `blocker` runs with GITHUB_TOKEN.
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const RELEASE_BRANCH =
  "release-please--branches--main--components--open-artifacts";
const BLOCKED = "Release blocked:";
const DAY_MS = 24 * 3600_000;

export type ExecResult = { code: number; stdout: string; stderr: string };
export type Exec = (
  cmd: string,
  args: string[],
) => ExecResult | Promise<ExecResult>;

const QUERY = `query($owner: String!, $name: String!, $head: String!, $branch: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, headRefName: $head, first: 1) {
      nodes {
        id
        number
        url
        title
        createdAt
        isDraft
        isCrossRepository
        isInMergeQueue
        commits(last: 1) {
          nodes {
            commit {
              oid
              statusCheckRollup {
                state
                contexts(first: 100) {
                  nodes {
                    __typename
                    ... on CheckRun { name conclusion status detailsUrl completedAt }
                    ... on StatusContext { context state targetUrl createdAt }
                  }
                }
              }
            }
          }
        }
      }
    }
    mergeQueue(branch: $branch) {
      entries(first: 100) {
        totalCount
        nodes { pullRequest { number headRefName } }
      }
    }
  }
}`;

type Context = {
  __typename?: string;
  name?: string;
  conclusion?: string;
  detailsUrl?: string;
  context?: string;
  state?: string;
  targetUrl?: string;
  completedAt?: string | null;
  createdAt?: string | null;
};
export type ReleasePr = {
  /** The GraphQL node id, for enqueuePullRequest. */
  id: string;
  number: number;
  url: string;
  title: string;
  createdAt: string;
  queued: boolean;
  draft: boolean;
  /** The head branch is in a fork (a PR that merely shares the branch name). */
  fork: boolean;
  rollup: string;
  contexts: Context[];
  oid: string;
  /** Main already carries the version this PR's head sets (it landed; GitHub still reads it open). */
  landed?: boolean;
};
type Snapshot = { pr?: ReleasePr; others: number };

async function gh(exec: Exec, args: string[]): Promise<string> {
  const r = await exec("gh", args);
  if (r.code !== 0)
    throw new Error(
      `gh ${args.slice(0, 2).join(" ")}: ${r.stderr.trim() || `exit ${r.code}`}`,
    );
  return r.stdout;
}

/** A file's raw text at a ref, or "" when it cannot be read. */
async function rawFile(
  exec: Exec,
  repo: string,
  file: string,
  ref: string,
): Promise<string> {
  try {
    return await gh(exec, [
      "api",
      "-H",
      "Accept: application/vnd.github.raw",
      `repos/${repo}/contents/${file}?ref=${ref}`,
    ]);
  } catch {
    return "";
  }
}

const jsonField = (text: string, read: (j: unknown) => unknown): string => {
  try {
    const v = read(JSON.parse(text));
    return typeof v === "string" ? v : "";
  } catch {
    return "";
  }
};

/** The root package.json version at a ref, or "" when it cannot be read. */
async function packageVersion(
  exec: Exec,
  repo: string,
  ref: string,
): Promise<string> {
  return jsonField(
    await rawFile(exec, repo, "package.json", ref),
    (j) => (j as { version?: unknown })?.version,
  );
}

async function snapshot(exec: Exec, repo: string): Promise<Snapshot> {
  const [owner, name] = repo.split("/");
  const out = await gh(exec, [
    "api",
    "graphql",
    "-f",
    `query=${QUERY}`,
    "-f",
    `owner=${owner}`,
    "-f",
    `name=${name}`,
    "-f",
    `head=${RELEASE_BRANCH}`,
    "-f",
    "branch=main",
  ]);
  const repository = JSON.parse(out)?.data?.repository;
  const n = repository?.pullRequests?.nodes?.[0];
  const entries: { pullRequest?: { headRefName?: string } }[] =
    repository?.mergeQueue?.entries?.nodes ?? [];
  const others = entries.filter(
    (e) =>
      !String(e.pullRequest?.headRefName ?? "").startsWith("release-please--"),
  ).length;
  if (!n) return { others };
  const commit = n.commits?.nodes?.[0]?.commit;
  const rollup = commit?.statusCheckRollup;
  const contexts: Context[] = rollup?.contexts?.nodes ?? [];
  const oid = String(commit?.oid ?? "");
  const [mainV, headV] = await Promise.all([
    packageVersion(exec, repo, "main"),
    oid ? packageVersion(exec, repo, oid) : "",
  ]);
  return {
    others,
    pr: {
      id: String(n.id ?? ""),
      number: n.number,
      url: n.url,
      title: n.title,
      createdAt: n.createdAt,
      queued: Boolean(n.isInMergeQueue),
      draft: Boolean(n.isDraft),
      fork: Boolean(n.isCrossRepository),
      rollup: rollup?.state ?? "NONE",
      contexts,
      oid,
      landed: Boolean(mainV) && mainV === headV,
    },
  };
}

export type ArmResult =
  | { action: "none" }
  | { action: "already"; pr: number }
  | { action: "draft"; pr: number }
  | { action: "not-green"; pr: number; state: string }
  | { action: "untested"; pr: number }
  | { action: "landed"; pr: number }
  | { action: "refused"; pr: number; reasons: string[] }
  | { action: "enqueued"; pr: number };

/**
 * The checks main requires today, all ci.yml jobs from GitHub Actions: the
 * ruleset's five plus the two branch protection adds (no-test-hooks,
 * authz-matrix). A floor: what main's rules say at plan time is added to it,
 * never taken from it.
 */
export const REQUIRED_CHECKS = [
  "lint",
  "typecheck",
  "test",
  "build",
  "e2e",
  "no-test-hooks",
  "authz-matrix",
];
/** GitHub Actions' app id, as main's rules name it for those checks. */
export const ACTIONS_APP_ID = 15368;

export type Required = { name: string; app: number };

/**
 * Every check main requires: the floor, plus whatever the rules that apply
 * to main (its rulesets) list right now. That endpoint is public for a public
 * repo (it answers without a token), and ci.yml's cadence-rules-read job
 * reads it with a contents-read job token on every run. Classic branch protection is
 * not read: it needs admin, and the floor already holds the two checks only
 * it lists. A failed read throws, so the plan fails closed.
 */
export async function requiredChecks(
  exec: Exec,
  repo: string,
): Promise<Required[]> {
  // Every page (a failed page fails the whole read), one rule per line.
  const rules = (
    await gh(exec, [
      "api",
      "--paginate",
      `repos/${repo}/rules/branches/main?per_page=100`,
      "--jq",
      ".[] | @json",
    ])
  )
    .split("\n")
    .filter((l) => l.trim())
    .map(
      (l) =>
        JSON.parse(l) as {
          type?: string;
          parameters?: {
            required_status_checks?: {
              context?: string;
              integration_id?: number;
            }[];
          };
        },
    );
  const out = new Map<string, Required>();
  const add = (name: string | undefined, app: number | null | undefined) => {
    if (!name) return;
    const r = { name, app: app ?? ACTIONS_APP_ID };
    out.set(`${r.app}/${r.name}`, r);
  };
  for (const n of REQUIRED_CHECKS) add(n, ACTIONS_APP_ID);
  for (const r of rules)
    if (r.type === "required_status_checks")
      for (const c of r.parameters?.required_status_checks ?? [])
        add(c.context, c.integration_id);
  return [...out.values()];
}

type CheckRow = {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  app: number;
  head_sha: string;
};

/**
 * Whether CI passed on this exact head: each check main requires
 * (requiredChecks), reported by its app on this SHA, in its newest run,
 * completed with success. Read through the check-runs API (checks: read) on every event, so
 * any later event (another PR's CI completing, release-please finishing, a
 * dispatch) recovers a release PR whose own CI event was dropped or replaced
 * in the concurrency queue, and still only a head CI passed is queued.
 * Returns the checks that are missing or not green ([] means passed).
 */
export async function ciProblems(
  exec: Exec,
  repo: string,
  sha: string,
): Promise<string[]> {
  const out = await gh(exec, [
    "api",
    "--paginate",
    `repos/${repo}/commits/${sha}/check-runs?filter=latest&per_page=100`,
    "--jq",
    ".check_runs[] | {id, name, status, conclusion, app: .app.id, head_sha} | @json",
  ]);
  const required = await requiredChecks(exec, repo);
  const rows = out
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as CheckRow)
    .filter((r) => r.head_sha === sha);
  const problems: string[] = [];
  for (const { name, app } of required) {
    const named = rows.filter((r) => r.name === name && r.app === app);
    // Any run of this check still queued or running (a rerun) means CI has
    // not finished on this head, whatever an older run said. A queued run has
    // no start time, so order never decides this.
    const open = named.find((r) => r.status !== "completed");
    // Otherwise the newest completed run, by check-run id (ids only grow).
    const newest = named
      .filter((r) => r.status === "completed")
      .sort((a, b) => a.id - b.id)
      .at(-1);
    if (open) problems.push(`${name} is ${open.status}`);
    else if (!newest) problems.push(`${name} has not reported`);
    else if (newest.conclusion !== "success")
      problems.push(`${name} is ${newest.conclusion}`);
  }
  return problems;
}

type Opts = { exec: Exec; repo: string };
type Plan =
  | { do: "none"; result: ArmResult; msg: string }
  | { do: "enqueue"; pr: ReleasePr; sha: string; ahead: number };

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const cmpSemver = (a: string, b: string): number => {
  const x = SEMVER.exec(a)?.slice(1).map(Number) ?? [];
  const y = SEMVER.exec(b)?.slice(1).map(Number) ?? [];
  for (let k = 0; k < 3; k++)
    if ((x[k] ?? 0) !== (y[k] ?? 0)) return (x[k] ?? 0) - (y[k] ?? 0);
  return 0;
};

/** The highest vX.Y.Z tag, or "" when none can be read. */
async function latestTag(exec: Exec, repo: string): Promise<string> {
  const out = await gh(exec, [
    "api",
    "--paginate",
    `repos/${repo}/git/matching-refs/tags/v`,
    "--jq",
    ".[].ref",
  ]);
  const vs = out
    .split("\n")
    .map((r) => r.trim().replace(/^refs\/tags\/v/, ""))
    .filter((v) => SEMVER.test(v));
  return vs.sort(cmpSemver).at(-1) ?? "";
}

/**
 * Why this head must not be queued, or [] when it may: the title's version,
 * the manifest, package.json and CHANGELOG.md's first heading all agree, and
 * that version is above the latest vX.Y.Z tag and above main's own manifest
 * and package.json versions. Anything unreadable refuses.
 * #3240 merged an old head (0.252.1 files under the 0.253.0 title), and the
 * next release PR (#3243) then proposed 0.246.1 below tag v0.253.0.
 */
export async function versionProblems(
  exec: Exec,
  repo: string,
  pr: { title: string; sha: string },
  baseRef = "main",
): Promise<string[]> {
  const [manifest, pkg, changelog, tag, mainManifest, mainPkg] =
    await Promise.all([
      rawFile(exec, repo, ".release-please-manifest.json", pr.sha),
      packageVersion(exec, repo, pr.sha),
      rawFile(exec, repo, "CHANGELOG.md", pr.sha),
      latestTag(exec, repo),
      rawFile(exec, repo, ".release-please-manifest.json", baseRef),
      packageVersion(exec, repo, baseRef),
    ]);
  const onMain: [string, string][] = [
    [
      `${baseRef}'s .release-please-manifest.json`,
      jsonField(mainManifest, (j) => (j as Record<string, unknown>)?.["."]),
    ],
    [`${baseRef}'s package.json`, mainPkg],
  ];
  const found: [string, string][] = [
    ["title", /\brelease (\d+\.\d+\.\d+)$/.exec(pr.title.trim())?.[1] ?? ""],
    [
      ".release-please-manifest.json",
      jsonField(manifest, (j) => (j as Record<string, unknown>)?.["."]),
    ],
    ["package.json", pkg],
    ["CHANGELOG.md", /^## \[?(\d+\.\d+\.\d+)\]?/m.exec(changelog)?.[1] ?? ""],
  ];
  const out: string[] = [];
  for (const [where, v] of found)
    if (!SEMVER.test(v)) out.push(`no version readable from ${where}`);
  const versions = new Set(found.map(([, v]) => v));
  if (!out.length && versions.size > 1)
    out.push(
      `versions disagree: ${found.map(([w, v]) => `${w} ${v}`).join(", ")}`,
    );
  if (!tag) out.push("no vX.Y.Z tag readable");
  for (const [where, m] of onMain)
    if (!SEMVER.test(m)) out.push(`no version readable from ${where}`);
  const v = found[0]?.[1] ?? "";
  if (out.length) return out;
  if (cmpSemver(v, tag) <= 0)
    out.push(`version ${v} is not above the latest tag v${tag}`);
  for (const [where, m] of onMain)
    if (cmpSemver(v, m) <= 0)
      out.push(`version ${v} is not above ${where} (${m})`);
  return out;
}

async function plan(o: Opts): Promise<Plan> {
  const { pr, others } = await snapshot(o.exec, o.repo);
  if (!pr)
    return {
      do: "none",
      result: { action: "none" },
      msg: "no open release PR",
    };
  // GitHub can still read a landed release PR as open (#2379): queueing it again
  // made the queue build an empty commit that got tagged. Leave it alone.
  if (pr.landed)
    return {
      do: "none",
      result: { action: "landed", pr: pr.number },
      msg: `release PR #${pr.number} already landed (main carries its version), not queueing`,
    };
  if (pr.queued)
    return {
      do: "none",
      result: { action: "already", pr: pr.number },
      msg: `release PR #${pr.number} is already queued`,
    };
  if (pr.draft || pr.fork)
    return {
      do: "none",
      result: { action: "draft", pr: pr.number },
      msg: `release PR #${pr.number} is ${pr.draft ? "a draft" : "from a fork"}, not queueing`,
    };
  if (pr.rollup !== "SUCCESS")
    return {
      do: "none",
      result: { action: "not-green", pr: pr.number, state: pr.rollup },
      msg: `release PR #${pr.number} checks are ${pr.rollup}, not queueing`,
    };
  // Only a head CI passed is queued: the required checks on that exact SHA,
  // looked up on every event, not taken from this event.
  const sha = pr.oid;
  const ci = /^[0-9a-f]{40}$/.test(sha)
    ? await ciProblems(o.exec, o.repo, sha)
    : ["no head commit"];
  if (ci.length)
    return {
      do: "none",
      result: { action: "untested", pr: pr.number },
      msg: `release PR #${pr.number} head ${sha}: CI has not passed (${ci.join(", ")}), not queueing`,
    };
  const reasons = await versionProblems(o.exec, o.repo, {
    title: pr.title,
    sha,
  });
  if (reasons.length)
    return {
      do: "none",
      result: { action: "refused", pr: pr.number, reasons },
      msg: `release PR #${pr.number} not queued: ${reasons.join("; ")}`,
    };
  return { do: "enqueue", pr, sha, ahead: others };
}

/** True when `arm` would change the release PR (so it needs the App token). Read-only. */
export async function willWrite(o: Opts): Promise<boolean> {
  return (await planStep(o)).write;
}

/**
 * The read-only plan step: whether arm needs the App token, and why the
 * release PR was refused, if it was (the step fails and says so).
 */
export async function planStep(
  o: Opts,
): Promise<{ write: boolean; msg: string; refused: string[] }> {
  const p = await plan(o);
  if (p.do !== "none")
    return {
      write: true,
      msg: `queueing release PR #${p.pr.number}`,
      refused: [],
    };
  return {
    write: false,
    msg: p.msg,
    refused: p.result.action === "refused" ? p.result.reasons : [],
  };
}

const ENQUEUE = `mutation($id: ID!, $oid: GitObjectID!) {
  enqueuePullRequest(input: {pullRequestId: $id, expectedHeadOid: $oid, jump: true}) {
    mergeQueueEntry { position jump }
  }
}`;

/** The PR's head commit right now, read fresh (not from the planning read). */
async function headNow(exec: Exec, repo: string, n: number): Promise<string> {
  return (
    await gh(exec, ["api", `repos/${repo}/pulls/${n}`, "--jq", ".head.sha"])
  ).trim();
}

/**
 * Puts the green release PR at the front of the merge queue, pinned to the
 * head the green CI run tested (expectedHeadOid), with no wait for queued code
 * PRs. Anything short of the front is an error.
 */
export async function arm(
  o: Opts & {
    log: (line: string) => void;
    /** Runs the enqueue (the release App's token); reads use `exec`. */
    writeExec?: Exec;
  },
): Promise<ArmResult> {
  const p = await plan(o);
  if (p.do === "none") {
    if (p.result.action === "refused") throw new Error(p.msg);
    o.log(p.msg);
    return p.result;
  }
  if (!p.pr.id) throw new Error(`release PR #${p.pr.number}: no node id`);
  // release-please may push a new head between the plan and now (#3240): read
  // it fresh, and leave a moved head to its own CI run.
  const now = await headNow(o.exec, o.repo, p.pr.number);
  if (now !== p.sha) {
    o.log(
      `release PR #${p.pr.number} head moved to ${now} after CI tested ${p.sha}: not queueing; the next event handles the new head`,
    );
    return { action: "untested", pr: p.pr.number };
  }
  const out = await gh(o.writeExec ?? o.exec, [
    "api",
    "graphql",
    "-f",
    `query=${ENQUEUE}`,
    "-f",
    `id=${p.pr.id}`,
    "-f",
    `oid=${p.sha}`,
  ]);
  const entry = JSON.parse(out)?.data?.enqueuePullRequest?.mergeQueueEntry;
  if (!entry)
    throw new Error(
      `release PR #${p.pr.number}: enqueuePullRequest returned no queue entry`,
    );
  // Only the front counts: a granted jump that still left it behind another
  // entry is not the front.
  if (entry.position !== 1)
    throw new Error(
      `release PR #${p.pr.number} was queued at position ${entry.position} (jump: ${entry.jump}), not at the front: code PRs ahead of it may merge with it. The release App may need to be allowed to jump the queue.`,
    );
  o.log(
    `queued release PR #${p.pr.number} at the front of the merge queue (position ${entry.position}, jump: ${entry.jump}), ahead of ${p.ahead} code PRs`,
  );
  return { action: "enqueued", pr: p.pr.number };
}

const FAILED = new Set([
  "FAILURE",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
]);
function failing(contexts: Context[]): { name: string; url?: string }[] {
  const out: { name: string; url?: string }[] = [];
  for (const c of contexts) {
    if (c.__typename === "StatusContext") {
      if (c.state === "FAILURE" || c.state === "ERROR")
        out.push({ name: String(c.context), url: c.targetUrl });
    } else if (c.conclusion && FAILED.has(c.conclusion))
      out.push({ name: String(c.name), url: c.detailsUrl });
  }
  return out;
}

export type BlockerResult =
  | { action: "none" }
  | { action: "opened" }
  | { action: "refreshed"; issue: number }
  | { action: "closed"; issues: number[] };

/** Keeps one `blocker` issue in step with a stuck release PR, and closes it once the release shipped. */
export async function blocker(o: {
  exec: Exec;
  repo: string;
  now: () => number;
  log: (line: string) => void;
}): Promise<BlockerResult> {
  const { pr } = await snapshot(o.exec, o.repo);
  let issues: {
    number: number;
    title: string;
    createdAt: string;
    body?: string;
  }[] = JSON.parse(
    await gh(o.exec, [
      "issue",
      "list",
      "--repo",
      o.repo,
      "--label",
      "blocker",
      "--state",
      "open",
      "--json",
      "number,title,createdAt,body",
      "--limit",
      "50",
    ]),
  ).filter((i: { title: string }) => i.title.startsWith(BLOCKED));

  // Close stale blockers on every run: a release newer than the issue means it shipped.
  const closed: number[] = [];
  if (issues.length) {
    const latest = await o.exec("gh", [
      "api",
      `repos/${o.repo}/releases/latest`,
    ]);
    if (latest.code === 0) {
      const rel: { tag_name?: string; published_at?: string } = JSON.parse(
        latest.stdout,
      );
      const shipped = Date.parse(rel.published_at ?? "");
      for (const i of issues) {
        if (!(shipped > Date.parse(i.createdAt))) continue;
        await gh(o.exec, [
          "issue",
          "close",
          String(i.number),
          "--repo",
          o.repo,
          "--comment",
          `Released ${rel.tag_name}. Closing.`,
        ]);
        closed.push(i.number);
      }
      issues = issues.filter((i) => !closed.includes(i.number));
    }
  }

  if (pr) {
    const bad = pr.rollup === "FAILURE" || pr.rollup === "ERROR";
    const old = o.now() - Date.parse(pr.createdAt) > DAY_MS;
    if (!bad && !old)
      return closed.length
        ? { action: "closed", issues: closed }
        : { action: "none" };
    const reasons = [
      ...(bad ? [`release PR #${pr.number} has failing checks`] : []),
      ...(old
        ? [`release PR #${pr.number} has been open for over 24 hours`]
        : []),
    ];
    const lines = [
      `${pr.title}: ${pr.url}`,
      "",
      ...reasons.map((r) => `- ${r}`),
      ...(bad
        ? [
            "",
            "Failing checks:",
            ...failing(pr.contexts).map((f) =>
              f.url ? `- [${f.name}](${f.url})` : `- ${f.name}`,
            ),
          ]
        : []),
      "",
      "This issue closes itself when the release ships.",
    ];
    const title = `${BLOCKED} ${reasons[0]}`;
    const body = lines.join("\n");
    const existing = issues[0];
    if (existing) {
      if (existing.title === title && existing.body === body)
        return closed.length
          ? { action: "closed", issues: closed }
          : { action: "none" };
      await gh(o.exec, [
        "issue",
        "edit",
        String(existing.number),
        "--repo",
        o.repo,
        "--title",
        title,
        "--body",
        body,
      ]);
      return { action: "refreshed", issue: existing.number };
    }
    await gh(o.exec, [
      "label",
      "create",
      "blocker",
      "--repo",
      o.repo,
      "--force",
      "--color",
      "B60205",
      "--description",
      "A release or deploy is stuck",
    ]);
    await gh(o.exec, [
      "issue",
      "create",
      "--repo",
      o.repo,
      "--title",
      title,
      "--body",
      body,
      "--label",
      "blocker",
    ]);
    return { action: "opened" };
  }

  return closed.length
    ? { action: "closed", issues: closed }
    : { action: "none" };
}

const execWith =
  (token?: string): Exec =>
  (cmd, args) => {
    const r = spawnSync(cmd, args, {
      encoding: "utf8",
      env: token ? { ...process.env, GH_TOKEN: token } : process.env,
    });
    return {
      code: r.status ?? 1,
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
    };
  };

export const realExec: Exec = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return {
    code: r.status ?? 1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
};

async function main(argv: string[]) {
  const [mode, flag, repo] = argv;
  if (
    (mode !== "arm" && mode !== "blocker" && mode !== "plan") ||
    flag !== "--repo" ||
    !repo
  ) {
    console.error(
      "usage: release-cadence.ts <arm|blocker|plan> --repo owner/name",
    );
    return 2;
  }
  if (mode === "plan") {
    const p = await planStep({ exec: realExec, repo });
    // stdout is appended to $GITHUB_OUTPUT: `write=true` when arm needs the App token
    console.log(`write=${p.write}`);
    console.error(p.msg);
    if (p.refused.length) {
      summary([`Release not queued: ${p.msg}`]);
      return 1;
    }
    return 0;
  }
  const log = (s: string) => console.log(s);
  const r =
    mode === "arm"
      ? await arm({
          exec: execWith(process.env.READ_GH_TOKEN),
          writeExec: realExec,
          repo,
          log,
        })
      : await blocker({ exec: realExec, repo, now: Date.now, log });
  console.log(JSON.stringify(r));
  return 0;
}

/** Appends lines to the run summary, as plain text (no markdown from titles). */
function summary(lines: string[]) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  const text = lines.join("\n");
  const fence = "`".repeat(
    Math.max(3, ...(text.match(/`+/g) ?? []).map((r) => r.length + 1)),
  );
  appendFileSync(file, `${fence}\n${text}\n${fence}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2)).then(
    (c) => process.exit(c),
    (e) => {
      const m = String(e instanceof Error ? e.message : e);
      console.error(m);
      summary([`release-cadence ${process.argv[2] ?? ""} failed: ${m}`]);
      process.exit(1);
    },
  );
