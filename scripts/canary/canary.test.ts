// The client canary's own contract (agy S7): the workflow's shape, the red
// result when a secret is missing, the mid-turn checks, and the
// one-issue-per-client report. The end to end run against a local server is
// `run.ts --client pi --fake --target local` (README).
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  watch,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { TEST_PURGE_PREFIX } from "../../packages/shared/src/hosted/test-hooks.ts";
import {
  CLIENT_IDS,
  CLIENTS,
  canaryPrompt,
  MODEL_KEYS,
  missingSecrets,
  STAGING_SECRETS,
  steeringNote,
  withoutSecrets,
} from "./clients.ts";
import {
  type BusAgent,
  hookMember,
  STAGING_URL,
  stagingOrigin,
} from "./hub.ts";
import {
  busVersionText,
  type ClientResult,
  clean,
  DETAIL_MAX,
  inert,
  overall,
  runIdOf,
  summaryMarkdown,
} from "./lib.ts";
import { type Mail, type Peer, Probe } from "./probe.ts";
import {
  asResult,
  issueBody,
  LABEL,
  parseState,
  readResults,
  report,
  titleFor,
  withMissing,
} from "./report.ts";
import {
  cleanupAfter,
  copyLogs,
  inPty,
  markFailed,
  missingDetail,
  nextTurnCheck,
  runCanary,
  runNames,
  SCRATCH_DIR,
  STAGING_PURGE_PREFIX,
  type SteerProbe,
  steerCheck,
  targetOf,
  thisRunsAgent,
} from "./run.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const RUN = join(root, "scripts/canary/run.ts");
const workflowText = readFileSync(
  join(root, ".github/workflows/client-canary.yml"),
  "utf8",
);
// biome-ignore lint/suspicious/noExplicitAny: workflow YAML is untyped
const wf: any = parse(workflowText);
const NO_KEYS = { PATH: process.env.PATH ?? "" };

describe("client-canary.yml", () => {
  it("runs nightly, weekly and by hand, never on a pull request or a push", () => {
    expect(Object.keys(wf.on).sort()).toEqual([
      "schedule",
      "workflow_dispatch",
    ]);
    const crons = wf.on.schedule.map((s: { cron: string }) => s.cron);
    expect(crons).toContain("30 3 * * *");
    expect(crons).toContain("30 4 * * 1");
  });

  it("the weekly cron picks the latest releases; nightly and dispatch default to pinned", () => {
    // Workflow-wide: the report job keys its issues on it too.
    const channel = wf.env.CHANNEL as string;
    expect(channel).toContain(
      "github.event.schedule == '30 4 * * 1' && 'latest'",
    );
    expect(channel).toContain("'pinned'");
  });

  it("has one concurrency group, no default permissions, and a timeout on every job", () => {
    expect(wf.concurrency).toEqual({
      group: "client-canary",
      "cancel-in-progress": false,
    });
    expect(wf.permissions).toEqual({});
    for (const job of Object.values(wf.jobs) as {
      "timeout-minutes"?: number;
    }[])
      expect(job["timeout-minutes"]).toBeGreaterThan(0);
  });

  it("one canary job per client and one report job, far under the 180 job cap", () => {
    expect(wf.jobs.canary.strategy.matrix.client).toEqual(CLIENT_IDS);
    expect(wf.jobs.canary.strategy["fail-fast"]).toBe(false);
    expect(Object.keys(wf.jobs).sort()).toEqual(["canary", "report"]);
    expect(CLIENT_IDS.length + 1).toBeLessThanOrEqual(180);
  });

  it("the canary jobs read only; the report job alone writes issues and sees no model key", () => {
    expect(wf.jobs.canary.permissions).toEqual({ contents: "read" });
    expect(wf.jobs.report.permissions).toEqual({
      contents: "read",
      issues: "write",
    });
    expect(wf.jobs.report.if).toBe("always()");
    expect(JSON.stringify(wf.jobs.report)).not.toContain("secrets.");
  });

  it("targets staging, legs side by side, and alerts the owner's login", () => {
    expect(wf.env.CANARY_TARGET).toBe("staging");
    expect(wf.env.CANARY_STAGING_URL).toBe("${{ vars.CANARY_STAGING_URL }}");
    expect(wf.env.CANARY_STAGING_TEST_DOMAIN).toBe(
      "${{ vars.CANARY_STAGING_TEST_DOMAIN }}",
    );
    expect(wf.jobs.canary.strategy["max-parallel"]).toBeUndefined();
    expect(workflowText).not.toContain("@oa/server build");
    const reportStep = wf.jobs.report.steps.at(-1);
    expect(reportStep.env.NOTIFY).toBe("${{ vars.OA_ALERT_GITHUB_LOGIN }}");
  });

  it("model keys reach only the key check and the canary step, and only for their client", () => {
    const steps = wf.jobs.canary.steps as {
      id?: string;
      name?: string;
      env?: Record<string, string>;
    }[];
    const withKeys = steps.filter((s) =>
      JSON.stringify(s.env ?? {}).includes("secrets."),
    );
    expect(withKeys.map((s) => s.id ?? s.name)).toEqual([
      "need",
      "Run the canary",
      "Clean up credentials",
    ]);
    // The cleanup step gets the hook key alone: no model key.
    const cleanup = withKeys.at(-1);
    expect(Object.keys(cleanup?.env ?? {})).toEqual([...STAGING_SECRETS]);
    for (const step of withKeys.slice(0, 2))
      for (const key of MODEL_KEYS) {
        const expr = step.env?.[key] ?? "";
        const takers = CLIENT_IDS.filter((id) =>
          CLIENTS[id].secrets.includes(key),
        );
        expect(expr).toBe(
          `\${{ contains(fromJSON('${JSON.stringify(takers)}'), matrix.client) && secrets.${key} || '' }}`,
        );
      }
    for (const step of withKeys)
      for (const key of STAGING_SECRETS)
        expect(step.env?.[key]).toBe(`\${{ secrets.${key} }}`);
    expect(JSON.stringify(wf.env)).not.toContain("secrets.");
    expect(JSON.stringify(wf.jobs.canary.env)).not.toContain("secrets.");
  });

  it("a job cut off by its timeout still records a failed result and keeps its logs", () => {
    const steps = wf.jobs.canary.steps as {
      name?: string;
      if?: string;
      run?: string;
      with?: { name?: string };
    }[];
    const mark = steps.find((s) => s.run?.includes("--mark-failed"));
    expect(mark?.if).toBe("failure() || cancelled()");
    const logs = steps.find(
      (s) => s.with?.name === "logs-${{ matrix.client }}",
    );
    expect(logs?.if).toBe("failure() || cancelled()");
    // The report job downloads canary-*; the logs never match it.
    expect(wf.jobs.report.steps.at(-2).with.pattern).toBe("canary-*");
  });

  it("every way out cleans up credentials: an always() step after the uploads", () => {
    const steps = wf.jobs.canary.steps as {
      name?: string;
      if?: string;
      run?: string;
    }[];
    const i = steps.findIndex((s) => s.name === "Clean up credentials");
    expect(i).toBe(steps.length - 1);
    expect(steps[i]?.if).toBe("always()");
    expect(steps[i]?.run).toContain('run.ts --cleanup --client "$CLIENT"');
    expect(steps[i]?.run).toContain('rm -rf "$RUNNER_TEMP/canary-scratch"');
    // The canary's temp folder is the one that step deletes.
    expect(steps.find((s) => s.run?.includes("TMPDIR="))?.run).toContain(
      'echo "TMPDIR=$RUNNER_TEMP/canary-scratch" >> "$GITHUB_ENV"',
    );
    expect(wf.env.CANARY_RUN_ID).toBe(
      "gh-${{ github.run_id }}-${{ github.run_attempt }}",
    );
  });

  it("every heavy step waits on the key check", () => {
    const steps = wf.jobs.canary.steps as {
      id?: string;
      if?: string;
      run?: string;
    }[];
    const heavy = steps.filter((s) =>
      /pnpm|run\.ts --client "\$CLIENT" --channel "\$CHANNEL" --out "\$RESULT" --logs /.test(
        s.run ?? "",
      ),
    );
    expect(heavy.length).toBeGreaterThanOrEqual(3);
    for (const s of heavy)
      expect(s.if).toBe("steps.need.outputs.run == 'true'");
  });
});

