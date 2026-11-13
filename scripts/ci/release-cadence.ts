// Release cadence: arm the release-please PR when it is green and the merge
// queue has drained, and keep one `blocker` issue open while a release is stuck.
// Usage: node --experimental-strip-types scripts/ci/release-cadence.ts <plan|arm|blocker> --repo owner/name
// `plan` prints `write=true|false` (does arm need the App token?).
// Needs GH_TOKEN in the environment. `arm` runs with the release App's token
// (so the merge triggers workflows); `blocker` runs with GITHUB_TOKEN.
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const RELEASE_BRANCH =
  "release-please--branches--main--components--open-artifacts";
const BLOCKED = "Release blocked:";
const DAY_MS = 24 * 3600_000;
/** Once the release PR has been green this long, arm it even if code PRs are still queued. */
export const DRAIN_CAP_MS = 30 * 60_000;

export type ExecResult = { code: number; stdout: string; stderr: string };
export type Exec = (
  cmd: string,
  args: string[],
) => ExecResult | Promise<ExecResult>;

const QUERY = `query($owner: String!, $name: String!, $head: String!, $branch: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, headRefName: $head, first: 1) {
      nodes {
        number
        url
        title
        createdAt
        isInMergeQueue
        autoMergeRequest { enabledAt enabledBy { login } }
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
  number: number;
  url: string;
  title: string;
  createdAt: string;
  queued: boolean;
  armed: boolean;
  armedBy?: string;
  rollup: string;
  contexts: Context[];
  oid: string;
  /** Main already carries the version this PR's head sets (it landed; GitHub still reads it open). */
  landed?: boolean;
  /** When the latest check on the current head finished (ms), if known. */
  settledAt?: number;
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

/** The root package.json version at a ref, or "" when it cannot be read. */
async function packageVersion(
  exec: Exec,
  repo: string,
  ref: string,
): Promise<string> {
  try {
    const out = await gh(exec, [
      "api",
      "-H",
      "Accept: application/vnd.github.raw",
      `repos/${repo}/contents/package.json?ref=${ref}`,
    ]);
    return String(JSON.parse(out)?.version ?? "");
  } catch {
    return "";
  }
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
  const times = contexts
    .map((c) => Date.parse(String(c.completedAt ?? c.createdAt ?? "")))
    .filter((t) => !Number.isNaN(t));
  return {
    others,
    pr: {
      number: n.number,
      url: n.url,
      title: n.title,
      createdAt: n.createdAt,
      queued: Boolean(n.isInMergeQueue),
      armed: Boolean(n.autoMergeRequest),
      armedBy: n.autoMergeRequest?.enabledBy?.login,
      rollup: rollup?.state ?? "NONE",
      contexts,
      oid,
      landed: Boolean(mainV) && mainV === headV,
      settledAt: times.length ? Math.max(...times) : undefined,
    },
  };
}

export type ArmResult =
  | { action: "none" }
  | { action: "already"; pr: number }
  | { action: "not-green"; pr: number; state: string }
  | { action: "waiting"; entries: number }
  | { action: "disarmed"; pr: number }
  | { action: "landed"; pr: number }
  | { action: "armed"; pr: number };

type Opts = {
  exec: Exec;
  repo: string;
  now?: () => number;
  capMs?: number;
  /** The release App's bot login; only auto-merge it enabled is ever disabled. */
  appLogin?: string;
};
type Plan =
  | { do: "none"; result: ArmResult; msg: string }
  | { do: "disarm"; pr: ReleasePr }
  | { do: "arm"; pr: ReleasePr; capHit: boolean };

const bare = (l?: string) => String(l ?? "").replace(/\[bot\]$/, "");

function plan(
  s: Snapshot,
  now: number,
  capMs: number,
  appLogin?: string,
): Plan {
  const { pr, others } = s;
  if (!pr)
    return {
      do: "none",
      result: { action: "none" },
      msg: "no open release PR",
    };
  // GitHub can still read a landed release PR as open (#2379): arming it again
  // made the queue build an empty commit that got tagged. Leave it alone.
  if (pr.landed)
    return {
      do: "none",
      result: { action: "landed", pr: pr.number },
      msg: `release PR #${pr.number} already landed (main carries its version), not arming`,
    };
  const capHit =
    pr.rollup === "SUCCESS" &&
    pr.settledAt !== undefined &&
    now - pr.settledAt >= capMs;
  if (pr.queued)
    return {
      do: "none",
      result: { action: "already", pr: pr.number },
      msg: `release PR #${pr.number} is already queued`,
    };
  if (pr.armed) {
    // A fresh head must re-qualify under the drain rule.
    const ours = Boolean(appLogin) && bare(pr.armedBy) === bare(appLogin);
    if (ours && others > 0 && !capHit) return { do: "disarm", pr };
    return {
      do: "none",
      result: { action: "already", pr: pr.number },
      msg: `release PR #${pr.number} is already armed`,
    };
  }
  if (pr.rollup !== "SUCCESS")
    return {
      do: "none",
      result: { action: "not-green", pr: pr.number, state: pr.rollup },
      msg: `release PR #${pr.number} checks are ${pr.rollup}, not arming`,
    };
  if (others > 0 && !capHit)
    return {
      do: "none",
      result: { action: "waiting", entries: others },
      msg: `waiting for the queue to drain (${others} entries)`,
    };
  return { do: "arm", pr, capHit: others > 0 };
}

