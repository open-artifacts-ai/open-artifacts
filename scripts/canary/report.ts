// After the canary jobs: one GitHub issue per client and channel (pinned or
// latest), labelled client-canary, as release-alert.yml keeps its blocker
// issue. A failed client opens its issue, or comments on the open one; a pass
// on the same channel closes it, so a pinned pass never closes a latest
// failure; a skipped client changes nothing. A client with no result file
// (its job timed out or was cancelled) counts as failed.
//
//   node --experimental-strip-types scripts/canary/report.ts <results dir>
//
// Needs GH_TOKEN (issues: write), REPO, RUN (the run's URL) and CHANNEL in the
// env. NOTIFY (vars.OA_ALERT_GITHUB_LOGIN, as the staging smoke alert uses) is
// @-mentioned on each failure, so GitHub emails that person; empty skips it. It
// reads only the canary's own result files; the text it writes holds the run
// URL, the client, its version and the check lines, never a log excerpt.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CLIENT_IDS, CLIENTS } from "./clients.ts";
import { type ClientResult, versionText } from "./lib.ts";

export const LABEL = "client-canary";
export const titleFor = (label: string, channel: string) =>
  `Client canary failing: ${label} (${channel})`;

type Gh = (args: string[]) => string;
const realGh: Gh = (args) =>
  execFileSync("gh", args, { encoding: "utf8", timeout: 60_000 });

const failed = (r: ClientResult) =>
  r.checks
    .filter((c) => c.status === "fail")
    .map((c) => `- ${c.check}: ${c.detail}`)
    .join("\n");

/** A GitHub login, as GitHub allows one. */
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

/** Brings the issues in step with `results`; returns one line per client. */
export function report(
  results: ClientResult[],
  {
    repo,
    run,
    notify = "",
    gh = realGh,
  }: { repo: string; run: string; notify?: string; gh?: Gh },
): string[] {
  const login = notify.trim().replace(/^@/, "");
  if (login && !LOGIN_RE.test(login))
    throw new Error(
      "OA_ALERT_GITHUB_LOGIN is set but is not a GitHub login; fix the repo variable",
    );
  const to = login ? `@${login} ` : "";
  const out: string[] = [];
  const open = JSON.parse(
    gh([
      "issue",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--label",
      LABEL,
      "--limit",
      "100",
      "--json",
      "number,title",
    ]),
  ) as { number: number; title: string }[];
  const find = (t: string) => open.find((i) => i.title === t)?.number;
  if (results.some((r) => r.status === "fail"))
    gh([
      "label",
      "create",
      LABEL,
      "--repo",
      repo,
      "--force",
      "--color",
      "B60205",
      "--description",
      "The scheduled client canary found a broken bus client",
    ]);
  for (const r of results) {
    const title = titleFor(r.label, r.channel);
    const n = find(title);
    const v = versionText(r);
    const what = `${r.label} (${r.channel}${v ? `, ${v}` : ""}${r.target ? `, on ${r.target}` : ""})`;
    if (r.status === "fail") {
      const body = `${to}The client canary failed for ${what}.\n\nRun: ${run}\n\n${failed(r)}`;
      if (n !== undefined) {
        gh(["issue", "comment", String(n), "--repo", repo, "--body", body]);
        out.push(`${r.client}: failed again, commented on #${n}`);
      } else {
        gh([
          "issue",
          "create",
          "--repo",
          repo,
          "--title",
          title,
          "--label",
          LABEL,
          "--body",
          body,
        ]);
        out.push(`${r.client}: failed, opened "${title}"`);
      }
    } else if (r.status === "pass" && n !== undefined) {
      gh([
        "issue",
        "close",
        String(n),
        "--repo",
        repo,
        "--comment",
        `Green again: ${what}. Run: ${run}`,
      ]);
      out.push(`${r.client}: green, closed #${n}`);
    } else out.push(`${r.client}: ${r.status}, nothing to change`);
  }
  return out;
}

/**
 * A failed result for each client in the matrix that wrote none: a job cut
 * off by its timeout, or cancelled, uploads nothing.
 */
export function withMissing(
  results: ClientResult[],
  channel: string,
): ClientResult[] {
  const have = new Set(results.map((r) => r.client));
  const missing = CLIENT_IDS.filter((id) => !have.has(id)).map(
    (id): ClientResult => ({
      client: id,
      label: CLIENTS[id].label,
      channel,
      version: "",
      status: "fail",
      checks: [
        {
          check: "run",
          status: "fail",
          detail:
            "the job wrote no result: it timed out or was cancelled. See the run",
        },
      ],
    }),
  );
  return [...results, ...missing].sort((a, b) =>
    a.client.localeCompare(b.client),
  );
}

/** Every result file under `dir` (one folder per downloaded artifact). */
export function readResults(dir: string): ClientResult[] {
  const out: ClientResult[] = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true, recursive: true }))
    if (e.isFile() && e.name.endsWith(".json"))
      out.push(
        JSON.parse(
          readFileSync(join(e.parentPath, e.name), "utf8"),
        ) as ClientResult,
      );
  return out.sort((a, b) => a.client.localeCompare(b.client));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2];
  const { REPO, RUN, CHANNEL, NOTIFY } = process.env;
  if (!dir || !REPO || !RUN || !CHANNEL) {
    console.error(
      "usage: REPO=owner/name RUN=<url> CHANNEL=pinned|latest report.ts <results dir>",
    );
    process.exit(2);
  }
  const results = withMissing(readResults(dir), CHANNEL);
  for (const l of report(results, {
    repo: REPO,
    run: RUN,
    notify: NOTIFY ?? "",
  }))
    console.log(l);
}
