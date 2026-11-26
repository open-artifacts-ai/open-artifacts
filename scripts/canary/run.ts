// The client canary (agy S7): one real bus client against a real Open
// Artifacts instance, through a real `oa-bus` built from this checkout.
//
//   node --experimental-strip-types scripts/canary/run.ts --client pi [options]
//
//   --client <id>       claude, codex, opencode or pi
//   --channel <c>       pinned (default) or latest: which client release to install
//   --target <t>        staging (the default, and what the schedule runs) or
//                       local (development only). CANARY_TARGET sets it too.
//                       Staging is rl-a and needs CANARY_RL_A_HOOK_KEY (README);
//                       CANARY_STAGING_URL names another staging test-hooks
//                       install, CANARY_STAGING_TEST_DOMAIN its TEST_DOMAIN.
//   --client-bin <dir>  use the client binary in <dir> instead of installing one
//                       (the tests put a fake client there)
//   --hub <origin>      local: a server that is already running (else one is started)
//   --port <n>          local: the port for the server it starts (default 8790)
//   --out <file>        write the result as JSON
//   --logs <dir>        on a failure, copy the logs here with keys and tokens blanked
//   --check             only decide: prints run=true or run=false (to
//                       $GITHUB_OUTPUT too). A missing secret writes a failed
//                       result to --out and exits 1
//   --mark-failed <why> write a failed result to --out unless one is there
//                       (a job that broke before the canary ran)
//   --fake              pi only: a stand-in pi (fake-pi.ts) that loads the real
//                       extension; no model, no key (the local proof and tests)
//   --fake-break steer  the fake answers a mid-turn message only after its turn,
//                       as a client that lost steering would (proves the check)
//   --fake-next-turn    with --fake-break steer: judge the fake as a client with
//                       no steer path (Claude Code, OpenCode), so the next-turn
//                       check runs end to end
//
// A client whose model key or staging secret is missing fails, by the
// secret's name: never a green skip. The exit code is 1 when a check failed.
// The job summary ($GITHUB_STEP_SUMMARY) gets one table per client. No secret
// or token value is ever printed.
import {
  type ChildProcess,
  execFileSync,
  spawn,
  spawnSync,
} from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  CLIENT_IDS,
  CLIENTS,
  type Client,
  type ClientId,
  type Ctx,
  canaryPrompt,
  type Launch,
  missingSecrets,
  STAGING_SECRETS,
  steeringNote,
  type Target,
  withoutSecrets,
} from "./clients.ts";
import {
  approveCode,
  approveProbeMachine,
  busAgents,
  createToken,
  hookMember,
  PATHS,
  publishedBy,
  purgeMembers,
  ROOT,
  STAGING_TEST_DOMAIN,
  signIn,
  stagingOrigin,
  startServer,
} from "./hub.ts";
import {
  busVersionText,
  type CheckResult,
  type ClientResult,
  marker,
  overall,
  type Session,
  summaryMarkdown,
  until,
  versionText,
} from "./lib.ts";
import { Probe } from "./probe.ts";

/** How long each step may take. A real model is slow; a fake one is not. */
export const LIMITS = {
  install: 180_000,
  join: 120_000,
  page: 180_000,
  reply: 180_000,
  hold: 120_000,
  /** One quick command (version, status, doctor, a first-run step). */
  command: 60_000,
};

export type Options = {
  client: ClientId;
  channel: "pinned" | "latest";
  /** Where it runs (default staging). */
  target?: Target;
  /** The fake only: run the next-turn check, as for a client with no steer path. */
  nextTurn?: boolean;
  clientBin?: string;
  hub?: string;
  port: number;
  out?: string;
  /** On a failure, the run's logs are copied here, model keys and tokens blanked. */
  logsOut?: string;
  env: Record<string, string | undefined>;
  log: (line: string) => void;
};

