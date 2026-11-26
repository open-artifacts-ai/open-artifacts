// After the canary jobs: one GitHub issue per client, labelled client-canary,
// as release-alert.yml keeps its blocker issue. A failed client opens its
// issue, or comments on the open one; a passing client closes it; a skipped
// client changes nothing.
//
//   node --experimental-strip-types scripts/canary/report.ts <results dir>
//
// Needs GH_TOKEN (issues: write), REPO and RUN (the run's URL) in the env. It
// reads only the canary's own result files; the text it writes holds the run
// URL, the client, its version and the check lines, never a log excerpt.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ClientResult } from "./lib.ts";

export const LABEL = "client-canary";
export const titleFor = (label: string) => `Client canary failing: ${label}`;

type Gh = (args: string[]) => string;
const realGh: Gh = (args) => execFileSync("gh", args, { encoding: "utf8" });

const failed = (r: ClientResult) =>
  r.checks
    .filter((c) => c.status === "fail")
    .map((c) => `- ${c.check}: ${c.detail}`)
    .join("\n");

/** Brings the issues in step with `results`; returns one line per client. */
export function report(
  results: ClientResult[],
  { repo, run, gh = realGh }: { repo: string; run: string; gh?: Gh },
): string[] {
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
    const title = titleFor(r.label);
    const n = find(title);
    const what = `${r.label} (${r.channel}${r.version ? `, ${r.version}` : ""})`;
    if (r.status === "fail") {
      const body = `The client canary failed for ${what}.\n\nRun: ${run}\n\n${failed(r)}`;
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

/** Every result file under `dir` (one folder per downloaded artifact). */
export function readResults(dir: string): ClientResult[] {
  const out: ClientResult[] = [];
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
  const { REPO, RUN } = process.env;
  if (!dir || !REPO || !RUN) {
    console.error("usage: REPO=owner/name RUN=<url> report.ts <results dir>");
    process.exit(2);
  }
  const results = readResults(dir);
  if (results.length === 0) {
    console.error(
      "::error::no canary results to report: every canary job failed before it wrote one",
    );
    process.exit(1);
  }
  for (const l of report(results, { repo: REPO, run: RUN })) console.log(l);
}
