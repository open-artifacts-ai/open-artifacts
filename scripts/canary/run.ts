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
//   --cleanup           only clean up after a run that was cut off: erase this
//                       run's staging member (CANARY_RUN_ID) and delete every
//                       oa-canary scratch folder under the temp folder
//
// Each run has its own id (CANARY_RUN_ID, else a random one) in its member's
// address, its token's label and its page title. Every check is bound to this
// run's session: its machine (the one this run approved), its hub agent id,
// and its name. Credentials (the token, the bus home and machine file, the
// scratch HOME) are deleted on every way out: a pass, a failure, a timeout,
// SIGINT, SIGTERM or SIGHUP. A staging member is erased each time; a local
// run revokes its token and machines.
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
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { shortSocketDir } from "../../packages/bus-adapter-claude-code/src/socket-path.ts";
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
  type BusAgent,
  busAgents,
  busMachines,
  createToken,
  hookMember,
  PATHS,
  publishedBy,
  purgeMembers,
  ROOT,
  revokeMachine,
  revokeToken,
  STAGING_TEST_DOMAIN,
  signIn,
  stagingOrigin,
  startServer,
} from "./hub.ts";
import {
  busVersionText,
  type CheckResult,
  type ClientResult,
  clean,
  marker,
  onExit,
  onFiles,
  overall,
  redact,
  redactLog,
  runIdOf,
  type Session,
  summaryMarkdown,
  versionText,
  waitFor,
} from "./lib.ts";
import { type Peer, Probe } from "./probe.ts";

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

/** How long one held command waits for its release before it says "timed out". */
export const HOLD_MS = 300_000;

export type Options = {
  client: ClientId;
  channel: "pinned" | "latest";
  /** Where it runs (default staging). */
  target?: Target;
  /** This run's id (default: CANARY_RUN_ID, else a new one). */
  runId?: string;
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
  /**
   * A signal (SIGINT, SIGTERM, SIGHUP) stopped the run: called with the failed
   * result once every credential is cleaned up, then the process exits.
   * Default: write nothing and exit.
   */
  onSignal?: (r: ClientResult, signal: NodeJS.Signals) => void;
};

/** The hold command the prompt names: hold.mjs, run by this same node. */
const holdScript = () =>
  `#!/bin/sh\nexec "${process.execPath}" "${new URL("./hold.mjs", import.meta.url).pathname}" "$@"\n`;

type Proc = {
  child: ChildProcess;
  log: string;
  exited: () => boolean;
  /** Everything it printed so far (stdout and stderr), read from `log`. */
  output: () => string;
};

function startProc(
  cmd: string,
  args: string[],
  opts: {
    cwd: string;
    env: Record<string, string>;
    log: string;
    stdin?: boolean;
  },
): Proc {
  const fd = openSync(opts.log, "a");
  // Straight to the log file: the canary's blocking steps (spawnSync) must
  // never leave a client or the daemon stuck on a full pipe. Waits watch the
  // file instead.
  const child = spawn(cmd, args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: [opts.stdin ? "pipe" : "ignore", fd, fd],
    detached: true,
  });
  let gone = false;
  child.on("exit", () => {
    gone = true;
  });
  child.on("error", () => {
    gone = true;
  });
  // A session that exits early must not crash the run on a write to its stdin.
  child.stdin?.on("error", () => {});
  return {
    child,
    log: opts.log,
    exited: () => gone,
    output: () => readFileSync(opts.log, "utf8"),
  };
}