/** The hold command the prompt names: marks itself started, waits for its release file. */
const HOLD_SCRIPT = `#!/bin/sh
# oa-canary-hold <word> <n>: the canary's slow tool call (agy S7).
d="$CANARY_SIGNALS"
f="$d/hold-$1-$2"
: > "$f.started"
i=0
while [ ! -e "$f.release" ] && [ $i -lt 3000 ]; do i=$((i+1)); sleep 0.1; done
echo released
`;

type Proc = { child: ChildProcess; log: string; exited: () => boolean };

function startProc(
  cmd: string,
  args: string[],
  opts: {
    cwd: string;
    env: Record<string, string>;
    log: string;
    stdin?: string;
  },
): Proc {
  const fd = openSync(opts.log, "a");
  const child = spawn(cmd, args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: [opts.stdin === undefined ? "ignore" : "pipe", fd, fd],
    detached: true,
  });
  let gone = false;
  child.on("exit", () => {
    gone = true;
  });
  child.on("error", () => {
    gone = true;
  });
  if (opts.stdin !== undefined) child.stdin?.write(opts.stdin);
  return { child, log: opts.log, exited: () => gone };
}

/** SIGTERM to the process group, then SIGKILL if it is still up after 5 s. */
async function stopProc(p: Proc | undefined) {
  if (!p || p.exited() || p.child.pid === undefined) return;
  const pid = p.child.pid;
  const kill = (sig: NodeJS.Signals) => {
    try {
      process.kill(-pid, sig);
    } catch {}
  };
  kill("SIGTERM");
  await until("the process to stop", () => (p.exited() ? true : undefined), {
    ms: 5000,
    everyMs: 100,
  }).catch(() => kill("SIGKILL"));
}

/** A TUI in a pseudo-terminal: util-linux `script` on Linux, BSD `script` on macOS. */
export function inPty(
  l: Launch,
  platform = process.platform,
): { cmd: string; args: string[] } {
  if (!l.pty) return { cmd: l.cmd, args: l.args };
  const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
  if (platform === "darwin")
    return { cmd: "script", args: ["-q", "/dev/null", l.cmd, ...l.args] };
  return {
    cmd: "script",
    args: ["-qefc", [l.cmd, ...l.args].map(q).join(" "), "/dev/null"],
  };
}

/** The env a child gets: the scratch HOME, a short PATH, and only this client's secrets. */
function childEnv(
  client: Client,
  home: string,
  path: string[],
  parent: Record<string, string | undefined>,
  extra: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {
    HOME: home,
    PATH: path.join(":"),
    TERM: "xterm-256color",
    LANG: "C.UTF-8",
    CI: "1",
    ...extra,
  };
  for (const s of client.secrets) {
    const v = parent[s];
    if (v) env[s] = v;
  }
  return env;
}

/** Text with terminal colour codes taken out. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the escape is what it removes
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const USER_CODE = /\b([A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4})\b/;

/** The failed check a missing secret makes: it names each one to add. */
export const missingDetail = (
  label: string,
  target: Target,
  missing: string[],
): string =>
  `MISSING SECRET: add the repo secret ${missing.join(" and ")} to run ${label} on ${target}. Without it the canary is red, never skipped.`;