describe("a missing secret fails, never skips", () => {
  it("each client names the keys it needs; staging adds the hook key", () => {
    for (const c of Object.values(CLIENTS)) {
      expect(c.secrets.length).toBeGreaterThan(0);
      expect(missingSecrets(c, {}, "local")).toEqual(c.secrets);
      expect(missingSecrets(c, {})).toEqual([...c.secrets, ...STAGING_SECRETS]);
      const all = Object.fromEntries(
        [...c.secrets, ...STAGING_SECRETS].map((s) => [s, "x"]),
      );
      expect(missingSecrets(c, all)).toEqual([]);
    }
  });

  it("runCanary fails with each secret to add, before it starts anything", async () => {
    const lines: string[] = [];
    const r = await runCanary({
      client: "codex",
      channel: "pinned",
      port: 0,
      env: { ...NO_KEYS, OPENAI_API_KEY: "placeholder" },
      log: (l) => lines.push(l),
    });
    expect(r.status).toBe("fail");
    expect(r.target).toBe("staging");
    expect(r.checks).toEqual([
      {
        check: "secrets",
        status: "fail",
        detail: missingDetail("Codex", "staging", [...STAGING_SECRETS]),
      },
    ]);
    expect(r.checks[0]?.detail).toContain(
      "MISSING SECRET: add the repo secret CANARY_RL_A_HOOK_KEY to run Codex on staging",
    );
    expect(summaryMarkdown(r)).toContain(
      "### Codex (pinned, on staging): FAIL",
    );
    // One line, naming the secrets; nothing was started.
    expect(lines).toEqual([
      `FAIL codex secrets: ${missingDetail("Codex", "staging", [...STAGING_SECRETS])}`,
    ]);
  });

  it("--check says run=false, writes the failed result and the summary, and exits 1", () => {
    const dir = mkdtempSync(join(tmpdir(), "canary-check-"));
    const out = join(dir, "r.json");
    const gho = join(dir, "output");
    const sum = join(dir, "summary");
    const r = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--no-warnings",
        RUN,
        "--check",
        "--client",
        "claude",
        "--out",
        out,
      ],
      {
        encoding: "utf8",
        env: { ...NO_KEYS, GITHUB_OUTPUT: gho, GITHUB_STEP_SUMMARY: sum },
      },
    );
    expect(r.status, r.stderr).toBe(1);
    expect(readFileSync(gho, "utf8")).toBe("run=false\n");
    expect(readFileSync(sum, "utf8")).toContain(
      "MISSING SECRET: add the repo secret ANTHROPIC\\_API\\_KEY and CANARY\\_RL\\_A\\_HOOK\\_KEY",
    );
    expect(r.stdout).toContain("::error::MISSING SECRET:");
    expect((JSON.parse(readFileSync(out, "utf8")) as ClientResult).status).toBe(
      "fail",
    );
  });

  it("--check says run=true when every secret is set, and writes nothing else", () => {
    const dir = mkdtempSync(join(tmpdir(), "canary-check-"));
    const out = join(dir, "r.json");
    const check = (env: Record<string, string>) =>
      spawnSync(
        process.execPath,
        [
          "--experimental-strip-types",
          "--no-warnings",
          RUN,
          "--check",
          "--client",
          "pi",
          "--out",
          out,
        ],
        { encoding: "utf8", env: { ...NO_KEYS, ...env } },
      );
    const staging = check({
      ANTHROPIC_API_KEY: "placeholder",
      CANARY_RL_A_HOOK_KEY: "placeholder",
    });
    expect(staging.status, staging.stderr).toBe(0);
    expect(staging.stdout.trim()).toBe("run=true");
    // Local mode (development only) needs just the model key.
    const local = check({
      ANTHROPIC_API_KEY: "placeholder",
      CANARY_TARGET: "local",
    });
    expect(local.status, local.stderr).toBe(0);
    expect(local.stdout.trim()).toBe("run=true");
    expect(existsSync(out)).toBe(false);
  });

  it("the target is staging unless asked; --hub means local", () => {
    expect(targetOf(undefined, {})).toBe("staging");
    expect(targetOf(undefined, { CANARY_TARGET: "local" })).toBe("local");
    expect(targetOf("local", { CANARY_TARGET: "staging" })).toBe("local");
    expect(targetOf(undefined, {}, "http://localhost:8790")).toBe("local");
    expect(() => targetOf("staging", {}, "http://localhost:8790")).toThrow(
      "--hub is for --target local",
    );
    expect(() => targetOf("prod", {})).toThrow("staging or local");
  });

  it("--mark-failed writes a failed result only when the canary wrote none", () => {
    const dir = mkdtempSync(join(tmpdir(), "canary-mark-"));
    const out = join(dir, "r.json");
    const mark = () =>
      spawnSync(
        process.execPath,
        [
          "--experimental-strip-types",
          "--no-warnings",
          RUN,
          "--client",
          "opencode",
          "--out",
          out,
          "--mark-failed",
          "the build broke",
        ],
        {
          encoding: "utf8",
          env: NO_KEYS,
        },
      );
    expect(mark().status).toBe(0);
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual(
      markFailed("opencode", "pinned", "the build broke"),
    );
    writeFileSync(out, '{"kept":true}');
    expect(mark().status).toBe(0);
    expect(readFileSync(out, "utf8")).toBe('{"kept":true}');
  });
});