/** SIGTERM to the process group, then SIGKILL if it has not exited 5 s later. */
async function stopProc(p: Proc | undefined) {
  if (!p || p.exited() || p.child.pid === undefined) return;
  const pid = p.child.pid;
  const kill = (sig: NodeJS.Signals) => {
    try {
      process.kill(-pid, sig);
    } catch {}
  };
  kill("SIGTERM");
  await waitFor("the process to stop", () => (p.exited() ? true : undefined), {
    ms: 5000,
    on: [onExit(p.child)],
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

/** The purge hook's prefix rule (packages/shared TEST_PURGE_PREFIX). */
export const STAGING_PURGE_PREFIX = /^t19-[a-z0-9-]{0,40}$/;

/** This run's names: its member's address, its token's label, its staging purge prefix. */
export function runNames(
  runId: string,
  client: ClientId,
  target: Target,
  domain = STAGING_TEST_DOMAIN,
): { prefix: string; email: string; tokenLabel: string } {
  // t19-: the only prefix the purge hook erases (T19's own sweep of old runs
  // takes a cut-off run's member too).
  const prefix =
    target === "staging"
      ? `t19-canary-${runId}-${client}`
      : `canary-${runId}-${client}`;
  if (target === "staging" && !STAGING_PURGE_PREFIX.test(prefix))
    throw new Error(
      `the staging purge prefix ${prefix} is too long for the purge hook`,
    );
  return {
    prefix,
    email: `${prefix}@${target === "staging" ? domain : "canary.test"}`,
    tokenLabel: `canary ${runId} ${client}`,
  };
}

/**
 * The one session of this run on the roster: live, the client's kind, on the
 * machine this run approved. Undefined while there is none; throws when there
 * are two, since then neither can be told to be this run's.
 */
export function thisRunsAgent(
  agents: BusAgent[],
  kind: string,
  machineId: string,
): BusAgent | undefined {
  const mine = agents.filter(
    (a) => a.machineId === machineId && a.kind === kind && a.state === "live",
  );
  if (mine.length > 1)
    throw new Error(
      `${mine.length} live ${kind} sessions on this run's machine: cannot tell which is the one under test`,
    );
  return mine[0];
}

/**
 * Cleans up on SIGINT, SIGTERM and SIGHUP while `run` is active: `stop` runs
 * once, then the process exits with 128 + the signal's number.
 */
function onSignals(stop: (sig: NodeJS.Signals) => Promise<void>): () => void {
  const codes: Partial<Record<NodeJS.Signals, number>> = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGTERM: 15,
  };
  const handlers = Object.entries(codes).map(([sig, n]) => {
    const h = () => {
      void stop(sig as NodeJS.Signals).finally(() => process.exit(128 + n));
    };
    process.once(sig as NodeJS.Signals, h);
    return [sig as NodeJS.Signals, h] as const;
  });
  return () => {
    for (const [sig, h] of handlers) process.off(sig, h);
  };
}

/** Runs one client through every check. Never throws: a failure is a failed check. */
export async function runCanary(o: Options): Promise<ClientResult> {
  const client = CLIENTS[o.client];
  const target: Target = o.target ?? "staging";
  const checks: CheckResult[] = [];
  let version = "";
  let versionAfter = "";
  let busVersion = "";
  let busVersionAfter = "";
  /** Values no output may hold: the model keys, the hook key, the run's tokens. */
  const secrets = [...client.secrets, ...STAGING_SECRETS].flatMap(
    (k) => o.env[k] ?? [],
  );
  const log = (line: string) => o.log(redact(line, secrets));
  const result = (): ClientResult => {
    const r: ClientResult = {
      client: client.id,
      label: client.label,
      channel: o.channel,
      target,
      version: clean(version, secrets, 80),
      ...(versionAfter && versionAfter !== version
        ? { versionAfter: clean(versionAfter, secrets, 80) }
        : {}),
      ...(busVersion ? { busVersion: clean(busVersion, secrets, 80) } : {}),
      ...(busVersionAfter && busVersionAfter !== busVersion
        ? { busVersionAfter: clean(busVersionAfter, secrets, 80) }
        : {}),
      status: overall(checks),
      checks: [...checks],
    };
    r.notes = [
      `Version as run: ${versionText(r) || "unknown (the client was not installed)"}`,
      ...(busVersion ? [`oa-bus as run: ${busVersionText(r)}`] : []),
      steeringNote(o.nextTurn ? { ...client, steering: false } : client),
    ];
    return r;
  };
  /** Records a check. Its detail is cleaned: one line, capped, no secret or token. */
  const step = (
    check: string,
    status: CheckResult["status"],
    detail: string,
  ) => {
    const d = clean(detail, secrets);
    checks.push({ check, status, detail: d });
    log(`${status.toUpperCase()} ${client.id} ${check}: ${d}`);
  };
  const missing = missingSecrets(client, o.env, target);
  if (missing.length > 0) {
    step("secrets", "fail", missingDetail(client.label, target, missing));
    return result();
  }
  let runId: string;
  try {
    runId = o.runId ?? runIdOf(o.env.CANARY_RUN_ID);
  } catch (e) {
    step("run", "fail", (e as Error).message);
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
    mkdirSync(d, { recursive: true, mode: 0o700 });
  let server: { origin: string; stop: () => Promise<void> } | undefined;
  let install: Proc | undefined;
  let daemon: Proc | undefined;
  let session: Proc | undefined;
  let probe: Probe | undefined;
  let clientVersion: (() => string) | undefined;
  let busVersionNow: (() => string) | undefined;
  /** Staging: the hook key and this run's member prefix, for the purge. */
  let purge: { origin: string; key: string; prefix: string } | undefined;
  /** Local: this run's member, token and machines, revoked at the end. */
  let member: Session | undefined;
  let tokenId = "";
  const machineIds: string[] = [];

  /**
   * Every credential goes, whatever the outcome: the processes stop, the
   * staging member is erased (its token, machines and pages with it) or the
   * local token and machines are revoked, the logs of a failed run are copied
   * with every secret blanked, and the scratch HOME (token file, bus home,
   * machine file, client settings) and the daemon's socket folder are deleted.
   * Runs once; a signal and the normal end share it.
   */
  let cleaning: Promise<void> | undefined;
  const cleanup = () =>
    (cleaning ??= (async () => {
      probe?.close();
      await stopProc(install);
      await stopProc(session);
      await stopProc(daemon);
      if (purge) {
        try {
          const n = await purgeMembers(purge.origin, purge.key, purge.prefix);
          log(`erased the run's member on ${purge.origin} (${n})`);
        } catch (e) {
          step(
            "cleanup",
            "fail",
            `could not erase the run's member: ${(e as Error).message}`,
          );
        }
      } else if (member) {
        try {
          for (const id of machineIds) await revokeMachine(member, id);
          if (tokenId) await revokeToken(member, tokenId);
          log("revoked the run's token and machines");
        } catch (e) {
          step(
            "cleanup",
            "fail",
            `could not revoke the run's token and machines: ${(e as Error).message}`,
          );
        }
      }
      await server?.stop().catch(() => {});
      if (overall(checks) === "fail") {
        const to =
          o.logsOut ?? join(tmpdir(), `oa-canary-logs-${runId}-${client.id}`);
        try {
          copyLogs(logs, to, secrets);
          log(`logs, with every key and token blanked, are in ${to}`);
        } catch {}
      }
      // The short socket folder is named from this run's bus home: it is ours.
      const sockDir = shortSocketDir(join(home, ".oa-bus"));
      for (const d of [scratch, sockDir])
        try {
          rmSync(d, { recursive: true, force: true, maxRetries: 5 });
        } catch {}
      if (existsSync(scratch))
        step("cleanup", "fail", `could not delete ${scratch}`);
    })());
  const offSignals = onSignals(async (sig) => {
    step("run", "fail", `stopped by ${sig} before the run finished`);
    await cleanup();
    (o.onSignal ?? (() => {}))(result(), sig);
  });

  try {
    // 1. The instance, this run's own new member, and the member's token file.
    // Staging: signed in through rl-a's session hook, as its staging e2e does.
    // Local: the dev login.
    const names = runNames(
      runId,
      client.id,
      target,
      o.env.CANARY_STAGING_TEST_DOMAIN || STAGING_TEST_DOMAIN,
    );
    if (target === "staging") {
      const origin = stagingOrigin(o.env.CANARY_STAGING_URL);
      server = { origin, stop: async () => {} };
      const key = o.env.CANARY_RL_A_HOOK_KEY as string;
      purge = { origin, key, prefix: names.prefix };
      member = await hookMember(origin, key, names.email);
    } else {
      server = o.hub
        ? { origin: o.hub, stop: async () => {} }
        : await startServer(o.port);
      member = await signIn(server.origin, names.email);
    }
    const pat = await createToken(member, names.tokenLabel);
    secrets.push(pat.token);
    tokenId = pat.id;
    const origin = server.origin;
    const tokenFile = join(home, ".open-artifacts/canary-pat-token");
    mkdirSync(join(home, ".open-artifacts"), { recursive: true, mode: 0o700 });
    writeFileSync(tokenFile, pat.token, { mode: 0o600 });
    // 2. The client binary: installed from npm, or the one given.
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
    writeFileSync(join(bin, "oa-canary-hold"), holdScript());
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
    log(`${client.id} version as run: ${version || "unknown"} (run ${runId})`);

    const env = childEnv(client, home, path, o.env, {
      CANARY_SIGNALS: signals,
      CANARY_HOLD_MS: String(HOLD_MS),
      // Codex's token form reads it by name (bearer_token_env_var).
      ...(client.id === "codex" ? { OA_TOKEN: pat.token } : {}),
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
    log(`oa-bus version as run: ${busVersion || "unknown"}`);
    // auto-update off writes into the bus home, which a fresh home lacks.
    const busHome = join(home, ".oa-bus");
    mkdirSync(busHome, { recursive: true, mode: 0o700 });
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
    const machinesBefore = new Set(
      (await busMachines(member)).map((m) => m.id),
    );
    install = startProc(
      "oa-bus",
      ["install", "--instance", origin, "--no-open", "--no-service"],
      { cwd: work, env, log: join(logs, "install.log") },
    );
    const inst = install;
    const code = await waitFor(
      "oa-bus install to show a code",
      () => {
        const c = USER_CODE.exec(plain(inst.output()))?.[1];
        if (c) return c;
        if (inst.exited())
          throw new Error(
            `oa-bus install exited ${inst.child.exitCode} before it showed a code`,
          );
        return undefined;
      },
      {
        ms: 60_000,
        on: [onFiles(inst.log), onExit(inst.child)],
      },
    );
    await approveCode(member, code);
    await waitFor(
      "oa-bus install to finish",
      () => (inst.exited() ? true : undefined),
      { ms: LIMITS.install, on: [onExit(inst.child)] },
    );
    if (inst.child.exitCode !== 0)
      throw new Error(
        `oa-bus install exited ${inst.child.exitCode}: see install.log`,
      );
    // The machine this run approved: the one that was not there before.
    const fresh = (await busMachines(member)).filter(
      (m) => !machinesBefore.has(m.id) && m.revokedAt === null,
    );
    machineIds.push(...fresh.map((m) => m.id));
    if (fresh.length !== 1)
      throw new Error(
        `expected one new machine after oa-bus install, found ${fresh.length}`,
      );
    const machineId = (fresh[0] as { id: string }).id;
    step(
      "install",
      "pass",
      `oa-bus install approved on ${origin} and wired ${client.label}`,
    );

    // 4. The daemon, run by hand (no service on a runner), then habits. It is
    // up once `oa-bus status` answers: asked again on each change in the bus
    // home or the daemon's output, never on a timer.
    daemon = startProc("oa-bus", ["daemon"], {
      cwd: work,
      env,
      log: join(logs, "daemon.log"),
    });
    const dmn = daemon;
    await waitFor(
      "the daemon to answer",
      () => {
        if (dmn.exited())
          throw new Error(`the daemon exited ${dmn.child.exitCode}`);
        return spawnSync("oa-bus", ["status"], {
          cwd: work,
          env,
          timeout: 10_000,
        }).status === 0
          ? true
          : undefined;
      },
      {
        ms: 30_000,
        on: [onFiles(busHome, dmn.log), onExit(dmn.child)],
      },
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
    // It is connected before the client starts, so it hears every roster change.
    const probeIdsBefore = new Set(
      (await busMachines(member)).map((m) => m.id),
    );
    const probeToken = await approveProbeMachine(member, "canary-probe");
    secrets.push(probeToken);
    for (const m of await busMachines(member))
      if (!probeIdsBefore.has(m.id)) machineIds.push(m.id);
    probe = await Probe.open(origin, probeToken, `canary-probe-${runId}`);
    const pr = probe;

    // 6. The client, headless, with NO prompt yet.
    const launch = client.start(ctx);
    const run = inPty(launch);
    session = startProc(run.cmd, run.args, {
      cwd: work,
      env,
      log: join(logs, "client.log"),
      stdin: true,
    });
    const sess = session;

    // Joins at start: on the roster, as this run's session, before any prompt.
    // Asked once now and again on each roster change the probe hears.
    let peer: Peer | undefined;
    try {
      const m = member;
      const a = await waitFor(
        `${client.label} on the bus before its first prompt`,
        async () => {
          if (sess.exited())
            throw new Error(
              `${client.label} exited ${sess.child.exitCode} before it joined`,
            );
          return thisRunsAgent(await busAgents(m), client.kind, machineId);
        },
        { ms: LIMITS.join, on: [pr.onFrame, onExit(sess.child)] },
      );
      peer = { name: a.name, id: a.id };
      step(
        "joins at start",
        "pass",
        `on the agent list as ${a.name} (${a.kind}, agent ${a.id}, this run's machine) before any prompt was sent`,
      );
    } catch (e) {
      step("joins at start", "fail", (e as Error).message);
    }
    // Not on the bus as this run's session: no prompt is sent, nothing else is checked.
    if (peer) {
      const me = peer;

      // The first prompt, now that it is on the bus.
      const title = `canary-${client.id}-${runId}-${marker()}`;
      sess.child.stdin?.write(client.prompt(canaryPrompt(title, pr.name)));

      // A page it publishes shows as this run's session. It says PUBLISHED on
      // the bus when done (the signal); then the page is read once.
      try {
        const told = await pr
          .reply(`PUBLISHED ${title}`, LIMITS.page, me)
          .then(() => true)
          .catch(() => false);
        const agent = await publishedBy(member, title);
        // Only this run's session may be on the member's bus besides the probe,
        // so a linked publish can only have come from it.
        const others = (await busAgents(member)).filter(
          (x) => x.state === "live" && x.id !== me.id && x.name !== pr.name,
        );
        const ok =
          told &&
          agent?.linked === true &&
          agent.product === client.product &&
          agent.name === names.tokenLabel &&
          others.length === 0;
        step(
          "page shows as the session",
          ok ? "pass" : "fail",
          !agent
            ? `${title} was ${agent === undefined ? "not published" : "published with no agent"}${told ? "" : ", and no PUBLISHED came"}`
            : `${title} shows ${agent.name}, linked ${agent.linked === true}, product ${agent.product ?? "none"}${told ? "" : "; no PUBLISHED came from this run's session"}${others.length ? `; ${others.length} other live sessions on the bus` : ""}${agent.name === names.tokenLabel ? "" : "; not this run's token"}`,
        );
      } catch (e) {
        step("page shows as the session", "fail", (e as Error).message);
      }

      // Receives a message and replies: sent to this run's agent id, the reply
      // counted only from it.
      const w = marker();
      try {
        await pr.send(me, `PING ${w}`);
        await pr.reply(`PONG ${w}`, LIMITS.reply, me);
        step(
          "receives and replies",
          "pass",
          `PING ${w} answered with PONG ${w} by ${me.name}`,
        );
      } catch (e) {
        step("receives and replies", "fail", (e as Error).message);
      }

      // A message sent mid-turn: steered into that turn (Codex, Pi), or at the
      // start of the next turn (Claude Code, OpenCode: no steer path yet).
      if (client.steering && !o.nextTurn)
        await steerCheck(pr, me, signals, step);
      else await nextTurnCheck(pr, me, signals, step);
    }
  } catch (e) {
    step("run", "fail", (e as Error).message);
  } finally {
    probe?.close();
    await stopProc(install);
    await stopProc(session);
    await stopProc(daemon);
    try {
      versionAfter = clientVersion?.() ?? "";
    } catch {}
    if (versionAfter && versionAfter !== version)
      log(`${client.id} updated itself during the run: ${versionAfter}`);
    try {
      busVersionAfter = busVersionNow?.() ?? "";
    } catch {}
    if (busVersionAfter && busVersionAfter !== busVersion)
      step(
        "oa-bus unchanged",
        "fail",
        `oa-bus was ${busVersion} as the run started and ${busVersionAfter} as it ended: the run did not test the oa-bus built from this commit`,
      );
    await cleanup();
    // Only now: a signal during the cleanup above waits for it, then exits.
    offSignals();
  }
  return result();
}

/** What the mid-turn checks need from the probe (a stub stands in for it in the tests). */
export type SteerProbe = Pick<
  Probe,
  "send" | "reply" | "frames" | "mail" | "onFrame" | "indexOf"
>;

type Step = (
  check: string,
  status: CheckResult["status"],
  detail: string,
) => void;

/** The held commands of HOLD <a> that said "timed out" (their marker files). */
const timedOut = (signals: string, a: string): number[] =>
  [1, 2].filter((n) => existsSync(join(signals, `hold-${a}-${n}.timedout`)));

/** Waits for hold <a> <n> to say it started: on file events in `signals`. */
const started = (signals: string, a: string, n: number, ms: number) =>
  waitFor(
    `held command ${n} to start`,
    () =>
      existsSync(join(signals, `hold-${a}-${n}.started`)) ? true : undefined,
    { ms, on: [onFiles(signals)] },
  );

/**
 * HOLD <a> starts a turn that runs two held commands. While the first is held,
 * PING <b> is sent and delivered; then the first is released. The second is
 * released only after PONG <b> arrives, or once the wait for it runs out. So
 * the turn cannot end before that, and the order of replies decides: PONG <b>
 * before the second release and before DONE <a> means the message reached
 * that turn. It does not matter whether the client answered before or after
 * it started the second command. Only replies from `peer` count. A held
 * command that timed out fails the check.
 */
export async function steerCheck(
  probe: SteerProbe,
  peer: Peer,
  signals: string,
  step: Step,
  limits: { hold: number; reply: number; late: number } = {
    hold: LIMITS.hold,
    reply: LIMITS.reply,
    late: 60_000,
  },
) {
  const a = marker();
  const b = marker();
  const release = (n: number) =>
    writeFileSync(join(signals, `hold-${a}-${n}.release`), "");
  try {
    await probe.send(peer, `HOLD ${a}`);
    await started(signals, a, 1, limits.hold);
    const r = await probe.send(peer, `PING ${b}`);
    await waitFor(
      "the mid-turn message to be delivered",
      () =>
        probe.frames.some(
          (f) =>
            f.type === "receipt_update" &&
            f.msg_id === r.msg_id &&
            f.state === "delivered",
        ) || undefined,
      { ms: 60_000, on: [probe.onFrame] },
    );
    release(1);
    const pong = await probe
      .reply(`PONG ${b}`, limits.reply, peer)
      .catch(() => undefined);
    // Read before the release: whatever is in the mail now came inside the turn.
    const done = probe.indexOf(`DONE ${a}`, peer);
    const inTurn =
      pong !== undefined &&
      (done < 0 || probe.indexOf(`PONG ${b}`, peer) < done);
    release(2);
    await probe.reply(`DONE ${a}`, limits.reply, peer);
    const late = timedOut(signals, a);
    if (late.length > 0)
      step(
        "mid-turn message",
        "fail",
        `held command ${late.join(" and ")} of HOLD ${a} timed out before its release`,
      );
    else if (inTurn)
      step(
        "mid-turn message",
        "pass",
        `PING ${b}, sent during HOLD ${a}, was answered inside that turn`,
      );
    else {
      // Answered after the turn ended: delivered, but not steered into it.
      const after =
        pong ??
        (await probe
          .reply(`PONG ${b}`, limits.late, peer)
          .catch(() => undefined));
      step(
        "mid-turn message",
        "fail",
        after
          ? `PING ${b}, sent during HOLD ${a}, was answered only after that turn ended`
          : `PING ${b}, sent during HOLD ${a}, was never answered`,
      );
    }
  } catch (e) {
    release(1);
    release(2);
    const late = timedOut(signals, a);
    step(
      "mid-turn message",
      "fail",
      late.length > 0
        ? `held command ${late.join(" and ")} of HOLD ${a} timed out before its release`
        : (e as Error).message,
    );
  }
}

/**
 * For a client with no steer path (Claude Code, OpenCode): HOLD <a> starts a
 * turn with two held commands; PING <b> is sent while the first is held, then
 * both are released. The message must arrive at the start of the next turn:
 * PONG <b> comes after DONE <a>. A PONG before DONE means the client steers
 * now, which passes and says so. No PONG at all fails, as does a held command
 * that timed out. Only replies from `peer` count.
 */
export async function nextTurnCheck(
  probe: SteerProbe,
  peer: Peer,
  signals: string,
  step: Step,
  limits: { hold: number; reply: number } = {
    hold: LIMITS.hold,
    reply: LIMITS.reply,
  },
) {
  const a = marker();
  const b = marker();
  const release = (n: number) =>
    writeFileSync(join(signals, `hold-${a}-${n}.release`), "");
  try {
    await probe.send(peer, `HOLD ${a}`);
    await started(signals, a, 1, limits.hold);
    await probe.send(peer, `PING ${b}`);
    release(1);
    release(2);
    await probe.reply(`DONE ${a}`, limits.reply, peer);
    const pong = await probe
      .reply(`PONG ${b}`, limits.reply, peer)
      .catch(() => undefined);
    const late = timedOut(signals, a);
    if (late.length > 0)
      step(
        "mid-turn message",
        "fail",
        `held command ${late.join(" and ")} of HOLD ${a} timed out before its release`,
      );
    else if (!pong)
      step(
        "mid-turn message",
        "fail",
        `PING ${b}, sent during HOLD ${a}, never arrived in the next turn`,
      );
    else if (
      probe.indexOf(`PONG ${b}`, peer) > probe.indexOf(`DONE ${a}`, peer)
    )
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
    const late = timedOut(signals, a);
    step(
      "mid-turn message",
      "fail",
      late.length > 0
        ? `held command ${late.join(" and ")} of HOLD ${a} timed out before its release`
        : (e as Error).message,
    );
  }
}

/**
 * Copies each log to `to` as plain text, with every value in `secrets` (even
 * one a redraw or a wrap split) and every token shape blanked.
 */
export function copyLogs(from: string, to: string, secrets: string[]) {
  mkdirSync(to, { recursive: true, mode: 0o700 });
  for (const f of readdirSync(from))
    writeFileSync(
      join(to, f),
      redactLog(readFileSync(join(from, f), "utf8"), secrets),
    );
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
      cleanup: { type: "boolean", default: false },
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
  if (values.cleanup) {
    for (const line of await cleanupAfter(id, target, process.env))
      console.log(line);
    return;
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
  const finish = (r: ClientResult) => {
    if (fakeDir) rmSync(fakeDir, { recursive: true, force: true });
    const md = summaryMarkdown(r);
    console.log(md);
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
    if (values.out)
      writeFileSync(values.out, `${JSON.stringify(r, null, 2)}\n`);
  };
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
    onSignal: finish,
    ...(values.fake && values["fake-next-turn"] ? { nextTurn: true } : {}),
    ...(fakeDir ? { clientBin: fakeDir } : {}),
    ...(values["client-bin"] ? { clientBin: values["client-bin"] } : {}),
    ...(values.hub ? { hub: values.hub } : {}),
    ...(values.logs ? { logsOut: values.logs } : {}),
  });
  finish(r);
  process.exit(r.status === "fail" ? 1 : 0);
}

/** The temp folder the workflow gives each job (TMPDIR), which --cleanup may empty. */
export const SCRATCH_DIR = "canary-scratch";

/**
 * After a run that was cut off (a job timeout, a cancel, a kill): erases this
 * run's staging member by its prefix (CANARY_RUN_ID), with its token,
 * machines and pages, and deletes every oa-canary scratch folder, bus socket
 * folder and fake bin under the temp folder. The workflow runs it under
 * `if: always()`. Safe to run when there is nothing left.
 */
export async function cleanupAfter(
  id: ClientId,
  target: Target,
  env: Record<string, string | undefined>,
  tmp = tmpdir(),
): Promise<string[]> {
  const out: string[] = [];
  // Only a temp folder the job owns (the workflow's $RUNNER_TEMP/canary-scratch):
  // a shared one may hold another run's live folders.
  if (basename(tmp) === SCRATCH_DIR) {
    let removed = 0;
    for (const e of readdirSync(tmp))
      if (/^oa-canary-(?!logs-)/.test(e)) {
        rmSync(join(tmp, e), { recursive: true, force: true, maxRetries: 5 });
        removed++;
      }
    out.push(`deleted ${removed} scratch folders under ${tmp}`);
  } else
    out.push(
      `left ${tmp} alone: only a temp folder named ${SCRATCH_DIR} is the job's own`,
    );
  const key = env.CANARY_RL_A_HOOK_KEY;
  if (target === "staging" && key && env.CANARY_RUN_ID) {
    const runId = runIdOf(env.CANARY_RUN_ID);
    const origin = stagingOrigin(env.CANARY_STAGING_URL);
    const { prefix } = runNames(runId, id, target);
    try {
      out.push(
        `erased ${await purgeMembers(origin, key, prefix)} members named ${prefix} on ${origin}`,
      );
    } catch (e) {
      out.push(
        `could not erase ${prefix} on ${origin}: ${clean((e as Error).message, [key])}`,
      );
    }
  } else out.push("no staging member to erase");
  return out;
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) ===
    realpathSync(new URL(import.meta.url).pathname)
)
  await main();
