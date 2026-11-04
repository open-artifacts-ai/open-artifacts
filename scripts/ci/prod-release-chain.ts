// The automatic prod release chain (#1343, prod-release-chain.yml): a green
// redline-staging dispatch for a release tag deploys that tag to the prod
// platform, and the scheduler's fleet duty (#955) takes it from there.
// `tag` reads the tag from the run's display title (redline-staging.yml's
// run-name, the shape staging-first-gate.sh matches); `fresh` says whether
// this event is the newest gated run for the tag; `newer` whether the tag is
// above what prod's scheduler runs. Both print `go=true|false`: false is a
// neutral skip (a stale or repeated event, a release prod already runs), not
// a failure. `require-newer` is the deploy's re-check, which fails instead.
// `report` keeps one `blocker` issue open while the last chain run is red.
// Usage: node --experimental-strip-types scripts/ci/prod-release-chain.ts tag --title "<display_title>"
//        node --experimental-strip-types scripts/ci/prod-release-chain.ts fresh --repo owner/name --tag vX.Y.Z --head-sha <sha>
//        node --experimental-strip-types scripts/ci/prod-release-chain.ts newer --tag vX.Y.Z --current vX.Y.Z
//        node --experimental-strip-types scripts/ci/prod-release-chain.ts require-newer --tag vX.Y.Z --current vX.Y.Z
//        node --experimental-strip-types scripts/ci/prod-release-chain.ts report --repo owner/name --tag vX.Y.Z --result success --run <url>
// Every other failure throws (exit 1): the chain fails closed. Needs GH_TOKEN for
// fresh and report.
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/** redline-staging.yml's run-name for one tag: `redline-staging ${{ inputs.tag }}`. */
export const TITLE_RE = /^redline-staging (v\d{1,6}\.\d{1,6}\.\d{1,6})$/;
const TAG_RE = /^v\d{1,6}\.\d{1,6}\.\d{1,6}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const ISSUE = "Prod release chain";

export type ExecResult = { code: number; stdout: string; stderr: string };
export type Exec = (cmd: string, args: string[]) => ExecResult;
type Run = {
  id: number;
  status: string;
  conclusion: string | null;
  display_title?: string;
  head_branch?: string;
  head_sha?: string;
  event?: string;
  created_at?: string;
  head_repository?: { full_name?: string } | null;
};

function gh(exec: Exec, args: string[]): string {
  const r = exec("gh", args);
  if (r.code !== 0)
    throw new Error(
      `gh ${args.slice(0, 2).join(" ")}: ${r.stderr.trim() || `exit ${r.code}`}`,
    );
  return r.stdout;
}

/** The release tag a red-line run's display title names; anything else throws. */
export function tagOf(title: string): string {
  const m = TITLE_RE.exec(title);
  if (!m?.[1]) throw new Error("not a redline-staging run for a release tag");
  return m[1];
}

const parts = (tag: string): [number, number, number] => {
  if (!TAG_RE.test(tag)) throw new Error(`not a release tag: ${tag}`);
  const [a, b, c] = tag.slice(1).split(".").map(Number);
  return [a ?? 0, b ?? 0, c ?? 0];
};

/** True iff `tag` is a higher release than `current`; either malformed throws. */
export function isNewer(tag: string, current: string): boolean {
  const t = parts(tag);
  const c = parts(current);
  for (let i = 0; i < 3; i++)
    if ((t[i] ?? 0) !== (c[i] ?? 0)) return (t[i] ?? 0) > (c[i] ?? 0);
  return false;
}

/**
 * Whether the newest run staging-first-gate.sh would accept for `tag` (the
 * same filter: completed, success, dispatched, on main, this repository,
 * titled for the tag) has `headSha`. If not, this event is stale and an
 * event for the newer run acts instead: go is false. No such run at all, an
 * API error or a bad input throws. The 7-day window and the artifact are
 * staging-first-gate.sh's.
 */
export function fresh(o: {
  exec: Exec;
  repo: string;
  tag: string;
  headSha: string;
}): { run: number; go: boolean } {
  if (!TAG_RE.test(o.tag)) throw new Error(`not a release tag: ${o.tag}`);
  if (!SHA_RE.test(o.headSha)) throw new Error("the event has no head sha");
  const body = JSON.parse(
    gh(o.exec, [
      "api",
      "-X",
      "GET",
      `repos/${o.repo}/actions/workflows/redline-staging.yml/runs?branch=main&status=success&event=workflow_dispatch&per_page=100`,
    ]),
  ) as { workflow_runs?: Run[] };
  if (!Array.isArray(body.workflow_runs))
    throw new Error("unparsable redline-staging.yml runs");
  const title = `redline-staging ${o.tag}`;
  const newest = body.workflow_runs
    .filter(
      (r) =>
        r.status === "completed" &&
        r.conclusion === "success" &&
        r.head_branch === "main" &&
        r.event === "workflow_dispatch" &&
        (r.head_repository?.full_name ?? "") === o.repo &&
        (r.display_title ?? "") === title,
    )
    .sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""))
    .at(-1);
  if (!newest) throw new Error(`no green redline-staging run for ${o.tag}`);
  return { run: newest.id, go: newest.head_sha === o.headSha };
}