describe("results", () => {
  it("the summary says the version as run, a self-update, and the steering expectation", () => {
    const r: ClientResult = {
      client: "claude",
      label: "Claude Code",
      channel: "latest",
      target: "staging",
      version: "2.1.332",
      versionAfter: "2.1.340",
      status: "pass",
      checks: [{ check: "install", status: "pass", detail: "ok" }],
      notes: [steeringNote(CLIENTS.claude)],
    };
    const md = summaryMarkdown(r);
    expect(md).toContain(
      "### Claude Code (latest, 2.1.332, updated itself to 2.1.340 during the run, on staging): PASS",
    );
    expect(md).toContain(
      "- Steering: Claude Code has no steer path in the daemon. A message sent mid-turn must arrive at the start of its next turn.",
    );
    expect(steeringNote(CLIENTS.pi)).toContain("must land in that same turn");
    expect(steeringNote(CLIENTS.opencode)).toContain("no steer path");
    expect(CLIENTS.codex.steering && CLIENTS.pi.steering).toBe(true);
    expect(CLIENTS.claude.steering || CLIENTS.opencode.steering).toBe(false);
  });

  it("fail beats pass; all skipped is skipped", () => {
    const c = (status: "pass" | "fail" | "skip") => ({
      check: "x",
      status,
      detail: "",
    });
    expect(overall([c("pass"), c("skip")])).toBe("pass");
    expect(overall([c("pass"), c("fail")])).toBe("fail");
    expect(overall([c("skip")])).toBe("skip");
  });

  it("a TUI runs in a pseudo-terminal, on Linux and macOS", () => {
    const l = {
      cmd: "claude",
      args: ["--model", "haiku", "it's a prompt"],
      pty: true,
    };
    expect(inPty(l, "linux")).toEqual({
      cmd: "script",
      args: [
        "-qefc",
        `'claude' '--model' 'haiku' 'it'\\''s a prompt'`,
        "/dev/null",
      ],
    });
    expect(inPty(l, "darwin")).toEqual({
      cmd: "script",
      args: ["-q", "/dev/null", "claude", "--model", "haiku", "it's a prompt"],
    });
    expect(inPty({ ...l, pty: false }, "linux")).toEqual({
      cmd: "claude",
      args: l.args,
    });
  });

  it("the prompt names the title and every marker the checks wait for", () => {
    const p = canaryPrompt("canary-pi-abc", "canary-probe-r1");
    for (const s of [
      'title "canary-pi-abc"',
      'send the bus agent "canary-probe-r1" exactly "PUBLISHED canary-pi-abc"',
      "PING <word>",
      "PONG <word>",
      "HOLD <word>",
      "oa-canary-hold <word> 1",
      "oa-canary-hold <word> 2",
      "DONE <word>",
    ])
      expect(p).toContain(s);
  });

  it("every client starts with no prompt and gets it on stdin, as one line", () => {
    const ctx = {
      home: "/h",
      work: "/w",
      mcpUrl: "http://x/mcp",
      tokenFile: "/h/t",
      model: "m",
      env: {},
    };
    const p = canaryPrompt("canary-x", "probe");
    for (const id of CLIENT_IDS) {
      const l = CLIENTS[id].start(ctx);
      expect(JSON.stringify(l.args), id).not.toContain("canary-x");
      const typed = CLIENTS[id].prompt(p);
      expect(typed, id).toContain("canary-x");
      // One submit: a TUI gets one line and Enter, Pi one JSON line.
      expect(typed.slice(0, -1), id).not.toMatch(/[\r\n]/);
    }
    expect(CLIENTS.claude.prompt(p).endsWith("\r")).toBe(true);
    expect(JSON.parse(CLIENTS.pi.prompt(p))).toEqual({
      type: "prompt",
      message: p,
    });
  });
});

