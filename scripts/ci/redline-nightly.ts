// The nightly red-line run (#1137): the latest release's own suite, once per
// release, with no session watching. `plan` decides whether tonight runs;
// `report` keeps one `blocker` issue open while the last nightly is red.
// Usage: node --experimental-strip-types scripts/ci/redline-nightly.ts plan --repo owner/name
//        node --experimental-strip-types scripts/ci/redline-nightly.ts report --repo owner/name --tag vX.Y.Z --result success --run <url>
// `plan` prints `run=true|false` and `tag=vX.Y.Z`. Needs GH_TOKEN. An API error
// throws, and the workflow files that as a blocker: a nightly never fails quietly.
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/** Staging's fleet canary follows the deployed release, and /healthz is public. */
export const STAGING_HEALTHZ =
  "https://canary.open-artifacts-staging.app/healthz";
/** One per release tag: this release already had its nightly. */
export const ranArtifact = (tag: string) => `redline-nightly-${tag}`;
const TITLE = "Nightly red-line";
const WORKFLOWS = ["redline-staging.yml", "redline-nightly.yml"] as const;
const BUSY = ["queued", "in_progress", "waiting", "requested", "pending"];

export type ExecResult = { code: number; stdout: string; stderr: string };
export type Exec = (cmd: string, args: string[]) => ExecResult;
type Run = {
  id: number;
  status: string;
  conclusion: string | null;
  display_title: string;
};
export type Plan = { run: boolean; tag: string; why: string };

function gh(exec: Exec, args: string[]): string {
  const r = exec("gh", args);
  if (r.code !== 0)
    throw new Error(
      `gh ${args.slice(0, 2).join(" ")}: ${r.stderr.trim() || `exit ${r.code}`}`,
    );
  return r.stdout;
}

const runsOf = (exec: Exec, repo: string, file: string): Run[] =>
  (
    JSON.parse(
      gh(exec, [
        "api",
        `repos/${repo}/actions/workflows/${file}/runs?per_page=30`,
      ]),
    ) as { workflow_runs: Run[] }
  ).workflow_runs;

/** Runs only for a release staging runs, no run has seen, and nothing in the way. */
export async function plan(o: {
  exec: Exec;
  repo: string;
  ownRun: number;
  stagingVersion: () => Promise<string>;
}): Promise<Plan> {
  const tag = (
    JSON.parse(gh(o.exec, ["api", `repos/${o.repo}/releases/latest`])) as {
      tag_name: string;
    }
  ).tag_name;
  if (!/^v\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(tag))
    throw new Error(`the latest release isn't vX.Y.Z: ${tag}`);
  const skip = (why: string): Plan => ({ run: false, tag, why });

  const [staging, nightly] = WORKFLOWS.map((f) =>
    runsOf(o.exec, o.repo, f),
  ) as [Run[], Run[]];
  const busy = [...staging, ...nightly].find(
    (r) => r.id !== o.ownRun && BUSY.includes(r.status),
  );
  if (busy) return skip(`run ${busy.id} is ${busy.status}`);

  const seen = staging.find(
    (r) =>
      r.display_title === `redline-staging ${tag}` &&
      r.conclusion !== "cancelled" &&
      r.conclusion !== "skipped",
  );
  if (seen) return skip(`candidate run ${seen.id} already covered ${tag}`);

  const ran = JSON.parse(
    gh(o.exec, [
      "api",
      `repos/${o.repo}/actions/artifacts?name=${ranArtifact(tag)}&per_page=1`,
    ]),
  ) as { total_count: number };
  if (ran.total_count > 0) return skip(`${tag} already had its nightly`);

  const version = await o.stagingVersion();
  if (`v${version}` !== tag) return skip(`staging runs ${version}, not ${tag}`);
  return { run: true, tag, why: `${tag} is new and on staging` };
}

export type Report =
  | { action: "none" }
  | { action: "closed"; issues: number[] }
  | { action: "refreshed"; issue: number }
  | { action: "opened" };

/** Red keeps one open issue, refreshed; green closes it. Never email: an issue only. */
export function report(o: {
  exec: Exec;
  repo: string;
  tag: string;
  result: string;
  run: string;
}): Report {
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
  ).filter((i) => i.title.startsWith(`${TITLE} `));

  if (o.result === "success") {
    for (const i of open)
      gh(o.exec, [
        "issue",
        "close",
        String(i.number),
        "--repo",
        o.repo,
        "--comment",
        `Green on ${o.tag}: ${o.run}`,
      ]);
    return open.length
      ? { action: "closed", issues: open.map((i) => i.number) }
      : { action: "none" };
  }

  const title = `${TITLE} failed: ${o.tag || "no release picked"}`;
  const body = [
    `The nightly red-line run ended with \`${o.result}\`.`,
    "",
    `Run: ${o.run}`,
    "",
    "It won't run again for this release. Read the run's `redline-report` artifact, fix the cause, and a new release gets its own nightly. A green nightly closes this issue.",
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
  gh(o.exec, [
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

async function main(argv: string[]) {
  const [mode] = argv;
  const repo = flag(argv, "repo");
  if ((mode !== "plan" && mode !== "report") || !repo)
    throw new Error(
      "usage: redline-nightly.ts <plan|report> --repo owner/name",
    );
  if (mode === "plan") {
    const p = await plan({
      exec: realExec,
      repo,
      ownRun: Number(process.env.GITHUB_RUN_ID),
      stagingVersion: async () => {
        const r = await fetch(STAGING_HEALTHZ, {
          signal: AbortSignal.timeout(15_000),
        });
        if (!r.ok) throw new Error(`staging /healthz answered ${r.status}`);
        return String(((await r.json()) as { version?: unknown }).version);
      },
    });
    console.error(`redline-nightly: run=${p.run} ${p.why}`);
    console.log(`run=${p.run}\ntag=${p.tag}`);
    return;
  }
  const r = report({
    exec: realExec,
    repo,
    tag: flag(argv, "tag"),
    result: flag(argv, "result"),
    run: flag(argv, "run"),
  });
  console.error(`redline-nightly: ${JSON.stringify(r)}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  await main(process.argv.slice(2));