/** Runs one client through every check. Never throws: a failure is a failed check. */
export async function runCanary(o: Options): Promise<ClientResult> {
  const client = CLIENTS[o.client];
  const target: Target = o.target ?? "staging";
  const checks: CheckResult[] = [];
  let version = "";
  let versionAfter = "";
  let busVersion = "";
  let busVersionAfter = "";
  const result = (): ClientResult => {
    const r: ClientResult = {
      client: client.id,
      label: client.label,
      channel: o.channel,
      target,
      version,
      ...(versionAfter && versionAfter !== version ? { versionAfter } : {}),
      ...(busVersion ? { busVersion } : {}),
      ...(busVersionAfter && busVersionAfter !== busVersion
        ? { busVersionAfter }
        : {}),
      status: overall(checks),
      checks,
    };
    r.notes = [
      `Version as run: ${versionText(r) || "unknown (the client was not installed)"}`,
      ...(busVersion ? [`oa-bus as run: ${busVersionText(r)}`] : []),
      steeringNote(o.nextTurn ? { ...client, steering: false } : client),
    ];
    return r;
  };
  const missing = missingSecrets(client, o.env, target);
  if (missing.length > 0) {
    const detail = missingDetail(client.label, target, missing);
    checks.push({ check: "secrets", status: "fail", detail });
    o.log(`FAIL ${client.id} secrets: ${detail}`);
    return result();
  }

  const scratch = realpathSync(
    mkdtempSync(join(tmpdir(), `oa-canary-${client.id}-`)),
  );
  const home = join(scratch, "home");
  const work = join(scratch, "work");
  const bin = join(scratch, "bin");
  const signals = join(scratch, "signals");
  const logs = join(scratch, "logs");
  for (const d of [home, work, bin, signals, logs])
    mkdirSync(d, { recursive: true });
  const step = (
    check: string,
    status: CheckResult["status"],
    detail: string,
  ) => {
    checks.push({ check, status, detail });
    o.log(`${status.toUpperCase()} ${client.id} ${check}: ${detail}`);
  };
  let server: { origin: string; stop: () => Promise<void> } | undefined;
  let install: Proc | undefined;
  let daemon: Proc | undefined;
  let session: Proc | undefined;
  let probe: Probe | undefined;
  let clientVersion: (() => string) | undefined;
  let busVersionNow: (() => string) | undefined;
  /** Staging: the hook key and this run's member prefix, for the purge. */
  let purge: { origin: string; key: string; prefix: string } | undefined;
  /** Values a copied log must never hold. */
  const secrets = [...client.secrets, ...STAGING_SECRETS].flatMap(
    (k) => o.env[k] ?? [],
  );
  try {
    // 1. The client binary: installed from npm, or the one given.
    let clientBin = o.clientBin;
    if (!clientBin) {
      const prefix = join(scratch, "npm");
      const spec = `${client.npm}@${o.channel === "latest" ? "latest" : client.pinned}`;
      execFileSync(
        "npm",
        ["install", "-g", "--prefix", prefix, "--no-fund", "--no-audit", spec],
        {
          stdio: ["ignore", "ignore", "inherit"],
          // Install scripts never see a model key.
          env: withoutSecrets(o.env),
          timeout: LIMITS.install,
        },
      );
      clientBin = join(prefix, "bin");
    }
    const path = [clientBin, bin, "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
    symlinkSync(process.execPath, join(bin, "node"));
    const busEntry = join(ROOT, "packages/bus-cli/dist/index.js");
    if (!existsSync(busEntry))
      throw new Error(
        "oa-bus is not built: run pnpm --filter @open-artifacts/bus build",
      );
    writeFileSync(
      join(bin, "oa-bus"),
      `#!/bin/sh\nexec "${process.execPath}" "${busEntry}" "$@"\n`,
    );
    writeFileSync(join(bin, "oa-canary-hold"), HOLD_SCRIPT);
    chmodSync(join(bin, "oa-bus"), 0o755);
    chmodSync(join(bin, "oa-canary-hold"), 0o755);
    // Its version as run, read again at the end: some clients update themselves.
    const binDir = clientBin;
    clientVersion = () => {
      const v = spawnSync(join(binDir, client.bin), ["--version"], {
        env: childEnv(client, home, path, o.env),
        encoding: "utf8",
        timeout: LIMITS.command,
      });
      return (v.stdout || "").trim().split("\n")[0] ?? "";
    };
    version = clientVersion();
    o.log(`${client.id} version as run: ${version || "unknown"}`);

    // 2. The instance, a new member, and the member's token file. Staging:
    // signed in through rl-a's session hook, as its staging e2e does. Local:
    // the dev login.
    let member: Session;
    if (target === "staging") {
      const origin = stagingOrigin(o.env.CANARY_STAGING_URL);
      server = { origin, stop: async () => {} };
      const key = o.env.CANARY_RL_A_HOOK_KEY as string;
      // t19-: the only prefix the purge hook erases (T19's own sweep of old
      // runs takes a failed run's member too).
      const prefix = `t19-canary-${marker()}-${client.id}`;
      const domain = o.env.CANARY_STAGING_TEST_DOMAIN || STAGING_TEST_DOMAIN;
      member = await hookMember(origin, key, `${prefix}@${domain}`);
      purge = { origin, key, prefix };
    } else {
      server = o.hub
        ? { origin: o.hub, stop: async () => {} }
        : await startServer(o.port);
      member = await signIn(server.origin, `canary-${client.id}@canary.test`);
    }
    const pat = await createToken(member, `canary ${client.id}`);
    secrets.push(pat);
    const origin = server.origin;
    const tokenFile = join(home, ".open-artifacts/canary-pat-token");
    mkdirSync(join(home, ".open-artifacts"), { recursive: true, mode: 0o700 });
    writeFileSync(tokenFile, pat, { mode: 0o600 });
    const env = childEnv(client, home, path, o.env, {
      CANARY_SIGNALS: signals,
      // Codex's token form reads it by name (bearer_token_env_var).
      ...(client.id === "codex" ? { OA_TOKEN: pat } : {}),
    });
    const ctx: Ctx = {
      home,
      work,
      mcpUrl: `${origin}${PATHS.mcp}`,
      tokenFile,
      model: o.env[`CANARY_MODEL_${client.id.toUpperCase()}`] || client.model,
      env,
    };
    execFileSync("git", ["init", "-q"], {
      cwd: work,
      env,
      timeout: LIMITS.command,
    });
    for (const r of client.prepare(ctx).run ?? []) {
      const out = spawnSync(r.cmd, r.args, {
        cwd: work,
        env,
        input: r.stdin ?? "",
        encoding: "utf8",
        timeout: LIMITS.command,
      });
      if (out.status !== 0)
        throw new Error(`${r.cmd} ${r.args[0]} failed (exit ${out.status})`);
    }

    // 3. oa-bus install, approved by the member on the real approval page.
    // Instance-driven updates are off, so the oa-bus under test stays the one
    // built from this commit; its version is read now and again at the end.
    busVersionNow = () => {
      const v = spawnSync("oa-bus", ["--version"], {
        cwd: work,
        env,
        encoding: "utf8",
        timeout: LIMITS.command,
      });
      return (v.stdout || "").trim().split("\n")[0] ?? "";
    };
    busVersion = busVersionNow();
    o.log(`oa-bus version as run: ${busVersion || "unknown"}`);
    // auto-update off writes into the bus home, which a fresh home lacks.
    mkdirSync(join(home, ".oa-bus"), { recursive: true, mode: 0o700 });
    const off = spawnSync("oa-bus", ["auto-update", "off"], {
      cwd: work,
      env,
      encoding: "utf8",
      timeout: LIMITS.command,
    });
    if (off.status !== 0)
      throw new Error(
        `oa-bus auto-update off exited ${off.status}: the oa-bus under test could update itself from ${origin}`,
      );
    const installLog = join(logs, "install.log");
    install = startProc(
      "oa-bus",
      ["install", "--instance", origin, "--no-open", "--no-service"],
      {
        cwd: work,
        env,
        log: installLog,
      },
    );
    const code = await until(
      "oa-bus install to show a code",
      () => USER_CODE.exec(plain(readFileSync(installLog, "utf8")))?.[1],
      { ms: 60_000 },
    );
    await approveCode(member, code);
    await until(
      "oa-bus install to finish",
      () => (install?.exited() ? true : undefined),
      {
        ms: LIMITS.install,
      },
    );
    if (install.child.exitCode !== 0)
      throw new Error(
        `oa-bus install exited ${install.child.exitCode}: see ${installLog}`,
      );
    step(
      "install",
      "pass",
      `oa-bus install approved on ${origin} and wired ${client.label}`,
    );

    // 4. The daemon, run by hand (no service on a runner), then habits.
    daemon = startProc("oa-bus", ["daemon"], {
      cwd: work,
      env,
      log: join(logs, "daemon.log"),
    });
    await until(
      "the daemon to answer",
      () =>
        spawnSync("oa-bus", ["status"], { cwd: work, env, timeout: 10_000 })
          .status === 0
          ? true
          : undefined,
      { ms: 30_000 },
    );
    spawnSync("oa-bus", ["install", "--habits-project"], {
      cwd: work,
      env,
      encoding: "utf8",
      timeout: LIMITS.command,
    });
    const doctor = spawnSync("oa-bus", ["doctor"], {
      cwd: work,
      env,
      encoding: "utf8",
      timeout: LIMITS.command,
    });
    const line = `${doctor.stdout}\n${doctor.stderr}`
      .split("\n")
      .find((l) => l.startsWith("Habits:"));
    if (line?.startsWith("Habits: on")) step("habits", "pass", line);
    else
      step(
        "habits",
        "fail",
        `doctor says ${line ? `"${line}"` : "nothing about habits"}`,
      );

    // 5. The probe: a second machine on the same bus, approved the same way.
    const probeToken = await approveProbeMachine(member, "canary-probe");
    secrets.push(probeToken);
    probe = await Probe.open(origin, probeToken, "canary-probe");
    // Sessions a run before this one left on the list are never taken for this one.
    const before = new Set((await busAgents(member)).map((a) => a.name));

    // 6. The client, headless, with the canary's prompt.
    const title = `canary-${client.id}-${marker()}`;
    const launch = client.start(ctx, canaryPrompt(title));
    const run = inPty(launch);
    session = startProc(run.cmd, run.args, {
      cwd: work,
      env,
      log: join(logs, "client.log"),
      ...(launch.stdin !== undefined ? { stdin: launch.stdin } : {}),
    });

    // Joins at start.
    let name = "";
    try {
      const a = await until(
        `${client.label} on the bus`,
        async () =>
          (await busAgents(member)).find(
            (x) =>
              x.kind === client.kind &&
              x.state === "live" &&
              x.name !== probe?.name &&
              !before.has(x.name),
          ),
        { ms: LIMITS.join },
      );
      name = a.name;
      step(
        "joins at start",
        "pass",
        `on the agent list as ${a.name} (${a.kind})`,
      );
    } catch (e) {
      step("joins at start", "fail", (e as Error).message);
      return result();
    }

    // A page it publishes shows as that session.
    try {
      const agent = await until(
        "the canary page",
        () => publishedBy(member, title),
        { ms: LIMITS.page },
      );
      if (agent?.linked === true && agent.product === client.product)
        step(
          "page shows as the session",
          "pass",
          `${title} shows ${agent.name} (${agent.product})`,
        );
      else
        step(
          "page shows as the session",
          "fail",
          `${title} shows ${agent ? `${agent.name}, linked ${agent.linked === true}, product ${agent.product ?? "none"}` : "no agent"}`,
        );
    } catch (e) {
      step("page shows as the session", "fail", (e as Error).message);
    }

    // Receives a message and replies.
    const w = marker();
    try {
      await probe.send(name, `PING ${w}`);
      await probe.reply(`PONG ${w}`, LIMITS.reply);
      step("receives and replies", "pass", `PING ${w} answered with PONG ${w}`);
    } catch (e) {
      step("receives and replies", "fail", (e as Error).message);
    }

    // A message sent mid-turn: steered into that turn (Codex, Pi), or at the
    // start of the next turn (Claude Code, OpenCode: no steer path yet).
    if (client.steering && !o.nextTurn)
      await steerCheck(probe, name, signals, step);
    else await nextTurnCheck(probe, name, signals, step);
  } catch (e) {
    step("run", "fail", (e as Error).message);
  } finally {
    probe?.close();
    await stopProc(install);
    await stopProc(session);
    await stopProc(daemon);
    await server?.stop().catch(() => {});
    try {
      versionAfter = clientVersion?.() ?? "";
    } catch {}
    if (versionAfter && versionAfter !== version)
      o.log(`${client.id} updated itself during the run: ${versionAfter}`);
    try {
      busVersionAfter = busVersionNow?.() ?? "";
    } catch {}
    if (busVersionAfter && busVersionAfter !== busVersion)
      step(
        "oa-bus unchanged",
        "fail",
        `oa-bus was ${busVersion} as the run started and ${busVersionAfter} as it ended: the run did not test the oa-bus built from this commit`,
      );
    // A passing staging run erases its member, and its pages and machines with
    // it. A failed one keeps them to look at; T19's sweep of runs older than
    // two hours takes them later.
    if (purge && overall(checks) === "pass") {
      try {
        const n = await purgeMembers(purge.origin, purge.key, purge.prefix);
        o.log(`erased the run's member on ${purge.origin} (${n})`);
      } catch (e) {
        o.log(`could not erase the run's member: ${(e as Error).message}`);
      }
    }
    if (overall(checks) !== "fail") {
      try {
        rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
      } catch {}
    } else {
      o.log(`logs kept in ${logs}`);
      if (o.logsOut) copyLogs(logs, o.logsOut, secrets);
    }
  }
  return result();
}

/** What steerCheck needs from the probe (a stub stands in for it in the tests). */
export type SteerProbe = Pick<Probe, "send" | "reply" | "frames" | "mail">;

/**
 * HOLD <a> starts a turn that runs two held commands. While the first is held,
 * PING <b> is sent and delivered; then the first is released. The second is
 * released only after PONG <b> arrives, or once the wait for it runs out. So
 * the turn cannot end before that, and the order of replies decides: PONG <b>
 * before the second release and before DONE <a> means the message reached
 * that turn. It does not matter whether the client answered before or after
 * it started the second command.
 */
export async function steerCheck(
  probe: SteerProbe,
  name: string,
  signals: string,
  step: (check: string, status: CheckResult["status"], detail: string) => void,
  limits: { hold: number; reply: number; late: number } = {
    hold: LIMITS.hold,
    reply: LIMITS.reply,
    late: 60_000,
  },
) {
  const a = marker();
  const b = marker();
  const file = (n: number, what: string) =>
    join(signals, `hold-${a}-${n}.${what}`);
  const release = (n: number) => writeFileSync(file(n, "release"), "");
  const at = (text: string) =>
    probe.mail.findIndex((m) => m.body.includes(text));
  try {
    await probe.send(name, `HOLD ${a}`);
    await until(
      "the first held command",
      () => (existsSync(file(1, "started")) ? true : undefined),
      { ms: limits.hold },
    );
    const r = await probe.send(name, `PING ${b}`);
    await until(
      "the mid-turn message to be delivered",
      () =>
        probe.frames.some(
          (f) =>
            f.type === "receipt_update" &&
            f.msg_id === r.msg_id &&
            f.state === "delivered",
        ) || undefined,
      { ms: 60_000, everyMs: 100 },
    );
    release(1);
    const pong = await probe
      .reply(`PONG ${b}`, limits.reply)
      .catch(() => undefined);
    // Read before the release: whatever is in the mail now came inside the turn.
    const done = at(`DONE ${a}`);
    const inTurn = pong !== undefined && (done < 0 || at(`PONG ${b}`) < done);
    release(2);
    await probe.reply(`DONE ${a}`, limits.reply);
    if (inTurn)
      step(
        "mid-turn message",
        "pass",
        `PING ${b}, sent during HOLD ${a}, was answered inside that turn`,
      );
    else {
      // Answered after the turn ended: delivered, but not steered into it.
      const late =
        pong ??
        (await probe.reply(`PONG ${b}`, limits.late).catch(() => undefined));
      step(
        "mid-turn message",
        "fail",
        late
          ? `PING ${b}, sent during HOLD ${a}, was answered only after that turn ended`
          : `PING ${b}, sent during HOLD ${a}, was never answered`,
      );
    }
  } catch (e) {
    release(1);
    release(2);
    step("mid-turn message", "fail", (e as Error).message);
  }
}

/**
 * For a client with no steer path (Claude Code, OpenCode): HOLD <a> starts a
 * turn with two held commands; PING <b> is sent while the first is held, then
 * both are released. The message must arrive at the start of the next turn:
 * PONG <b> comes after DONE <a>. A PONG before DONE means the client steers
 * now, which passes and says so. No PONG at all fails.
 */
export async function nextTurnCheck(
  probe: SteerProbe,
  name: string,
  signals: string,
  step: (check: string, status: CheckResult["status"], detail: string) => void,
  limits: { hold: number; reply: number } = {
    hold: LIMITS.hold,
    reply: LIMITS.reply,
  },
) {
  const a = marker();
  const b = marker();
  const file = (n: number, what: string) =>
    join(signals, `hold-${a}-${n}.${what}`);
  const release = (n: number) => writeFileSync(file(n, "release"), "");
  const at = (text: string) =>
    probe.mail.findIndex((m) => m.body.includes(text));
  try {
    await probe.send(name, `HOLD ${a}`);
    await until(
      "the first held command",
      () => (existsSync(file(1, "started")) ? true : undefined),
      { ms: limits.hold },
    );
    await probe.send(name, `PING ${b}`);
    release(1);
    release(2);
    await probe.reply(`DONE ${a}`, limits.reply);
    const pong = await probe
      .reply(`PONG ${b}`, limits.reply)
      .catch(() => undefined);
    if (!pong)
      step(
        "mid-turn message",
        "fail",
        `PING ${b}, sent during HOLD ${a}, never arrived in the next turn`,
      );
    else if (at(`PONG ${b}`) > at(`DONE ${a}`))
      step(
        "mid-turn message",
        "pass",
        `PING ${b}, sent during HOLD ${a}, arrived at the start of the next turn (no steering)`,
      );
    else
      step(
        "mid-turn message",
        "pass",
        `PING ${b}, sent during HOLD ${a}, was answered inside that turn: it steers now, so set steering in clients.ts`,
      );
  } catch (e) {
    release(1);
    release(2);
    step("mid-turn message", "fail", (e as Error).message);
  }
}

/** Token shapes blanked even when their value was not known: machine and personal tokens, API keys. */
const TOKEN_SHAPES = [
  /\boa_(?:machine|pat)_[1-9A-HJ-NP-Za-km-z]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
];

/** Copies each log to `to`, with every value in `secrets` and every token shape blanked. */
export function copyLogs(from: string, to: string, secrets: string[]) {
  mkdirSync(to, { recursive: true });
  const blank = secrets.filter((v) => v.length >= 8);
  for (const f of readdirSync(from)) {
    let text = readFileSync(join(from, f), "utf8");
    for (const v of blank) text = text.replaceAll(v, "[hidden]");
    for (const re of TOKEN_SHAPES) text = text.replace(re, "[hidden]");
    writeFileSync(join(to, f), text);
  }
}

/** A failed result for a job that broke before the canary could run. */
export function markFailed(
  id: ClientId,
  channel: string,
  why: string,
): ClientResult {
  const checks: CheckResult[] = [{ check: "run", status: "fail", detail: why }];
  return {
    client: id,
    label: CLIENTS[id].label,
    channel,
    version: "",
    status: "fail",
    checks,
  };
}

/** --target, else CANARY_TARGET, else staging; --hub means local. */
export function targetOf(
  flag: string | undefined,
  env: Record<string, string | undefined>,
  hub?: string,
): Target {
  const t = flag ?? env.CANARY_TARGET ?? (hub ? "local" : "staging");
  if (t !== "staging" && t !== "local")
    throw new Error("--target must be staging or local");
  if (hub && t !== "local") throw new Error("--hub is for --target local");
  return t;
}

/** A bin dir whose `pi` is fake-pi.ts, run by this same node. */
export function fakePiBin(brk?: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "oa-canary-fake-")));
  const entry = new URL("./fake-pi.ts", import.meta.url).pathname;
  writeFileSync(
    join(dir, "pi"),
    `#!/bin/sh\n${brk ? `CANARY_FAKE_BREAK=${JSON.stringify(brk)} ` : ""}exec "${process.execPath}" --experimental-strip-types --no-warnings "${entry}" "$@"\n`,
  );
  chmodSync(join(dir, "pi"), 0o755);
  return dir;
}