describe("one issue per client", () => {
  const res = (
    client: "claude" | "pi",
    status: ClientResult["status"],
    detail = status === "fail" ? "not within 120 s" : "ok",
  ): ClientResult => ({
    client,
    label: CLIENTS[client].label,
    channel: "pinned",
    version: "1.0.0",
    status,
    checks: [{ check: "joins at start", status, detail }],
  });
  const fakeGh = (open: { number: number; title: string; body?: string }[]) => {
    const calls: string[][] = [];
    const gh = (args: string[]) => {
      calls.push(args);
      return args[0] === "issue" && args[1] === "list"
        ? JSON.stringify(open)
        : "";
    };
    return { calls, gh };
  };
  const opts = { repo: "o/r", run: "https://github.test/run/1" };
  const bodyOf = (c: string[] | undefined) =>
    c?.[(c?.indexOf("--body") ?? -2) + 1] ?? "";
  const stateBody = (st: Record<string, string>) =>
    issueBody("Pi", st as never, "https://github.test/run/0", "");

  it("the issue is keyed by client only; the channel and its result are in it", () => {
    expect(titleFor("Pi")).toBe("Client canary failing: Pi");
    const { calls, gh } = fakeGh([]);
    const lines = report([res("pi", "fail")], {
      ...opts,
      channel: "latest",
      gh,
    });
    expect(calls[0]).toEqual([
      "issue",
      "list",
      "--repo",
      "o/r",
      "--state",
      "open",
      "--label",
      LABEL,
      "--limit",
      "100",
      "--json",
      "number,title,body",
    ]);
    expect(calls[1]?.slice(0, 3)).toEqual(["label", "create", LABEL]);
    const create = calls[2] ?? [];
    expect(create.slice(0, 2)).toEqual(["issue", "create"]);
    expect(create[create.indexOf("--title") + 1]).toBe(titleFor("Pi"));
    expect(create[create.indexOf("--label") + 1]).toBe(LABEL);
    const body = bodyOf(create);
    expect(body).toContain("| latest | FAIL |");
    expect(body).toContain("| pinned | not run since this opened |");
    expect(body).toContain("Pi (latest, 1.0.0)");
    expect(body).toContain("- joins at start: not within 120 s");
    expect(parseState(body)).toEqual({ latest: "fail" });
    expect(lines).toEqual([`pi: latest failed, opened "${titleFor("Pi")}"`]);
  });

  it("a failure @-mentions the alert login and names the version as run", () => {
    const { calls, gh } = fakeGh([]);
    report(
      [{ ...res("pi", "fail"), versionAfter: "1.0.1", target: "staging" }],
      { ...opts, channel: "pinned", notify: "@owner-login", gh },
    );
    const body = bodyOf(calls[2]);
    expect(
      body.startsWith("@owner-login The client canary found Pi broken."),
    ).toBe(true);
    expect(body).toContain(
      "The client canary failed for Pi (pinned, 1.0.0, updated itself to 1.0.1 during the run, on staging).",
    );
    expect(() =>
      report([res("pi", "fail")], {
        ...opts,
        channel: "pinned",
        notify: "not a login!",
        gh,
      }),
    ).toThrow("OA_ALERT_GITHUB_LOGIN");
  });

  it("a pinned pass never closes a latest failure; it closes once every channel passed", () => {
    // Opened by a latest failure: a pinned pass is recorded, the issue stays.
    const open = [
      { number: 9, title: titleFor("Pi"), body: stateBody({ latest: "fail" }) },
    ];
    const one = fakeGh(open);
    expect(
      report([res("pi", "pass")], { ...opts, channel: "pinned", gh: one.gh }),
    ).toEqual(["pi: pinned passed, #9 stays open for latest"]);
    expect(one.calls.map((c) => c.slice(0, 3).join(" "))).toEqual([
      "issue list --repo",
      "issue comment 9",
      "issue edit 9",
    ]);
    const edited = bodyOf(one.calls[2]);
    expect(parseState(edited)).toEqual({ latest: "fail", pinned: "pass" });
    // Then latest passes: every channel has, so it closes.
    const two = fakeGh([{ number: 9, title: titleFor("Pi"), body: edited }]);
    expect(
      report([res("pi", "pass")], { ...opts, channel: "latest", gh: two.gh }),
    ).toEqual(["pi: latest passed, every channel green, closed #9"]);
    expect(two.calls[1]?.slice(0, 3)).toEqual(["issue", "close", "9"]);
  });

  it("a channel that has not run since the issue opened keeps it open", () => {
    const { calls, gh } = fakeGh([
      { number: 4, title: titleFor("Pi"), body: stateBody({ pinned: "fail" }) },
    ]);
    expect(
      report([res("pi", "pass")], { ...opts, channel: "pinned", gh }),
    ).toEqual(["pi: pinned passed, #4 stays open for latest"]);
    expect(calls.some((c) => c[1] === "close")).toBe(false);
  });

  it("a later failure on a channel that had passed records it again", () => {
    const { calls, gh } = fakeGh([
      {
        number: 5,
        title: titleFor("Pi"),
        body: stateBody({ pinned: "pass", latest: "fail" }),
      },
    ]);
    report([res("pi", "fail")], { ...opts, channel: "pinned", gh });
    expect(calls.map((c) => c.slice(0, 3).join(" "))).toEqual([
      "issue list --repo",
      `label create ${LABEL}`,
      "issue comment 5",
      "issue edit 5",
    ]);
    expect(parseState(bodyOf(calls[3]))).toEqual({
      pinned: "fail",
      latest: "fail",
    });
  });

  it("an issue body someone edited reads as no channel passed", () => {
    expect(parseState("hand written")).toEqual({});
    expect(parseState('<!-- client-canary-state {"pinned":"yes"} -->')).toEqual(
      {},
    );
    expect(parseState("<!-- client-canary-state {not json} -->")).toEqual({});
  });

  it("a skip changes nothing", () => {
    const skip = fakeGh([{ number: 7, title: titleFor("Pi") }]);
    expect(
      report([res("pi", "skip")], { ...opts, channel: "pinned", gh: skip.gh }),
    ).toEqual(["pi: pinned skip, nothing to change"]);
    expect(skip.calls).toHaveLength(1);
  });

  it("text from a client reaches the issue inert: no mention, link, HTML or markdown, capped, no token", () => {
    const evil =
      "@octocat see #1 and o/r#2 [x](https://evil.example) <img src=x onerror=alert(1)> **b** `c` | d oa_pat_ABCDEFGHJK sk-ant-0123456789abcdef\n## heading " +
      "y".repeat(500);
    const { calls, gh } = fakeGh([]);
    report([res("pi", "fail", evil)], { ...opts, channel: "pinned", gh });
    const body = bodyOf(calls[2]);
    expect(body).not.toMatch(
      /@octocat|#1\b|o\/r#2|<img|\*\*b\*\*|`c`|https:\/\/evil|oa_pat_ABC|sk-ant-0123/,
    );
    expect(body).not.toContain("\n## heading");
    expect(body).toContain("&lt;img");
    expect(body).toContain("\\[hidden\\]");
    expect(body).toContain("&#124;");
    // The client's line is capped.
    const line =
      body.split("\n").find((l) => l.startsWith("- joins at start")) ?? "";
    expect(line.length).toBeLessThan(400);
  });

  it("a result file names the client by id only: the label comes from clients.ts", () => {
    const r = asResult({
      client: "pi",
      label: "@octocat",
      status: "pass",
      channel: "pinned",
      version: "1",
      checks: [{ check: "x", status: "fail", detail: "d" }],
    });
    expect(r?.label).toBe("Pi");
    // A failed check fails the client, whatever the file says.
    expect(r?.status).toBe("fail");
    expect(asResult({ client: "../etc", status: "pass", checks: [] })).toBe(
      undefined,
    );
    expect(asResult({ client: "pi", status: "ok", checks: [] })).toBe(
      undefined,
    );
  });

  it("a client with no result file counts as failed", () => {
    const all = withMissing([res("pi", "pass")], "latest");
    expect(all.map((r) => [r.client, r.status])).toEqual([
      ["claude", "fail"],
      ["codex", "fail"],
      ["opencode", "fail"],
      ["pi", "pass"],
    ]);
    expect(all[0]?.checks[0]?.detail).toContain("timed out or was cancelled");
  });
});

