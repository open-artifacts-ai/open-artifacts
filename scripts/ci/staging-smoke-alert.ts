// The post-deploy staging smoke's alert (#1406, deploy-staging.yml's report
// job). It was red for about 44 h unseen (#1405), so a red run on main keeps
// one open `blocker` issue, titled exactly ISSUE: the first red run opens it,
// and every later red run comments on it, so each one notifies the repo's
// watchers again (an edit would not). A green run closes it with a comment
// linking that run. A cancelled run (or a skipped one) does nothing.
// The prod gate is staging-smoke-gate.sh, which reads the runs themselves,
// never this issue.
// The owner is emailed through GitHub's own notifications: `--notify <login>`
// (the repo variable OA_ALERT_GITHUB_LOGIN, never a login in code) is
// assigned the issue when it opens, and @-mentioned in each later red
// comment. One leading "@" is dropped. Empty, it skips both and logs that.
// Set but not a GitHub login, the issue is still opened, commented or closed
// (with no mention), and then the report throws, so a misconfigured alert
// turns the job red rather than going quiet. If the assignment itself fails (say the login
// can't be assigned here), the issue stays open and a comment @-mentions the
// login instead, so the alert never depends on it.
// Usage: node --experimental-strip-types scripts/ci/staging-smoke-alert.ts report --repo owner/name --result <result> --run <url> --sha <sha> [--notify <login>]
// Needs GH_TOKEN with issues: write. Every failure throws (exit 1), so the
// report job goes red too.
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/** The one stable title: repeated failures find it, never open a second. */
export const ISSUE = "Staging smoke red on main";
const SHA_RE = /^[0-9a-f]{40}$/;
/** A GitHub login: 1 to 39 letters, digits or single inner hyphens. */
export const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

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
  | { action: "commented"; issue: number; notified: Notified }
  | { action: "opened"; issue: number; notified: Notified };

/** How the owner was told: assigned, @-mentioned, or not at all (no login). */
export type Notified = "assigned" | "mentioned" | "none";

/**
 * `result` is the run's: the smoke job's result once deploy succeeded, else
 * the deploy job's. success closes, cancelled or skipped does nothing, and
 * anything else (failure, or a value this does not know) is red.
 */
export function report(o: Parameters<typeof reportIssue>[0]): Report {
  if (o.result === "cancelled" || o.result === "skipped")
    return { action: "none" };
  const set = (o.notify ?? "").trim();
  const raw = set.replace(/^@/, "");
  const valid = LOGIN_RE.test(raw);
  const r = reportIssue({
    ...o,
    notify: valid ? raw : "",
    badLogin: !valid && set !== "",
  });
  if (!valid && set !== "")
    throw new Error(
      `OA_ALERT_GITHUB_LOGIN is set but is not a GitHub login (${JSON.stringify(raw.slice(0, 64))}); fix the repo variable. The issue was still updated: ${JSON.stringify(r)}`,
    );
  return r;
}

function reportIssue(o: {
  exec: Exec;
  repo: string;
  result: string;
  run: string;
  sha: string;
  /** The owner's GitHub login (vars.OA_ALERT_GITHUB_LOGIN); "" for none. */
  notify?: string;
  log?: (line: string) => void;
  /** Set by report: notify was set but invalid (already blanked). */
  badLogin?: boolean;
}): Report {
  if (o.result === "cancelled" || o.result === "skipped")
    return { action: "none" };
  const log = o.log ?? ((l: string) => console.error(l));
  const login = o.notify ?? "";
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

  if (!login)
    log(
      o.badLogin
        ? "staging-smoke-alert: OA_ALERT_GITHUB_LOGIN is not a GitHub login; no assignment or mention"
        : "staging-smoke-alert: OA_ALERT_GITHUB_LOGIN is empty; no assignment or mention",
    );
  const existing = open[0];
  if (existing) {
    const to = login ? `@${login} ` : "";
    gh(o.exec, [
      "issue",
      "comment",
      String(existing.number),
      "--repo",
      o.repo,
      "--body",
      `${to}Still red: \`${o.result}\` on ${sha} in ${o.run}`,
    ]);
    return {
      action: "commented",
      issue: existing.number,
      notified: login ? "mentioned" : "none",
    };
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
  const url = gh(o.exec, [
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
  ]).trim();
  const n = /\/issues\/(\d+)$/.exec(url)?.[1];
  if (!n) throw new Error(`gh issue create: no issue url in "${url}"`);
  const issue = Number(n);
  if (!login) return { action: "opened", issue, notified: "none" };
  // Assigned after it exists, so a login that can't be assigned never stops
  // the issue from opening; then a mention tells them instead.
  const a = o.exec("gh", [
    "issue",
    "edit",
    n,
    "--repo",
    o.repo,
    "--add-assignee",
    login,
  ]);
  if (a.code === 0) return { action: "opened", issue, notified: "assigned" };
  log(
    `staging-smoke-alert: assigning issue ${n} failed (${a.stderr.trim() || `exit ${a.code}`}); mentioning instead`,
  );
  gh(o.exec, [
    "issue",
    "comment",
    n,
    "--repo",
    o.repo,
    "--body",
    `@${login} the staging smoke is red on main: ${o.run}`,
  ]);
  return { action: "opened", issue, notified: "mentioned" };
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
    notify: flag(argv, "notify"),
  });
  console.error(`staging-smoke-alert: ${JSON.stringify(r)}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  main(process.argv.slice(2));
