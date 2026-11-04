// The post-deploy staging smoke's alert (#1406, deploy-staging.yml's report
// job). It was red for about 44 h unseen (#1405), so a red run on main keeps
// one open `blocker` issue, titled exactly ISSUE: the first red run opens it,
// and every later red run comments on it, so each one notifies the repo's
// watchers again (an edit would not). A green run closes it with a comment
// linking that run. A cancelled run (or a skipped one) does nothing.
// The prod gate is staging-smoke-gate.sh, which reads the runs themselves,
// never this issue.
// Usage: node --experimental-strip-types scripts/ci/staging-smoke-alert.ts report --repo owner/name --result <result> --run <url> --sha <sha>
// Needs GH_TOKEN with issues: write. Every failure throws (exit 1), so the
// report job goes red too.
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/** The one stable title: repeated failures find it, never open a second. */
export const ISSUE = "Staging smoke red on main";
const SHA_RE = /^[0-9a-f]{40}$/;

export type ExecResult = { code: number; stdout: string; stderr: string };
export type Exec = (cmd: string, args: string[]) => ExecResult;

function gh(exec: Exec, args: string[]): string {
  const r = exec("gh", args);
  if (r.code !== 0)
    throw new Error(
      `gh ${args.slice(0, 2).join(" ")}: ${r.stderr.trim() || `exit ${r.code}`}`,
    );
  return r.stdout;
}

export type Report =
  | { action: "none" }
  | { action: "closed"; issues: number[] }
  | { action: "commented"; issue: number }
  | { action: "opened" };

/**
 * `result` is the run's: the smoke job's result once deploy succeeded, else
 * the deploy job's. success closes, cancelled or skipped does nothing, and
 * anything else (failure, or a value this does not know) is red.
 */
export function report(o: {
  exec: Exec;
  repo: string;
  result: string;
  run: string;
  sha: string;
}): Report {
  if (o.result === "cancelled" || o.result === "skipped")
    return { action: "none" };
  if (!o.run) throw new Error("--run is required");
  const sha = SHA_RE.test(o.sha) ? o.sha : "an unknown commit";
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
        "100",
      ]),
    ) as { number: number; title: string }[]
  ).filter((i) => i.title === ISSUE);

  if (o.result === "success") {
    for (const i of open)
      gh(o.exec, [
        "issue",
        "close",
        String(i.number),
        "--repo",
        o.repo,
        "--comment",
        `Green again: the smoke passed on ${sha} in ${o.run}`,
      ]);
    return open.length
      ? { action: "closed", issues: open.map((i) => i.number) }
      : { action: "none" };
  }

  const existing = open[0];
  if (existing) {
    gh(o.exec, [
      "issue",
      "comment",
      String(existing.number),
      "--repo",
      o.repo,
      "--body",
      `Still red: \`${o.result}\` on ${sha} in ${o.run}`,
    ]);
    return { action: "commented", issue: existing.number };
  }
  const body = [
    `The post-deploy staging smoke (deploy-staging.yml) ended \`${o.result}\` on main at ${sha}.`,
    "",
    `Run: ${o.run}`,
    "",
    "While it stays red, prod promotion refuses every tag (scripts/ci/staging-smoke-gate.sh, in the release chain and in deploy-hosted-platform.yml's prod run). Each later red run comments here; the next green run on main closes this issue.",
  ].join("\n");
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
    ISSUE,
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
  if (mode !== "report")
    throw new Error("usage: staging-smoke-alert.ts report ...");
  const repo = flag(argv, "repo");
  if (!repo) throw new Error("--repo owner/name is required");
  const r = report({
    exec: realExec,
    repo,
    result: flag(argv, "result"),
    run: flag(argv, "run"),
    sha: flag(argv, "sha"),
  });
  console.error(`staging-smoke-alert: ${JSON.stringify(r)}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  main(process.argv.slice(2));