describe("readResults", () => {
  it("reads one result per downloaded artifact folder, sorted by client; a bad file is no result", () => {
    const dir = mkdtempSync(join(tmpdir(), "canary-results-"));
    for (const id of ["pi", "claude"] as const) {
      mkdirSync(join(dir, `canary-${id}`));
      writeFileSync(
        join(dir, `canary-${id}`, `canary-${id}.json`),
        JSON.stringify(markFailed(id, "latest", "x")),
      );
    }
    mkdirSync(join(dir, "canary-codex"));
    writeFileSync(join(dir, "canary-codex", "canary-codex.json"), "{nope");
    expect(readResults(dir).map((r) => r.client)).toEqual(["claude", "pi"]);
  });
});

describe("sanitizing", () => {
  it("inert text has no HTML, markdown, mention, reference or URL left", () => {
    const t = inert(
      "<b>x</b> @a #12 a/b#3 GH-4 gh-5 [l](u) `c` *e* _u_ | p https://x.example www.x.example $m$ ~s~",
    );
    expect(t).not.toMatch(
      /<b>|@a|(?<!&)#12|b#3|gh-\d|\[l\]\(|`c`|\*e\*|_u_|\||https:\/\/|www\.x|\$m\$|~s~/i,
    );
    expect(t).toContain("&lt;b&gt;");
  });

  it("clean makes one line, drops terminal codes, caps the length and blanks tokens", () => {
    expect(clean("a\nb\u001b[31mred\u001b[0m\tc")).toBe("a bred c");
    expect(clean("x".repeat(400)).length).toBe(DETAIL_MAX);
    expect(clean("Bearer abcdefghijklmnop and ghp_" + "a".repeat(30))).toBe(
      "Bearer [hidden] and [hidden]",
    );
    expect(clean("value hunter22secret", ["hunter22secret"])).toBe(
      "value [hidden]",
    );
  });

  it("a check detail is cleaned before it is kept, logged or summarised", async () => {
    const lines: string[] = [];
    const r = await runCanary({
      client: "codex",
      channel: "pinned",
      port: 0,
      env: { ...NO_KEYS, OPENAI_API_KEY: "placeholder" },
      log: (l) => lines.push(l),
    });
    const md = summaryMarkdown({
      ...r,
      checks: [
        {
          check: "x",
          status: "fail",
          detail: "@someone <script> oa_machine_ABCDEFGHJKLMN",
        },
      ],
    });
    expect(md).not.toMatch(/@someone|<script>|oa_machine_ABC/);
  });
});

describe("bound to this run's session", () => {
  const agent = (over: Partial<BusAgent>): BusAgent => ({
    id: "a1",
    machineId: "m1",
    name: "canary-pi",
    kind: "pi",
    namespace: "n",
    state: "live",
    machineLabel: "host",
    ...over,
  });

  it("the session is the one live agent of the client's kind on this run's machine", () => {
    expect(
      thisRunsAgent(
        [
          agent({ id: "old", machineId: "m0" }),
          agent({ id: "probe", kind: "hermes" }),
          agent({ id: "gone", state: "away" }),
          agent({ id: "mine" }),
        ],
        "pi",
        "m1",
      )?.id,
    ).toBe("mine");
    // Another run's session, even of the same kind and name, never counts.
    expect(thisRunsAgent([agent({ machineId: "other" })], "pi", "m1")).toBe(
      undefined,
    );
    expect(() =>
      thisRunsAgent([agent({ id: "x" }), agent({ id: "y" })], "pi", "m1"),
    ).toThrow("cannot tell which");
  });

  it("each run has its own member, token label and staging prefix", () => {
    const a = runNames("gh-1-1", "pi", "staging");
    expect(a).toEqual({
      prefix: "t19-canary-gh-1-1-pi",
      email: "t19-canary-gh-1-1-pi@oa-redline-a.fyi",
      tokenLabel: "canary gh-1-1 pi",
    });
    expect(runNames("r2", "pi", "local").email).toBe(
      "canary-r2-pi@canary.test",
    );
    expect(() => runIdOf("Bad Id!")).toThrow("CANARY_RUN_ID");
    // Every run id it takes fits the purge hook's prefix, for every client.
    const longest = "a".repeat(20);
    expect(runIdOf(longest)).toBe(longest);
    expect(() => runIdOf(`${longest}b`)).toThrow("at most 20");
    for (const c of ["claude", "codex", "opencode", "pi"] as const)
      expect(
        TEST_PURGE_PREFIX.test(runNames(longest, c, "staging").prefix),
      ).toBe(true);
    expect(STAGING_PURGE_PREFIX.source).toBe(TEST_PURGE_PREFIX.source);
    expect(runIdOf("gh-12-3")).toBe("gh-12-3");
    expect(runIdOf(undefined)).toMatch(/^[a-f0-9]{10}$/);
  });

  it("a reply counts only from this run's session, by hub agent id and name, and exactly", () => {
    const me: Peer = { name: "canary-pi", id: "a1" };
    const m = (
      from: string,
      fromId: string | undefined,
      body: string,
    ): Mail => ({
      from,
      ...(fromId ? { fromId } : {}),
      body,
      at: 0,
    });
    expect(Probe.isFrom(m("canary-pi", "a1", "PONG x"), me)).toBe(true);
    expect(Probe.isFrom(m("canary-pi", "a0", "PONG x"), me)).toBe(false);
    expect(Probe.isFrom(m("canary-pi", undefined, "PONG x"), me)).toBe(false);
    expect(Probe.isFrom(m("other", "a1", "PONG x"), me)).toBe(false);
  });
});