export type Report =
  | { action: "none" }
  | { action: "closed"; issues: number[] }
  | { action: "refreshed"; issue: number }
  | { action: "opened" };

/** Red keeps one open `blocker` issue, refreshed; green closes it. */
export function report(o: {
  exec: Exec;
  repo: string;
  tag: string;
  result: string;
  run: string;
}): Report {
  // A neutral skip (a stale event, a release prod already runs) leaves the
  // issue as it is: it neither opens nor closes it.
  if (o.result === "skipped") return { action: "none" };
  const tag = TAG_RE.test(o.tag) ? o.tag : "";
  const open = (
    JSON.parse(
      gh(o.exec, [
        "issue",
        "list",
        "--repo",
        o.repo,
        "--label",
        "blocker",
        "--state",
        "open",
        "--json",
        "number,title",
        "--limit",
        "50",
      ]),
    ) as { number: number; title: string }[]
  ).filter((i) => i.title.startsWith(`${ISSUE} `));

  if (o.result === "success") {
    for (const i of open)
      gh(o.exec, [
        "issue",
        "close",
        String(i.number),
        "--repo",
        o.repo,
        "--comment",
        `Green on ${tag}: ${o.run}`,
      ]);
    return open.length
      ? { action: "closed", issues: open.map((i) => i.number) }
      : { action: "none" };
  }

  const title = `${ISSUE} failed: ${tag || "no release tag"}`;
  const body = [
    `The prod release chain ended with \`${o.result}\` before the fleet started.`,
    "",
    `Run: ${o.run}`,
    "",
    "The scheduler deploys last and its tag is the fleet's target, so the fleet did not move unless the run failed after the scheduler deployed (then only the read-back failed: check `platform-tags.sh prod`). Read the run: a gate refused the tag, or the deploy or its read-back failed. Forward only: fix the cause, cut a new release and red-line it; a green chain run closes this issue (docs/ops/hosted.md).",
  ].join("\n");
  const existing = open[0];
  if (existing) {
    gh(o.exec, [
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
  // The label is shared: create it if it's missing, never reset it.
  const labels = JSON.parse(
    gh(o.exec, [
      "label",
      "list",
      "--repo",
      o.repo,
      "--search",
      "blocker",
      "--json",
      "name",
    ]),
  ) as { name: string }[];
  if (!labels.some((l) => l.name === "blocker"))
    gh(o.exec, [
      "label",
      "create",
      "blocker",
      "--repo",
      o.repo,
      "--color",
      "B60205",
      "--description",
      "A release or deploy is stuck",
    ]);
  gh(o.exec, [
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

const realExec: Exec = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return {
    code: r.status ?? 1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
};

const flag = (argv: string[], name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i < 0 ? "" : (argv[i + 1] ?? "");
};

function main(argv: string[]) {
  const [mode] = argv;
  if (mode === "tag") {
    console.log(`tag=${tagOf(flag(argv, "title"))}`);
    return;
  }
  if (mode === "newer" || mode === "require-newer") {
    const tag = flag(argv, "tag");
    const current = flag(argv, "current");
    const go = isNewer(tag, current);
    if (!go && mode === "require-newer")
      throw new Error(`${tag} is not newer than prod's ${current}: refusing`);
    console.error(
      `prod-release-chain: ${tag} is ${go ? "" : "not "}newer than prod's ${current}`,
    );
    if (mode === "newer") console.log(`go=${go}`);
    return;
  }
  const repo = flag(argv, "repo");
  if (!repo) throw new Error("--repo owner/name is required");
  if (mode === "fresh") {
    const r = fresh({
      exec: realExec,
      repo,
      tag: flag(argv, "tag"),
      headSha: flag(argv, "head-sha"),
    });
    console.error(
      r.go
        ? `prod-release-chain: run ${r.run} is the newest for the tag`
        : `prod-release-chain: a newer green run (${r.run}) for the tag has another head sha: this event is stale`,
    );
    console.log(`go=${r.go}`);
    return;
  }
  if (mode === "report") {
    const r = report({
      exec: realExec,
      repo,
      tag: flag(argv, "tag"),
      result: flag(argv, "result"),
      run: flag(argv, "run"),
    });
    console.error(`prod-release-chain: ${JSON.stringify(r)}`);
    return;
  }
  throw new Error(
    "usage: prod-release-chain.ts <tag|fresh|newer|require-newer|report> ...",
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  main(process.argv.slice(2));
