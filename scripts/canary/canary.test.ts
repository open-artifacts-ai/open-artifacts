// The client canary's own contract (agy S7): the workflow's shape, the skip
// when a model key is missing, and the one-issue-per-client report. The end to
// end run against a local server is `run.ts --client pi --fake` (README).
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  CLIENT_IDS,
  CLIENTS,
  canaryPrompt,
  missingSecrets,
} from "./clients.ts";
import { type ClientResult, overall, summaryMarkdown } from "./lib.ts";
import { LABEL, readResults, report, titleFor } from "./report.ts";
import { inPty, markFailed, runCanary } from "./run.ts";

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
    const channel = wf.jobs.canary.env.CHANNEL as string;
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

  it("model keys reach only the key check and the canary step", () => {
    const steps = wf.jobs.canary.steps as {
      id?: string;
      name?: string;
      env?: object;
    }[];
    const withKeys = steps.filter((s) =>
      JSON.stringify(s.env ?? {}).includes("secrets."),
    );
    expect(withKeys.map((s) => s.id ?? s.name)).toEqual([
      "need",
      "Run the canary",
    ]);
    // Every secret a client needs is passed in.
    for (const c of Object.values(CLIENTS))
      for (const s of c.secrets)
        expect(workflowText).toContain(`${s}: \${{ secrets.${s} }}`);
  });

  it("every heavy step waits on the key check", () => {
    const steps = wf.jobs.canary.steps as {
      id?: string;
      if?: string;
      run?: string;
    }[];
    const heavy = steps.filter((s) =>
      /pnpm|run\.ts --client "\$CLIENT" --channel "\$CHANNEL" --out "\$RESULT"$/.test(
        s.run ?? "",
      ),
    );
    expect(heavy.length).toBeGreaterThanOrEqual(3);
    for (const s of heavy)
      expect(s.if).toBe("steps.need.outputs.run == 'true'");
  });
});

describe("a missing model key skips, never fails", () => {
  it("each client names the keys it needs", () => {
    for (const c of Object.values(CLIENTS)) {
      expect(c.secrets.length).toBeGreaterThan(0);
      expect(missingSecrets(c, {})).toEqual(c.secrets);
      expect(
        missingSecrets(c, Object.fromEntries(c.secrets.map((s) => [s, "x"]))),
      ).toEqual([]);
    }
  });

  it("runCanary skips with the secret to add, before it starts anything", async () => {
    const lines: string[] = [];
    const r = await runCanary({
      client: "codex",
      channel: "pinned",
      port: 0,
      env: NO_KEYS,
      log: (l) => lines.push(l),
    });
    expect(r.status).toBe("skip");
    expect(r.checks).toEqual([
      {
        check: "secrets",
        status: "skip",
        detail: "SKIPPED: add the repo secret OPENAI_API_KEY to run Codex",
      },
    ]);
    expect(summaryMarkdown(r)).toContain("### Codex (pinned): SKIPPED");
    expect(lines).toEqual([]);
  });

  it("--check says run=false, writes the skipped result and the summary, and exits 0", () => {
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
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(gho, "utf8")).toBe("run=false\n");
    expect(readFileSync(sum, "utf8")).toContain(
      "add the repo secret ANTHROPIC_API_KEY to run Claude Code",
    );
    expect((JSON.parse(readFileSync(out, "utf8")) as ClientResult).status).toBe(
      "skip",
    );
  });

  it("--check says run=true when the key is set, and writes nothing else", () => {
    const dir = mkdtempSync(join(tmpdir(), "canary-check-"));
    const out = join(dir, "r.json");
    const r = spawnSync(
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
      {
        encoding: "utf8",
        env: { ...NO_KEYS, ANTHROPIC_API_KEY: "placeholder" },
      },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe("run=true");
    expect(existsSync(out)).toBe(false);
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
    const p = canaryPrompt("canary-pi-abc");
    for (const s of [
      'title "canary-pi-abc"',
      "PING <word>",
      "PONG <word>",
      "HOLD <word>",
      "oa-canary-hold <word> 1",
      "oa-canary-hold <word> 2",
      "DONE <word>",
    ])
      expect(p).toContain(s);
  });
});

describe("one issue per client", () => {
  const res = (
    client: "claude" | "pi",
    status: ClientResult["status"],
  ): ClientResult => ({
    client,
    label: CLIENTS[client].label,
    channel: "pinned",
    version: "1.0.0",
    status,
    checks: [
      {
        check: "joins at start",
        status,
        detail: status === "fail" ? "not within 120 s" : "ok",
      },
    ],
  });
  const fakeGh = (open: { number: number; title: string }[]) => {
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

  it("a failure with no open issue opens one, labelled client-canary", () => {
    const { calls, gh } = fakeGh([]);
    const lines = report([res("pi", "fail")], { ...opts, gh });
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
      "number,title",
    ]);
    expect(calls[1]?.slice(0, 3)).toEqual(["label", "create", LABEL]);
    const create = calls[2] ?? [];
    expect(create.slice(0, 2)).toEqual(["issue", "create"]);
    expect(create).toContain(titleFor("Pi"));
    expect(create[create.indexOf("--label") + 1]).toBe(LABEL);
    const body = create[create.indexOf("--body") + 1];
    expect(body).toContain("https://github.test/run/1");
    expect(body).toContain("- joins at start: not within 120 s");
    expect(lines).toEqual([`pi: failed, opened "Client canary failing: Pi"`]);
  });

  it("a failure with an open issue comments on it; a pass closes it; a skip changes nothing", () => {
    const { calls, gh } = fakeGh([
      { number: 7, title: titleFor("Pi") },
      { number: 8, title: titleFor("Claude Code") },
    ]);
    const lines = report([res("pi", "fail"), res("claude", "pass")], {
      ...opts,
      gh,
    });
    expect(calls.map((c) => c.slice(0, 3).join(" "))).toEqual([
      "issue list --repo",
      `label create ${LABEL}`,
      "issue comment 7",
      "issue close 8",
    ]);
    expect(lines).toEqual([
      "pi: failed again, commented on #7",
      "claude: green, closed #8",
    ]);
    const skip = fakeGh([{ number: 7, title: titleFor("Pi") }]);
    expect(report([res("pi", "skip")], { ...opts, gh: skip.gh })).toEqual([
      "pi: skip, nothing to change",
    ]);
    expect(skip.calls).toHaveLength(1);
  });
});

describe("readResults", () => {
  it("reads one result per downloaded artifact folder, sorted by client", () => {
    const dir = mkdtempSync(join(tmpdir(), "canary-results-"));
    for (const id of ["pi", "claude"] as const) {
      mkdirSync(join(dir, `canary-${id}`));
      writeFileSync(
        join(dir, `canary-${id}`, `canary-${id}.json`),
        JSON.stringify(markFailed(id, "latest", "x")),
      );
    }
    expect(readResults(dir).map((r) => r.client)).toEqual(["claude", "pi"]);
  });
});