describe("the held command waits on a signal", () => {
  const HOLD = join(root, "scripts/canary/hold.mjs");
  const start = (signals: string, ms: string) =>
    spawn(process.execPath, [HOLD, "abc", "1"], {
      env: { ...NO_KEYS, CANARY_SIGNALS: signals, CANARY_HOLD_MS: ms },
    });
  const outcome = (p: ReturnType<typeof spawn>) =>
    new Promise<{ code: number | null; out: string }>((resolve) => {
      let out = "";
      p.stdout?.on("data", (b: Buffer) => {
        out += b.toString();
      });
      p.on("exit", (code) => resolve({ code, out }));
    });

  it("prints released when its release file appears", async () => {
    const signals = mkdtempSync(join(tmpdir(), "canary-hold-"));
    const p = start(signals, "60000");
    const done = outcome(p);
    // Release once it says it started: a file event, not a timer.
    await new Promise<void>((resolve) => {
      const w = watch(signals, () => {
        if (existsSync(join(signals, "hold-abc-1.started"))) {
          w.close();
          resolve();
        }
      });
      if (existsSync(join(signals, "hold-abc-1.started"))) {
        w.close();
        resolve();
      }
    });
    writeFileSync(join(signals, "hold-abc-1.release"), "");
    expect(await done).toEqual({ code: 0, out: "released\n" });
  });

  it("says timed out, fails and leaves a marker when it is never released", async () => {
    const signals = mkdtempSync(join(tmpdir(), "canary-hold-"));
    expect(await outcome(start(signals, "50"))).toEqual({
      code: 1,
      out: "timed out\n",
    });
    expect(existsSync(join(signals, "hold-abc-1.timedout"))).toBe(true);
  });

  it("the harness and the fake hold with no sleep loop or polling timer", () => {
    for (const f of [
      "hold.mjs",
      "fake-pi.ts",
      "run.ts",
      "probe.ts",
      "hub.ts",
      "lib.ts",
    ]) {
      const text = readFileSync(join(root, "scripts/canary", f), "utf8");
      expect(text, f).not.toMatch(
        /sleep 0|setInterval\([^)]*\b(?:[1-9]\d{0,3})\)|everyMs|until\(/,
      );
    }
  });
});

describe("the mid-turn check decides on the order of replies", () => {
  const me: Peer = { name: "client", id: "a1" };
  /**
   * A stub probe for a client: it answers by the release files steerCheck
   * writes, as a real client would. "steers" answers PING at the first tool
   * boundary, before it has even started the second held command (the case a
   * snapshot of the hold files got wrong). "next turn" answers PING only once
   * the turn is over. "skips hold 2" sends DONE first and PONG after.
   * "impostor" is another session answering in the client's place.
   */
  const stub = (
    signals: string,
    mode: "steers" | "next turn" | "skips hold 2" | "impostor",
  ): SteerProbe => {
    const mail: Mail[] = [];
    const frames: SteerProbe["frames"] = [];
    let word = "";
    let ping = "";
    let n = 0;
    const released = (k: number) =>
      existsSync(join(signals, `hold-${word}-${k}.release`));
    const put = (body: string, fromId = me.id) => {
      if (!mail.some((m) => m.body === body))
        mail.push({ from: me.name, fromId, body, at: n++ });
    };
    // What the client has said by now, given what has been released.
    const tick = () => {
      if (!released(1)) return;
      if (mode === "steers") put(`PONG ${ping}`);
      if (mode === "impostor") put(`PONG ${ping}`, "someone-else");
      if (mode === "skips hold 2") put(`DONE ${word}`);
      if (mode === "skips hold 2") put(`PONG ${ping}`);
      if (released(2)) put(`DONE ${word}`);
      if (released(2) && mode !== "impostor") put(`PONG ${ping}`);
    };
    const probe = {
      mail,
      frames,
      onFrame: () => () => {},
      indexOf: (text: string, from?: Peer) =>
        mail.findIndex((m) => m.body === text && Probe.isFrom(m, from)),
      async send(_to: Peer, body: string) {
        const id = `m${n++}`;
        const hold = /HOLD (\w+)/.exec(body);
        if (hold) {
          word = hold[1] as string;
          writeFileSync(join(signals, `hold-${word}-1.started`), "");
        }
        const p = /PING (\w+)/.exec(body);
        if (p) {
          ping = p[1] as string;
          frames.push({
            type: "receipt_update",
            msg_id: id,
            state: "delivered",
          });
        }
        return { type: "receipt", msg_id: id, state: "sent" };
      },
      async reply(text: string, _ms: number, from?: Peer) {
        tick();
        const m = mail.find((x) => x.body === text && Probe.isFrom(x, from));
        if (!m) throw new Error(`no reply "${text}"`);
        return m;
      },
    };
    return probe as unknown as SteerProbe;
  };
  const limits = { hold: 1000, reply: 0, late: 0 };
  const run = async (mode: Parameters<typeof stub>[1], late = false) => {
    const signals = mkdtempSync(join(tmpdir(), "canary-steer-"));
    const steps: [string, string, string][] = [];
    const p = stub(signals, mode);
    if (late) {
      const send = p.send.bind(p);
      p.send = async (to, body) => {
        const r = await send(to, body);
        const h = /HOLD (\w+)/.exec(body);
        if (h) writeFileSync(join(signals, `hold-${h[1]}-1.timedout`), "");
        return r;
      };
    }
    await steerCheck(
      p,
      me,
      signals,
      (c, st, d) => steps.push([c, st, d]),
      limits,
    );
    expect(steps).toHaveLength(1);
    return steps[0] as [string, string, string];
  };

  it("passes a client that answers before it starts the second held command", async () => {
    const [check, status, detail] = await run("steers");
    expect([check, status]).toEqual(["mid-turn message", "pass"]);
    expect(detail).toContain("answered inside that turn");
  });

  it("fails a client that answers only in its next turn", async () => {
    const [, status, detail] = await run("next turn");
    expect(status).toBe("fail");
    expect(detail).toContain("answered only after that turn ended");
  });

  it("fails a client whose DONE came before the PONG", async () => {
    const [, status, detail] = await run("skips hold 2");
    expect(status).toBe("fail");
    expect(detail).toContain("answered only after that turn ended");
  });

  it("never takes another session's PONG for the client's", async () => {
    const [, status, detail] = await run("impostor");
    expect(status).toBe("fail");
    expect(detail).toContain("was never answered");
  });

  it("fails when a held command timed out", async () => {
    const [, status, detail] = await run("steers", true);
    expect(status).toBe("fail");
    expect(detail).toContain("timed out before its release");
  });
});