/** True when `arm` would change the release PR (so it needs the App token). Read-only. */
export async function willWrite(o: Opts): Promise<boolean> {
  const p = plan(
    await snapshot(o.exec, o.repo),
    (o.now ?? Date.now)(),
    o.capMs ?? DRAIN_CAP_MS,
    o.appLogin,
  );
  return p.do !== "none";
}

/** Arms auto-merge on the release PR once it is green and the queue holds nothing but release PRs (or the drain cap is hit). */
export async function arm(
  o: Opts & { log: (line: string) => void },
): Promise<ArmResult> {
  const p = plan(
    await snapshot(o.exec, o.repo),
    (o.now ?? Date.now)(),
    o.capMs ?? DRAIN_CAP_MS,
    o.appLogin,
  );
  if (p.do === "none") {
    o.log(p.msg);
    return p.result;
  }
  if (p.do === "disarm") {
    await gh(o.exec, [
      "pr",
      "merge",
      String(p.pr.number),
      "--disable-auto",
      "--repo",
      o.repo,
    ]);
    o.log(
      `disabled auto-merge on release PR #${p.pr.number} to re-check the drain on its current head`,
    );
    return { action: "disarmed", pr: p.pr.number };
  }
  if (p.capHit)
    o.log(
      `cap hit: release PR #${p.pr.number} has been green for 30 minutes or more, arming despite queued PRs`,
    );
  await gh(o.exec, [
    "pr",
    "merge",
    String(p.pr.number),
    "--auto",
    "--squash",
    "--match-head-commit",
    p.pr.oid,
    "--repo",
    o.repo,
  ]);
  o.log(`armed auto-merge on release PR #${p.pr.number}`);
  return { action: "armed", pr: p.pr.number };
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

const realExec: Exec = (cmd, args) => {
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
    // stdout is appended to $GITHUB_OUTPUT: `write=true` when arm needs the App token
    console.log(
      `write=${await willWrite({ exec: realExec, repo, appLogin: process.env.RELEASE_APP_LOGIN })}`,
    );
    return 0;
  }
  const log = (s: string) => console.log(s);
  const r =
    mode === "arm"
      ? await arm({
          exec: realExec,
          repo,
          log,
          appLogin: process.env.RELEASE_APP_LOGIN,
        })
      : await blocker({ exec: realExec, repo, now: Date.now, log });
  console.log(JSON.stringify(r));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2)).then(
    (c) => process.exit(c),
    (e) => {
      console.error(String(e instanceof Error ? e.message : e));
      process.exit(1);
    },
  );