async function main() {
  const { values } = parseArgs({
    options: {
      client: { type: "string" },
      channel: { type: "string", default: "pinned" },
      target: { type: "string" },
      "client-bin": { type: "string" },
      hub: { type: "string" },
      port: { type: "string", default: "8790" },
      out: { type: "string" },
      logs: { type: "string" },
      fake: { type: "boolean", default: false },
      "fake-break": { type: "string" },
      "fake-next-turn": { type: "boolean", default: false },
      check: { type: "boolean", default: false },
      "mark-failed": { type: "string" },
    },
  });
  const id = values.client as ClientId;
  if (!CLIENT_IDS.includes(id)) {
    console.error(`--client must be one of ${CLIENT_IDS.join(", ")}`);
    process.exit(2);
  }
  if (values.channel !== "pinned" && values.channel !== "latest") {
    console.error("--channel must be pinned or latest");
    process.exit(2);
  }
  const channel = values.channel;
  let target: Target;
  try {
    target = targetOf(values.target, process.env, values.hub);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(2);
  }
  if (values["mark-failed"] !== undefined) {
    if (!values.out) throw new Error("--mark-failed needs --out");
    if (!existsSync(values.out))
      writeFileSync(
        values.out,
        `${JSON.stringify(markFailed(id, channel, values["mark-failed"]), null, 2)}\n`,
      );
    return;
  }
  if (values.check) {
    const missing = missingSecrets(CLIENTS[id], process.env, target);
    const go = missing.length === 0;
    console.log(`run=${go}`);
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(process.env.GITHUB_OUTPUT, `run=${go}\n`);
    if (!go) {
      const r = await runCanary({
        client: id,
        channel,
        target,
        port: 0,
        env: process.env,
        log: () => {},
      });
      const md = summaryMarkdown(r);
      console.log(md);
      // The workflow's error line names the secret on the run page too.
      console.log(
        `::error::${missingDetail(CLIENTS[id].label, target, missing)}`,
      );
      if (process.env.GITHUB_STEP_SUMMARY)
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
      if (values.out)
        writeFileSync(values.out, `${JSON.stringify(r, null, 2)}\n`);
      process.exit(1);
    }
    return;
  }
  if (values.fake && id !== "pi") {
    console.error("--fake is for pi only");
    process.exit(2);
  }
  const fakeDir = values.fake ? fakePiBin(values["fake-break"]) : undefined;
  const r = await runCanary({
    client: id,
    channel,
    target,
    port: Number(values.port),
    // The fake needs no key: a placeholder stands in, never sent anywhere.
    env: values.fake
      ? { ...process.env, ANTHROPIC_API_KEY: "fake-no-model" }
      : process.env,
    log: (l) => console.log(l),
    ...(values.fake && values["fake-next-turn"] ? { nextTurn: true } : {}),
    ...(fakeDir ? { clientBin: fakeDir } : {}),
    ...(values["client-bin"] ? { clientBin: values["client-bin"] } : {}),
    ...(values.hub ? { hub: values.hub } : {}),
    ...(values.logs ? { logsOut: values.logs } : {}),
  });
  const md = summaryMarkdown(r);
  console.log(md);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
  if (values.out) writeFileSync(values.out, `${JSON.stringify(r, null, 2)}\n`);
  process.exit(r.status === "fail" ? 1 : 0);
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) ===
    realpathSync(new URL(import.meta.url).pathname)
)
  await main();