describe("with no steer path, a mid-turn message must arrive at the start of the next turn", () => {
  const me: Peer = { name: "client", id: "a1" };
  /** A stub client for nextTurnCheck: it answers by what has been released. */
  const stub = (signals: string, mode: "next turn" | "steers" | "drops") => {
    const mail: Mail[] = [];
    let word = "";
    let ping = "";
    let n = 0;
    const released = (k: number) =>
      existsSync(join(signals, `hold-${word}-${k}.release`));
    const put = (body: string) => {
      if (!mail.some((m) => m.body === body))
        mail.push({ from: me.name, fromId: me.id, body, at: n++ });
    };
    return {
      mail,
      frames: [],
      onFrame: () => () => {},
      indexOf: (text: string, from?: Peer) =>
        mail.findIndex((m) => m.body === text && Probe.isFrom(m, from)),
      async send(_to: Peer, body: string) {
        const hold = /HOLD (\w+)/.exec(body);
        if (hold) {
          word = hold[1] as string;
          writeFileSync(join(signals, `hold-${word}-1.started`), "");
        }
        const p = /PING (\w+)/.exec(body);
        if (p) ping = p[1] as string;
        return { type: "receipt", msg_id: `m${n++}`, state: "sent" };
      },
      async reply(text: string, _ms: number, from?: Peer) {
        if (released(1) && mode === "steers") put(`PONG ${ping}`);
        if (released(2)) put(`DONE ${word}`);
        if (released(2) && mode === "next turn") put(`PONG ${ping}`);
        const m = mail.find((x) => x.body === text && Probe.isFrom(x, from));
        if (!m) throw new Error(`no reply "${text}"`);
        return m;
      },
    } as unknown as SteerProbe;
  };
  const run = async (mode: Parameters<typeof stub>[1]) => {
    const signals = mkdtempSync(join(tmpdir(), "canary-next-"));
    const steps: [string, string, string][] = [];
    await nextTurnCheck(
      stub(signals, mode),
      me,
      signals,
      (c, st, d) => steps.push([c, st, d]),
      { hold: 1000, reply: 0 },
    );
    expect(steps).toHaveLength(1);
    return steps[0] as [string, string, string];
  };

  it("passes when PONG comes after DONE, and says there is no steering", async () => {
    const [check, status, detail] = await run("next turn");
    expect([check, status]).toEqual(["mid-turn message", "pass"]);
    expect(detail).toContain(
      "arrived at the start of the next turn (no steering)",
    );
  });

  it("passes, and says so, when the client steers after all", async () => {
    const [, status, detail] = await run("steers");
    expect(status).toBe("pass");
    expect(detail).toContain("it steers now");
  });

  it("fails when the message never arrives", async () => {
    const [, status, detail] = await run("drops");
    expect(status).toBe("fail");
    expect(detail).toContain("never arrived in the next turn");
  });
});

describe("credentials are cleaned up on every way out", () => {
  /** A bin dir with a stand-in `pi` that only says its version. */
  const fakeBin = () => {
    const d = mkdtempSync(join(tmpdir(), "canary-bin-"));
    writeFileSync(join(d, "pi"), "#!/bin/sh\necho 1.6.0\n");
    chmodSync(join(d, "pi"), 0o755);
    return d;
  };
  const scratchDirs = (tmp: string) =>
    readdirSync(tmp).filter((e) => /^oa-canary-(?!logs-)/.test(e));

  it("a failed run deletes its scratch HOME and keeps only blanked logs", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "canary-tmp-"));
    const was = process.env.TMPDIR;
    process.env.TMPDIR = tmp;
    try {
      const r = await runCanary({
        client: "pi",
        channel: "pinned",
        target: "local",
        hub: "http://127.0.0.1:9",
        runId: "t1",
        port: 0,
        clientBin: fakeBin(),
        env: { ...NO_KEYS, ANTHROPIC_API_KEY: "sk-ant-placeholder-0123456789" },
        log: () => {},
      });
      expect(r.status).toBe("fail");
      expect(scratchDirs(tmp)).toEqual([]);
      expect(JSON.stringify(r)).not.toContain("sk-ant-placeholder");
    } finally {
      if (was === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = was;
    }
  });

  it("SIGTERM mid-run cleans up, writes a failed result and exits 143", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "canary-tmp-"));
    const out = join(tmp, "r.json");
    // A hub that never answers the sign-in: the run is mid-flight when it asks.
    let asked: () => void = () => {};
    const askedP = new Promise<void>((r) => {
      asked = r;
    });
    const server = createServer(() => asked());
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    try {
      const p = spawn(
        process.execPath,
        [
          "--experimental-strip-types",
          "--no-warnings",
          RUN,
          "--client",
          "pi",
          "--target",
          "local",
          "--hub",
          `http://127.0.0.1:${port}`,
          "--client-bin",
          fakeBin(),
          "--out",
          out,
        ],
        {
          env: {
            ...NO_KEYS,
            TMPDIR: tmp,
            ANTHROPIC_API_KEY: "placeholder",
            CANARY_RUN_ID: "sig1",
          },
          stdio: "ignore",
        },
      );
      const exited = new Promise<number | null>((r) =>
        p.on("exit", (code) => r(code)),
      );
      await askedP;
      expect(scratchDirs(tmp).length).toBe(1);
      p.kill("SIGTERM");
      expect(await exited).toBe(143);
      expect(scratchDirs(tmp)).toEqual([]);
      const r = JSON.parse(readFileSync(out, "utf8")) as ClientResult;
      expect(r.status).toBe("fail");
      expect(r.checks.at(-1)?.detail).toContain("stopped by SIGTERM");
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  });

  it("--cleanup empties only the job's own temp folder and names no member without a key", async () => {
    const tmp = join(mkdtempSync(join(tmpdir(), "canary-tmp-")), SCRATCH_DIR);
    mkdirSync(join(tmp, "oa-canary-pi-x/home/.oa-bus"), { recursive: true });
    writeFileSync(join(tmp, "oa-canary-pi-x/home/.oa-bus/machine.json"), "{}");
    mkdirSync(join(tmp, "oa-canary-logs-r-pi"));
    const lines = await cleanupAfter("pi", "staging", {}, tmp);
    expect(readdirSync(tmp)).toEqual(["oa-canary-logs-r-pi"]);
    expect(lines).toEqual([
      `deleted 1 scratch folders under ${tmp}`,
      "no staging member to erase",
    ]);
    // A shared temp folder is never emptied: it may hold another run's folders.
    const shared = mkdtempSync(join(tmpdir(), "canary-shared-"));
    mkdirSync(join(shared, "oa-canary-server-live"));
    await cleanupAfter("pi", "local", {}, shared);
    expect(readdirSync(shared)).toEqual(["oa-canary-server-live"]);
  });
});

