// The release chain's deploy (#1343): dispatch deploy-hosted-platform.yml on
// main with GITHUB_TOKEN, find the one run that dispatch started, and wait
// for it. It fails closed: a dispatch it cannot match to exactly one run, or
// a run that is not a success, fails the chain.
//
// A reusable-workflow call cannot be used: a secret the caller does not pass
// resolves empty even when the called job's Environment has it, and the
// caller (a `uses:` job) cannot set an Environment (run 42109047045). A
// dispatched run is an ordinary run of the workflow, so every secret comes
// from its own job's Environment.
//
// The run is matched by event workflow_dispatch, actor github-actions[bot],
// branch main, created no earlier than the dispatch (minus a little clock
// skew) and a display title that is exactly
// `deploy-hosted-platform prod <tag> [<chain id>]`, which the workflow's
// run-name builds from its inputs. Zero matches by the
// find deadline, or more than one, fails.
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export type ExecResult = { code: number; stdout: string; stderr: string };
export type Exec = (cmd: string, args: string[]) => ExecResult;

const WORKFLOW = "deploy-hosted-platform.yml";
const BOT = "github-actions[bot]";
const FULL =
  "platform-db,auth-broker,directory-broker,provision-token,provisioner,dispatch,inventory,provisioning,zones,scheduler";
const TAG_RE = /^v\d{1,6}\.\d{1,6}\.\d{1,6}$/;
const CHAIN_RE = /^[A-Za-z0-9-]{1,40}$/;

type WorkflowRun = {
  id: number;
  status: string;
  conclusion: string | null;
  event?: string;
  display_title?: string;
  head_branch?: string;
  created_at?: string;
  html_url?: string;
  actor?: { login?: string } | null;
};

export type Outcome = { runId: number; url: string; conclusion: string };

export interface Opts {
  exec: Exec;
  repo: string;
  tag: string;
  chainId: string;
  now: () => number;
  sleep: (ms: number) => void;
  /** Called as soon as the run is found, before waiting for it. */
  onFound?: (runId: number, url: string) => void;
  skewMs?: number;
  findTimeoutMs?: number;
  waitTimeoutMs?: number;
  pollMs?: number;
}

const gh = (exec: Exec, args: string[]): string => {
  const r = exec("gh", args);
  if (r.code !== 0)
    throw new Error(
      `gh ${args.slice(0, 2).join(" ")}: ${r.stderr.trim() || `exit ${r.code}`}`,
    );
  return r.stdout;
};

export function dispatchAndWait(o: Opts): Outcome {
  if (!TAG_RE.test(o.tag)) throw new Error(`not a release tag: ${o.tag}`);
  if (!CHAIN_RE.test(o.chainId)) throw new Error("bad chain id");
  const skew = o.skewMs ?? 60_000;
  const findFor = o.findTimeoutMs ?? 5 * 60_000;
  const waitFor = o.waitTimeoutMs ?? 45 * 60_000;
  const poll = o.pollMs ?? 10_000;

  const t0 = o.now();
  gh(o.exec, [
    "workflow",
    "run",
    WORKFLOW,
    "--repo",
    o.repo,
    "--ref",
    "main",
    "-f",
    "env=prod",
    "-f",
    `tag=${o.tag}`,
    "-f",
    `targets=${FULL}`,
    "-f",
    "reason=",
    "-f",
    "verify_only=false",
    "-f",
    "require_newer=true",
    "-f",
    `chain_id=${o.chainId}`,
  ]);

  const since = o.now() - skew;
  // The run-name is exactly this (deploy-hosted-platform.yml): a wrong env or
  // tag in the title is not our run.
  const title = `deploy-hosted-platform prod ${o.tag} [${o.chainId}]`;
  const matches = (): WorkflowRun[] => {
    const out = JSON.parse(
      gh(o.exec, [
        "api",
        `repos/${o.repo}/actions/workflows/${WORKFLOW}/runs?event=workflow_dispatch&branch=main&per_page=100`,
      ]),
    ) as { workflow_runs?: WorkflowRun[] };
    return (out.workflow_runs ?? []).filter(
      (r) =>
        r.event === "workflow_dispatch" &&
        r.actor?.login === BOT &&
        r.head_branch === "main" &&
        Date.parse(r.created_at ?? "") >= since &&
        r.display_title === title,
    );
  };

  let found: WorkflowRun | undefined;
  while (!found) {
    const m = matches();
    if (m.length > 1)
      throw new Error(
        `${m.length} runs match chain id ${o.chainId}: refusing to guess`,
      );
    if (m[0]) found = m[0];
    else if (o.now() - t0 >= findFor)
      throw new Error(`no run for chain id ${o.chainId} within ${findFor} ms`);
    else o.sleep(poll);
  }
  const url =
    found.html_url ?? `https://github.com/${o.repo}/actions/runs/${found.id}`;
  o.onFound?.(found.id, url);

  const start = o.now();
  for (;;) {
    const r = JSON.parse(
      gh(o.exec, ["api", `repos/${o.repo}/actions/runs/${found.id}`]),
    ) as WorkflowRun;
    if (r.status === "completed") {
      if (r.conclusion !== "success")
        throw new Error(
          `deploy run ${found.id} concluded ${r.conclusion ?? "none"}: ${url}`,
        );
      return { runId: found.id, url, conclusion: "success" };
    }
    if (o.now() - start >= waitFor) {
      // Never leave a prod deploy running unwatched: cancel it, then fail.
      let did: string;
      try {
        gh(o.exec, [
          "api",
          "-X",
          "POST",
          `repos/${o.repo}/actions/runs/${found.id}/cancel`,
        ]);
        did = `cancelled the dispatched run ${url}`;
      } catch (e) {
        did = `could not cancel the dispatched run ${url} (${(e as Error).message})`;
      }
      throw new Error(
        `deploy run ${found.id} did not finish within ${waitFor} ms; ${did}`,
      );
    }
    o.sleep(poll);
  }
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
  const out = process.env.GITHUB_OUTPUT;
  const emit = (s: string) => {
    console.log(s);
    if (out) appendFileSync(out, `${s}\n`);
  };
  try {
    const r = dispatchAndWait({
      exec: realExec,
      repo: flag(argv, "repo"),
      tag: flag(argv, "tag"),
      chainId: flag(argv, "chain-id"),
      now: Date.now,
      sleep: (ms) =>
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
      onFound: (id, url) => {
        emit(`deploy_run=${id}`);
        emit(`deploy_url=${url}`);
      },
    });
    emit(`deploy_conclusion=${r.conclusion}`);
  } catch (e) {
    const msg = (e as Error).message.replace(/\s+/g, " ").slice(0, 300);
    console.error(`chain-dispatch: ${msg}`);
    if (out) appendFileSync(out, `deploy_note=${msg}\n`);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  main(process.argv.slice(2));
