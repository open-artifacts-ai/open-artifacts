// After the canary jobs: ONE GitHub issue per client (the approved plan),
// labelled client-canary, as release-alert.yml keeps its blocker issue. The
// channel (pinned or latest) and its result go in the issue: a failure opens
// the client's issue, or comments on the open one; a pass is recorded on it;
// the issue closes only once EVERY channel has passed since it opened, so a
// pinned pass never closes a latest failure. A skipped client changes
// nothing. A client with no result file (its job timed out or was
// cancelled), or a result file that does not parse, counts as failed.
//
//   node --experimental-strip-types scripts/canary/report.ts <results dir>
//
// Needs GH_TOKEN (issues: write), REPO, RUN (the run's URL) and CHANNEL in the
// env. NOTIFY (vars.OA_ALERT_GITHUB_LOGIN, as the staging smoke alert uses) is
// @-mentioned on each failure, so GitHub emails that person; empty skips it.
// The result files come from jobs that ran a client: every text from them is
// made inert (no markdown, HTML, @-mention, #-link or URL; capped; tokens
// blanked) before it reaches an issue or comment, and the client's name comes
// from clients.ts, never from the file.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CLIENT_IDS, CLIENTS, type ClientId } from "./clients.ts";
import {
  type CheckResult,
  type ClientResult,
  inert,
  type Status,
  versionText,
} from "./lib.ts";

export const LABEL = "client-canary";
export const CHANNELS = ["pinned", "latest"] as const;
export type Channel = (typeof CHANNELS)[number];
export const titleFor = (label: string) => `Client canary failing: ${label}`;

type Gh = (args: string[]) => string;
const realGh: Gh = (args) =>
  execFileSync("gh", args, { encoding: "utf8", timeout: 60_000 });

/** At most this many failed checks are listed in one comment. */
const MAX_LISTED = 10;

const failedLines = (r: ClientResult) => {
  const f = r.checks.filter((c) => c.status === "fail");
  return [
    ...f
      .slice(0, MAX_LISTED)
      .map((c) => `- ${inert(c.check, [], 60)}: ${inert(c.detail)}`),
    ...(f.length > MAX_LISTED
      ? [`- and ${f.length - MAX_LISTED} more: see the run`]
      : []),
  ].join("\n");
};

/** A GitHub login, as GitHub allows one. */
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

/** Each channel's last result since the issue opened; absent: not run since. */
export type IssueState = Partial<Record<Channel, "pass" | "fail">>;

const STATE_RE = /<!-- client-canary-state (\{[^<>\n]{0,200}\}) -->/;

/** The state the canary keeps in its issue's body; anything else reads as none. */
export function parseState(body: string | undefined): IssueState {
  const m = STATE_RE.exec(body ?? "");
  if (!m?.[1]) return {};
  try {
    const raw = JSON.parse(m[1]) as Record<string, unknown>;
    const out: IssueState = {};
    for (const ch of CHANNELS)
      if (raw[ch] === "pass" || raw[ch] === "fail") out[ch] = raw[ch];
    return out;
  } catch {
    return {};
  }
}

/** The issue body: one row per channel, and the state as a hidden line. */
export function issueBody(
  label: string,
  state: IssueState,
  run: string,
  mention: string,
): string {
  const row = (ch: Channel) =>
    `| ${ch} | ${state[ch] === "pass" ? "PASS" : state[ch] === "fail" ? "FAIL" : "not run since this opened"} |`;
  return [
    `${mention}The client canary found ${inert(label, [], 40)} broken.`,
    "",
    "This issue closes by itself once every channel has passed since it opened.",
    "",
    "| Channel | Last result |",
    "| --- | --- |",
    ...CHANNELS.map(row),
    "",
    `Last run: ${run}`,
    "",
    `<!-- client-canary-state ${JSON.stringify(state)} -->`,
  ].join("\n");
}