describe("logs", () => {
  it("a copied log has every model key and token blanked", () => {
    const from = mkdtempSync(join(tmpdir(), "canary-logs-"));
    const to = join(mkdtempSync(join(tmpdir(), "canary-logs-out-")), "logs");
    writeFileSync(
      join(from, "client.log"),
      "key sk-test-0123456789 token oa_pat_abcdefgh ok\n",
    );
    copyLogs(from, to, ["sk-test-0123456789", "oa_pat_abcdefgh"]);
    expect(readFileSync(join(to, "client.log"), "utf8")).toBe(
      "key [hidden] token [hidden] ok\n",
    );
  });

  it("a model key split by terminal codes or a line wrap is still blanked", () => {
    const from = mkdtempSync(join(tmpdir(), "canary-logs-"));
    const to = join(mkdtempSync(join(tmpdir(), "canary-logs-out-")), "logs");
    const key = "sk-test-0123456789abcdef";
    writeFileSync(
      join(from, "client.log"),
      `a sk-test-01\u001b[0m\u001b[2;5H2345\r\n6789abcdef b \u001b]0;t\u0007${key.slice(0, 9)}\n${key.slice(9)} c\n`,
    );
    copyLogs(from, to, [key]);
    const out = readFileSync(join(to, "client.log"), "utf8");
    expect(out).toBe("a [hidden] b [hidden] c\n");
  });

  it("a token shape is blanked even when its value was not known", () => {
    const from = mkdtempSync(join(tmpdir(), "canary-logs-"));
    const to = join(mkdtempSync(join(tmpdir(), "canary-logs-out-")), "logs");
    writeFileSync(
      join(from, "daemon.log"),
      "m oa_machine_7Hq2Kd9XzP3aBcDeFgHiJkLmNoPqRsTu p oa_pat_7Hq2Kd9XzP3aBcDe k sk-ant-api03-abcdefghijklmnop end\n",
    );
    copyLogs(from, to, []);
    expect(readFileSync(join(to, "daemon.log"), "utf8")).toBe(
      "m [hidden] p [hidden] k [hidden] end\n",
    );
  });

  it("npm and the server get no canary secret", () => {
    const env = withoutSecrets({
      PATH: "/bin",
      ANTHROPIC_API_KEY: "a",
      OPENAI_API_KEY: "b",
      CANARY_RL_A_HOOK_KEY: "c",
    });
    expect(env).toEqual({ PATH: "/bin" });
  });
});

describe("staging is rl-a, through its test hooks", () => {
  it("the hook key goes only to a bare https origin under open-artifacts-staging.app", () => {
    expect(stagingOrigin(undefined)).toBe(STAGING_URL);
    expect(stagingOrigin("")).toBe(STAGING_URL);
    expect(stagingOrigin("https://rl-b.open-artifacts-staging.app")).toBe(
      "https://rl-b.open-artifacts-staging.app",
    );
    for (const bad of [
      "http://rl-a.open-artifacts-staging.app",
      "https://rl-a.open-artifacts-staging.app/",
      "https://rl-a.open-artifacts-staging.app/x",
      "https://staging.open-artifacts.com",
      "https://a.b.open-artifacts-staging.app",
      "https://open-artifacts-staging.app.evil.example",
      "not a url",
    ])
      expect(() => stagingOrigin(bad), bad).toThrow("CANARY_STAGING_URL");
  });

  it("sends no hook call to an install that does not report test hooks on", async () => {
    const seen: string[] = [];
    const server = createServer((req, res) => {
      seen.push(`${req.method} ${req.url} ${req.headers.authorization ?? ""}`);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    try {
      await expect(
        hookMember(`http://127.0.0.1:${port}`, "k".repeat(40), "a@b.test"),
      ).rejects.toThrow("does not report test hooks on");
      expect(seen).toEqual(["GET /healthz "]);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it("the oa-bus as run says when it changed during the run", () => {
    const r = { busVersion: "oa-bus 0.247.0" } as ClientResult;
    expect(busVersionText(r)).toBe("oa-bus 0.247.0");
    expect(busVersionText({ ...r, busVersionAfter: "oa-bus 0.247.0" })).toBe(
      "oa-bus 0.247.0",
    );
    expect(busVersionText({ ...r, busVersionAfter: "oa-bus 0.248.0" })).toBe(
      "oa-bus 0.247.0, then oa-bus 0.248.0 as the run ended",
    );
  });
});
