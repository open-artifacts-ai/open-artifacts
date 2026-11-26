// The client canary's own contract (agy S7): the workflow's shape, the red
// result when a secret is missing, the mid-turn checks, and the
// one-issue-per-client report. The end to end run against a local server is
// `run.ts --client pi --fake --target local` (README).
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
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
import { hookMember, STAGING_URL, stagingOrigin } from "./hub.ts";
import {
  busVersionText,
  type ClientResult,
  overall,
  summaryMarkdown,
} from "./lib.ts";
import type { Mail } from "./probe.ts";
import { LABEL, readResults, report, titleFor, withMissing } from "./report.ts";
import {
  copyLogs,
  inPty,
  markFailed,
  missingDetail,
  nextTurnCheck,
  runCanary,
  type SteerProbe,
  steerCheck,
  targetOf,
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
    ]);
    for (const step of withKeys)
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
      "MISSING SECRET: add the repo secret ANTHROPIC_API_KEY and CANARY_RL_A_HOOK_KEY",
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
    channel = "pinned",
  ): ClientResult => ({
    client,
    label: CLIENTS[client].label,
    channel,
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

  it("a failure @-mentions the alert login and names the version as run", () => {
    const { calls, gh } = fakeGh([]);
    report(
      [{ ...res("pi", "fail"), versionAfter: "1.0.1", target: "staging" }],
      {
        ...opts,
        notify: "@owner-login",
        gh,
      },
    );
    const create = calls[2] ?? [];
    const body = create[create.indexOf("--body") + 1] ?? "";
    expect(
      body.startsWith(
        "@owner-login The client canary failed for Pi (pinned, 1.0.0, updated itself to 1.0.1 during the run, on staging)",
      ),
    ).toBe(true);
    expect(() =>
      report([res("pi", "fail")], { ...opts, notify: "not a login!", gh }),
    ).toThrow("OA_ALERT_GITHUB_LOGIN");
  });

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
    expect(create).toContain(titleFor("Pi", "pinned"));
    expect(create[create.indexOf("--label") + 1]).toBe(LABEL);
    const body = create[create.indexOf("--body") + 1];
    expect(body).toContain("https://github.test/run/1");
    expect(body).toContain("- joins at start: not within 120 s");
    expect(lines).toEqual([
      `pi: failed, opened "Client canary failing: Pi (pinned)"`,
    ]);
  });

  it("a failure with an open issue comments on it; a pass closes it; a skip changes nothing", () => {
    const { calls, gh } = fakeGh([
      { number: 7, title: titleFor("Pi", "pinned") },
      { number: 8, title: titleFor("Claude Code", "pinned") },
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
    const skip = fakeGh([{ number: 7, title: titleFor("Pi", "pinned") }]);
    expect(report([res("pi", "skip")], { ...opts, gh: skip.gh })).toEqual([
      "pi: skip, nothing to change",
    ]);
    expect(skip.calls).toHaveLength(1);
  });

  it("a pinned pass never closes a latest failure", () => {
    const { calls, gh } = fakeGh([
      { number: 9, title: titleFor("Pi", "latest") },
    ]);
    expect(report([res("pi", "pass", "pinned")], { ...opts, gh })).toEqual([
      "pi: pass, nothing to change",
    ]);
    expect(calls).toHaveLength(1);
    const latest = fakeGh([{ number: 9, title: titleFor("Pi", "latest") }]);
    expect(
      report([res("pi", "pass", "latest")], { ...opts, gh: latest.gh }),
    ).toEqual(["pi: green, closed #9"]);
  });

  it("a client with no result file counts as failed", () => {
    const all = withMissing([res("pi", "pass")], "latest");
    expect(all.map((r) => [r.client, r.status, r.channel])).toEqual([
      ["claude", "fail", "latest"],
      ["codex", "fail", "latest"],
      ["opencode", "fail", "latest"],
      ["pi", "pass", "pinned"],
    ]);
    expect(all[0]?.checks[0]?.detail).toContain("timed out or was cancelled");
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

describe("the mid-turn check decides on the order of replies", () => {
  /**
   * A stub probe for a client: it answers by the release files steerCheck
   * writes, as a real client would. "steers" answers PING at the first tool
   * boundary, before it has even started the second held command (the case a
   * snapshot of the hold files got wrong). "next turn" answers PING only once
   * the turn is over. "skips hold 2" sends DONE first and PONG after.
   */
  const stub = (
    signals: string,
    mode: "steers" | "next turn" | "skips hold 2",
  ): SteerProbe => {
    const mail: Mail[] = [];
    const frames: SteerProbe["frames"] = [];
    let word = "";
    let ping = "";
    let n = 0;
    const released = (k: number) =>
      existsSync(join(signals, `hold-${word}-${k}.release`));
    const put = (body: string) => {
      if (!mail.some((m) => m.body === body))
        mail.push({ from: "client", body, at: n++ });
    };
    // What the client has said by now, given what has been released.
    const tick = () => {
      if (!released(1)) return;
      if (mode === "steers") put(`PONG ${ping}`);
      if (mode === "skips hold 2") put(`DONE ${word}`);
      if (mode === "skips hold 2") put(`PONG ${ping}`);
      if (released(2)) put(`DONE ${word}`);
      if (released(2)) put(`PONG ${ping}`);
    };
    return {
      mail,
      frames,
      async send(_to: string, body: string) {
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
      async reply(text: string) {
        tick();
        const m = mail.find((x) => x.body.includes(text));
        if (!m) throw new Error(`no reply containing "${text}"`);
        return m;
      },
    } as SteerProbe;
  };
  const limits = { hold: 1000, reply: 0, late: 0 };
  const run = async (mode: Parameters<typeof stub>[1]) => {
    const signals = mkdtempSync(join(tmpdir(), "canary-steer-"));
    const steps: [string, string, string][] = [];
    await steerCheck(
      stub(signals, mode),
      "client",
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
});

describe("with no steer path, a mid-turn message must arrive at the start of the next turn", () => {
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
        mail.push({ from: "client", body, at: n++ });
    };
    return {
      mail,
      frames: [],
      async send(_to: string, body: string) {
        const hold = /HOLD (\w+)/.exec(body);
        if (hold) {
          word = hold[1] as string;
          writeFileSync(join(signals, `hold-${word}-1.started`), "");
        }
        const p = /PING (\w+)/.exec(body);
        if (p) ping = p[1] as string;
        return { type: "receipt", msg_id: `m${n++}`, state: "sent" };
      },
      async reply(text: string) {
        if (released(1) && mode === "steers") put(`PONG ${ping}`);
        if (released(2)) put(`DONE ${word}`);
        if (released(2) && mode === "next turn") put(`PONG ${ping}`);
        const m = mail.find((x) => x.body.includes(text));
        if (!m) throw new Error(`no reply containing "${text}"`);
        return m;
      },
    } as unknown as SteerProbe;
  };
  const run = async (mode: Parameters<typeof stub>[1]) => {
    const signals = mkdtempSync(join(tmpdir(), "canary-next-"));
    const steps: [string, string, string][] = [];
    await nextTurnCheck(
      stub(signals, mode),
      "client",
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