/** Brings the issues in step with `results` on `channel`; returns one line per client. */
export function report(
  results: ClientResult[],
  {
    repo,
    run,
    channel,
    notify = "",
    gh = realGh,
  }: {
    repo: string;
    run: string;
    channel: string;
    notify?: string;
    gh?: Gh;
  },
): string[] {
  if (!(CHANNELS as readonly string[]).includes(channel))
    throw new Error("CHANNEL must be pinned or latest");
  const ch = channel as Channel;
  if (!/^https:\/\/[^\s<>()]+$/.test(run))
    throw new Error("RUN must be the run's https URL");
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
      "number,title,body",
    ]),
  ) as { number: number; title: string; body?: string }[];
  const find = (t: string) => open.find((i) => i.title === t);
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
    const label = CLIENTS[r.client as ClientId]?.label ?? "an unknown client";
    const title = titleFor(label);
    const issue = find(title);
    const v = versionText(r);
    const what = inert(
      `${label} (${ch}${v ? `, ${v}` : ""}${r.target ? `, on ${r.target}` : ""})`,
      [],
      200,
    );
    if (r.status === "fail") {
      const state: IssueState = { ...parseState(issue?.body), [ch]: "fail" };
      const said = `${to}The client canary failed for ${what}.\n\nRun: ${run}\n\n${failedLines(r)}`;
      if (issue) {
        gh([
          "issue",
          "comment",
          String(issue.number),
          "--repo",
          repo,
          "--body",
          said,
        ]);
        gh([
          "issue",
          "edit",
          String(issue.number),
          "--repo",
          repo,
          "--body",
          issueBody(label, state, run, to),
        ]);
        out.push(`${r.client}: ${ch} failed, commented on #${issue.number}`);
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
          `${issueBody(label, state, run, to)}\n\n${said.slice(to.length)}`,
        ]);
        out.push(`${r.client}: ${ch} failed, opened "${title}"`);
      }
    } else if (r.status === "pass" && issue) {
      const state: IssueState = { ...parseState(issue.body), [ch]: "pass" };
      const all = CHANNELS.every((c) => state[c] === "pass");
      if (all) {
        gh([
          "issue",
          "close",
          String(issue.number),
          "--repo",
          repo,
          "--comment",
          `Green again on every channel: ${what} passed. Run: ${run}`,
        ]);
        out.push(
          `${r.client}: ${ch} passed, every channel green, closed #${issue.number}`,
        );
      } else {
        const wait = CHANNELS.filter((c) => state[c] !== "pass").join(" and ");
        gh([
          "issue",
          "comment",
          String(issue.number),
          "--repo",
          repo,
          "--body",
          `${what} passed. Still open until ${wait} passes too. Run: ${run}`,
        ]);
        gh([
          "issue",
          "edit",
          String(issue.number),
          "--repo",
          repo,
          "--body",
          issueBody(label, state, run, ""),
        ]);
        out.push(
          `${r.client}: ${ch} passed, #${issue.number} stays open for ${wait}`,
        );
      }
    } else out.push(`${r.client}: ${ch} ${r.status}, nothing to change`);
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

const STATUSES: readonly Status[] = ["pass", "fail", "skip"];

/**
 * A result file's content as a result, or undefined when it is not one. The
 * label comes from clients.ts, never from the file; texts are kept as data
 * and made inert where they are written.
 */
export function asResult(v: unknown): ClientResult | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const id = o.client as ClientId;
  if (!CLIENT_IDS.includes(id)) return undefined;
  if (!STATUSES.includes(o.status as Status)) return undefined;
  if (!Array.isArray(o.checks)) return undefined;
  const checks: CheckResult[] = [];
  for (const c of o.checks.slice(0, 50)) {
    const x = c as Record<string, unknown>;
    if (
      typeof x?.check !== "string" ||
      typeof x.detail !== "string" ||
      !STATUSES.includes(x.status as Status)
    )
      return undefined;
    checks.push({
      check: x.check,
      status: x.status as Status,
      detail: x.detail,
    });
  }
  const str = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : "");
  return {
    client: id,
    label: CLIENTS[id].label,
    channel: str("channel"),
    ...(str("target") ? { target: str("target") } : {}),
    version: str("version"),
    ...(str("versionAfter") ? { versionAfter: str("versionAfter") } : {}),
    // A failed check makes the client fail, whatever the file says.
    status: checks.some((c) => c.status === "fail")
      ? "fail"
      : (o.status as Status),
    checks,
  };
}

/** Every valid result file under `dir` (one folder per downloaded artifact), one per client. */
export function readResults(dir: string): ClientResult[] {
  const out = new Map<string, ClientResult>();
  if (!existsSync(dir)) return [];
  for (const e of readdirSync(dir, { withFileTypes: true, recursive: true }))
    if (e.isFile() && e.name.endsWith(".json")) {
      let r: ClientResult | undefined;
      try {
        r = asResult(
          JSON.parse(readFileSync(join(e.parentPath, e.name), "utf8")),
        );
      } catch {
        r = undefined;
      }
      // Two files for one client: a failure wins.
      if (r && (out.get(r.client)?.status !== "fail" || r.status === "fail"))
        out.set(r.client, r);
    }
  return [...out.values()].sort((a, b) => a.client.localeCompare(b.client));
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
    channel: CHANNEL,
    notify: NOTIFY ?? "",
  }))
    console.log(l);
}
