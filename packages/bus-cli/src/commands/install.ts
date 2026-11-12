import { dirname, join } from "node:path";
import { canonicalHome, daemonSocketPath } from "@oa/bus-adapter-claude-code";
import {
  MIN_PROMPT_ID_VERSION,
  opencodeVersion,
  supportsPromptId,
} from "@oa/bus-adapter-opencode";
import { codexBinFile } from "@oa/bus-daemon";
import { BUS_CMD, type StatusReply } from "@oa/bus-ipc";
import { useBusCmd } from "../bus-cmd.ts";
import {
  askDaemon,
  type Ctx,
  isolated,
  say,
  sayErr,
  socketFolderLines,
  tilde,
  tildeReason,
} from "../context.ts";
import type { RosterAgent } from "../copy.ts";
import { spinner } from "../live.ts";
import { readMachine } from "../machine.ts";
import {
  checkAdapters,
  type Harness,
  installAdapters,
  readAssets,
  unshownNotes,
} from "../steps/adapters.ts";
import { installClaudePlugins } from "../steps/claude-plugins.ts";
import { readCodexVersion } from "../steps/codex.ts";
import { hermesEnabled } from "../steps/hermes.ts";
import { noteMade, pruneMade } from "../steps/leftovers.ts";
import { openclawVerify } from "../steps/openclaw.ts";
import { installShim } from "../steps/path-shim.ts";
import { fetchSkillText, installSkill } from "../steps/skill.ts";
import { checkSteps, runSteps, type Step } from "../steps/step.ts";
import {
  type HabitsMode,
  habitsAfterInstall,
  habitsCommand,
} from "./habits.ts";
import { LoginFailed, login } from "./login.ts";

/** Transcript state 6: four attempts, waiting 2, 4 and 8 s between them. */
export const CODE_RETRY_MS = [2000, 4000, 8000];
export const DAEMON_WAIT_MS = 10_000;
const DAEMON_POLL_MS = 250;
const ROSTER_ROWS = 20;

export type InstallOpts = {
  hub?: string;
  noOpen?: boolean;
  /** The machine label; defaults to the sanitized hostname. */
  label?: string;
  /** Skip the launchd or systemd step: the user runs the daemon. */
  noService?: boolean;
  /** --habits, --no-habits or --show-habits: only the always-on block, nothing else reruns. */
  habits?: HabitsMode;
  /** The result as one JSON line on stdout; the human lines go to stderr. */
  json?: boolean;
};

const originOf = (hub: string) => {
  try {
    return new URL(hub.replace(/^ws(s?):/, "http$1:")).origin;
  } catch {
    return hub;
  }
};

const hostOf = (hub: string) => {
  try {
    return new URL(hub).host;
  } catch {
    return hub;
  }
};

/** The approval flow, as the transcript prints it. Shared with `oa-bus login`. */
export async function loginStep(
  ctx: Ctx,
  opts: InstallOpts & {
    /** `oa-bus login`: always approve again. */
    force?: boolean;
  },
): Promise<boolean> {
  const c = ctx.copy;
  const machine = readMachine(ctx.home);
  const asked = opts.hub ?? ctx.env.OA_BUS_INSTANCE;
  if (machine.state === "ok" && !machine.revoked && !opts.force) {
    // Never keep the old hub silently when another was asked for.
    if (asked && originOf(asked) !== originOf(machine.hub)) {
      sayErr(ctx, c.hubMismatch(hostOf(machine.hub), hostOf(asked), asked));
      return false;
    }
    say(ctx, c.alreadyConnected(machine.label), "");
    return true;
  }
  // A revoked machine re-approves on the hub it was approved for.
  const hub = asked ?? (machine.state === "ok" ? machine.hub : undefined);
  if (!hub) {
    sayErr(ctx, c.noHub());
    return false;
  }
  const host = hostOf(hub);
  const tty = Boolean(ctx.stdout.isTTY);
  const live = spinner(ctx);
  let deadline = 0;
  try {
    const result = await login({
      hub,
      home: ctx.home,
      label: opts.label,
      exec: ctx.exec,
      noOpen: opts.noOpen,
      codeRetryMs: CODE_RETRY_MS,
      fetch: ctx.fetch,
      openBrowser: ctx.openBrowser,
      sleep: ctx.sleep,
      now: ctx.now,
      print: ctx.print,
      events: {
        retrying: ({ attempt, total, waitMs }) => {
          const lines = c.unreachable(host, waitMs / 1000, attempt + 1, total);
          if (tty) live.draw(lines);
          else say(ctx, lines);
        },
        code: ({ url, userCode, opened, noOpen }) => {
          live.clear();
          say(
            ctx,
            opened
              ? [c.opening(), c.ifNotOpened(url)]
              : [noOpen ? c.openThisUrl() : c.noBrowser(), c.url(url)],
            "",
            c.codeBox(userCode),
            "",
          );
          deadline = ctx.now() + 10 * 60_000;
          if (tty) live.spin(deadline);
          else say(ctx, c.waitingPlain());
        },
        poll: (ok) => live.failing(!ok),
      },
    });
    live.clear();
    say(
      ctx,
      c.approved(result.label),
      c.tokenSaved(
        tilde(ctx, join(ctx.home, "machine.json")),
        result.machineToken,
      ),
      c.connected(originOf(result.hub)),
      "",
    );
    return true;
  } catch (e) {
    live.clear();
    if (e instanceof LoginFailed) {
      if (e.kind === "denied") sayErr(ctx, c.denied());
      else if (e.kind === "expired")
        sayErr(ctx, c.expired(e.detail.userCode ?? ""));
      else
        sayErr(
          ctx,
          c.unreachableFinal(
            host,
            e.detail.attempts ?? 1,
            e.detail.error ?? "",
          ),
        );
    } else sayErr(ctx, c.failed(e instanceof Error ? e.message : String(e)));
    return false;
  } finally {
    live.clear();
  }
}

async function harnessesStep(
  ctx: Ctx,
  hub: string | undefined,
): Promise<boolean> {
  const c = ctx.copy;
  const hubOrigin = hub ? originOf(hub) : machineOrigin(ctx);
  const out = await installAdapters({
    home: ctx.userHome,
    busHome: ctx.home,
    env: ctx.env,
    ...(hubOrigin ? { hub: hubOrigin } : {}),
    // The service runs this same copy.
    busBin: ctx.service.cli(),
    assets: readAssets(),
    which: ctx.which,
    exec: ctx.exec,
    codexApp: ctx.codexApp,
    isolated: isolated(ctx),
  });
  if (out.installed.length > 0) say(ctx, c.configured(out.installed));
  else if (out.skipped.length === 0) say(ctx, c.noHarness());
  if (out.sharedPiFile) say(ctx, c.sharedPiFile());
  if (out.codexNoWake) say(ctx, c.codexNoWake());
  if (out.hermesRestart) say(ctx, c.hermesRestart());
  if (out.openclawRestart) say(ctx, c.openclawRestart());
  if (out.openclawNix) say(ctx, c.openclawNix());
  for (const n of unshownNotes(out.notes)) say(ctx, [n]);
  for (const s of out.skipped)
    say(ctx, await skippedLines(ctx, s.harness, s.reason));
  if (out.installed.includes("opencode")) {
    if (out.opencodeRestartByUser)
      say(ctx, c.opencodeRestartYourself(out.opencodeIsolated));
    else if (out.opencodeRestarted) say(ctx, c.restarted());
    else if (
      out.notes.some((n) => n.startsWith("opencode service restart failed"))
    )
      say(ctx, c.opencodeNotRunning());
  }

  // The skill goes next to the tools, fetched from the instance, never vendored.
  // A fetch failure does not stop later steps: it is recorded and the run exits
  // non-zero at the end, after the daemon (or whatever follows) has had its turn.
  const codexVersion = out.installed.includes("codex")
    ? await readCodexVersion({
        configFile: codexBinFile(ctx.home),
        exec: ctx.exec,
        path: ctx.env.PATH,
        app: ctx.codexApp,
      })
    : undefined;
  const skill = await installSkill(
    {
      home: ctx.userHome,
      env: ctx.env,
      codexVersion,
      fetchSkill: (url) => fetchSkillText(ctx.fetch, url),
    },
    hub ? originOf(hub) : machineOrigin(ctx),
    out.installed,
  );
  for (const n of skill.notes) say(ctx, [n]);
  if (skill.failedUrl) skillFailure.set(ctx, skill.failedUrl);
  // The Claude Code plugins (session shortcuts, output style), through Claude Code's own
  // marketplace commands. A failure here is a note, never a stop.
  try {
    const plugins = await installClaudePlugins(
      {
        home: ctx.userHome,
        busHome: ctx.home,
        env: ctx.env,
        exec: ctx.exec,
        version: ctx.version,
        origin: hub ? originOf(hub) : machineOrigin(ctx),
        copy: c,
      },
      out.installed,
    );
    for (const n of plugins.notes) say(ctx, [n]);
    if (plugins.ok) say(ctx, c.pluginsInstalled());
    if (plugins.styleOn) say(ctx, c.outputStyleOn());
    else if (plugins.keptStyleFirst)
      say(ctx, c.outputStyleKept(plugins.keptStyle));
  } catch (e) {
    say(ctx, c.pluginsSetupFailed(e instanceof Error ? e.message : String(e)));
  }
  // Written quietly: the harnesses line above is the user-visible outcome, and
  // a run that writes nothing has nothing to say.
  return true;
}

/** A skill fetch that failed, reported once the remaining steps have run. */
const skillFailure = new WeakMap<Ctx, string>();

/** Prints the skill failure and its rerun line, when the harnesses step recorded one. */
function reportSkillFailure(ctx: Ctx): boolean {
  const url = skillFailure.get(ctx);
  if (!url) return false;
  sayErr(ctx, [
    `Could not fetch the skill from ${url}.`,
    `The bus tools are set up. Rerun ${ctx.busCmd} install to write the skill.`,
  ]);
  return true;
}

/** The approved machine's hub origin, or undefined when there is no machine. */
function machineOrigin(ctx: Ctx): string | undefined {
  const m = readMachine(ctx.home);
  return m.state === "ok" ? originOf(m.hub) : undefined;
}

async function skippedLines(ctx: Ctx, h: Harness, reason: string) {
  if (h !== "opencode") return ctx.copy.skipped(h, tildeReason(ctx, h, reason));
  const v = await opencodeVersion(ctx.exec);
  if (v === undefined) return ctx.copy.opencodeUnknown();
  if (!supportsPromptId(v))
    return ctx.copy.opencodeTooOld(v, MIN_PROMPT_ID_VERSION);
  // Not the version: a malformed config, a dangling link…
  return ctx.copy.skipped(h, reason);
}

/** The daemon socket as the user named its home (`~/.oa-bus/daemon.sock`), not canonical. */
function shownSocket(ctx: Ctx): string {
  const path = daemonSocketPath(ctx.home);
  const real = `${canonicalHome(ctx.home)}/`;
  return tilde(
    ctx,
    path.startsWith(real) ? join(ctx.home, path.slice(real.length)) : path,
  );
}

/** Polls the daemon socket until it answers or `DAEMON_WAIT_MS` passes. */
export async function waitForDaemon(
  ctx: Ctx,
): Promise<StatusReply | undefined> {
  const start = ctx.now();
  for (;;) {
    try {
      return await askDaemon(ctx, { cwd: ctx.cwd, timeoutMs: 1000 });
    } catch {}
    if (ctx.now() - start >= DAEMON_WAIT_MS) return undefined;
    await ctx.sleep(DAEMON_POLL_MS);
  }
}

async function daemonStep(ctx: Ctx, noService = false): Promise<boolean> {
  const c = ctx.copy;
  if (noService) {
    // No service call at all: report the daemon if the user already runs one.
    const st = await askDaemon(ctx, { cwd: ctx.cwd, timeoutMs: 1000 }).catch(
      () => undefined,
    );
    if (!st) {
      say(ctx, c.serviceSkipped());
      return true;
    }
    // Started by the user: the "without a service" variant, not "run install".
    say(ctx, c.daemonRunning(st.pid, undefined, true), "");
    say(ctx, roster(ctx, st), "", c.statusHint());
    return true;
  }
  const { running, skipped, idle } = await ctx.service.ensure();
  if (skipped) say(ctx, c.serviceOtherHome(skipped, false, !idle));
  // Nothing was started: report a daemon already running, or how to start one.
  if (idle) return daemonStep(ctx, true);
  if (running !== undefined) {
    sayErr(ctx, c.daemonInTheWay(shownSocket(ctx), running));
    return false;
  }
  const unsafe = socketFolderLines(ctx);
  const st = unsafe ? undefined : await waitForDaemon(ctx);
  if (!st) {
    sayErr(ctx, unsafe ?? c.daemonTimeout());
    return false;
  }
  say(ctx, c.daemonRunning(st.pid, ctx.service.kind, ctx.service.fallback), "");
  say(ctx, roster(ctx, st), "", c.statusHint());
  return true;
}

type Roster = StatusReply["namespaces"][number];

/** One namespace's summary line and table, as the transcript prints them. */
export function rosterBlock(
  ctx: Ctx,
  ns: Roster,
): { lines: string[]; queued: boolean } {
  const c = ctx.copy;
  if (ns.agents.length === 0)
    return { lines: c.noAgents(ns.namespace), queued: false };
  const rows: RosterAgent[] = [...ns.agents].sort(
    (a, b) =>
      Number(a.state === "queued") - Number(b.state === "queued") ||
      a.name.localeCompare(b.name),
  );
  const queued = rows.filter((r) => r.state === "queued").length;
  // A row's status on the line under it.
  const shown = rows.slice(0, ROSTER_ROWS);
  const now = ctx.now();
  return {
    lines: [
      c.rosterHeader(ns.namespace, rows.length - queued, queued),
      ...(ns.source ? [c.namespaceSource(ns.source)] : []),
      ...shown.flatMap((r) => {
        const says = c.rosterSays(r, now);
        return [c.rosterRow(r), ...(says ? [says] : [])];
      }),
      ...(rows.length > ROSTER_ROWS
        ? [c.rosterMore(rows.length - ROSTER_ROWS)]
        : []),
    ],
    queued: queued > 0,
  };
}

/**
 * Every namespace's block, a blank line between them, and the queued
 * footnote once, after the last table with a queued row.
 */
export function rosters(ctx: Ctx, namespaces: Roster[]): string[] {
  const blocks = namespaces.map((ns) => rosterBlock(ctx, ns));
  const last = blocks.map((b) => b.queued).lastIndexOf(true);
  return blocks.flatMap((b, i) => [
    ...(i > 0 ? [""] : []),
    ...b.lines,
    ...(i === last ? ctx.copy.queuedFootnote() : []),
  ]);
}

/** The cwd's namespace, for install's closing table. */
export function roster(ctx: Ctx, st: StatusReply): string[] {
  const ns = st.namespaces.find((n) => n.namespace === st.namespace);
  return ns ? rosters(ctx, [ns]) : [ctx.copy.noNamespace()];
}

/** States that fail `install --check`. */
const BAD = new Set(["missing", "disabled", "not loaded"]);

/** Each harness found here and how it is wired; read-only. */

export async function harnessStates(
  ctx: Ctx,
): Promise<Partial<Record<Harness, string>>> {
  const wiring: Record<string, string> = checkAdapters({
    home: ctx.userHome,
    busHome: ctx.home,
    env: ctx.env,
    which: ctx.which,
    codexApp: ctx.codexApp,
    busBin: ctx.service.argv?.(),
  });
  // The plugin files can be right while Hermes has it disabled.
  if (
    wiring.hermes === "configured" &&
    !(await hermesEnabled({
      home: ctx.userHome,
      env: ctx.env,
      exec: ctx.exec,
    }))
  )
    wiring.hermes = "disabled";
  // Likewise OpenClaw: installed and enabled, and its runtime shows the plugin loaded.
  if (
    wiring.openclaw === "configured" &&
    (await openclawVerify({
      home: ctx.userHome,
      env: ctx.env,
      exec: ctx.exec,
    })) !== undefined
  )
    wiring.openclaw = "not loaded";
  return Object.fromEntries(
    Object.entries(wiring).filter(([, st]) => st !== "absent"),
  );
}

export const installSteps = (
  opts: InstallOpts,
  bus: string = BUS_CMD,
): Step<Ctx>[] => [
  {
    name: "login",
    label: "Machine approved",
    failed: "Machine not approved",
    action: `Run ${bus} to approve it.`,
    check: async (ctx) => {
      const m = readMachine(ctx.home);
      return m.state === "ok" && !m.revoked ? "done" : "todo";
    },
    apply: (ctx) => loginStep(ctx, opts),
  },
  {
    name: "harnesses",
    label: "Harnesses configured",
    failed: "Harnesses not configured",
    action: `Run ${bus} to configure them.`,
    check: async (ctx) => {
      const states = await harnessStates(ctx);
      return Object.values(states).some((st) => BAD.has(st)) ? "todo" : "done";
    },
    apply: (ctx) => harnessesStep(ctx, opts.hub),
  },
  {
    name: "daemon",
    label: "Daemon answering",
    failed: "Daemon not answering",
    action: `Run ${bus} to start it.`,
    check: async (ctx) => {
      try {
        await askDaemon(ctx, { timeoutMs: 1000 });
        return "done";
      } catch {
        return "todo";
      }
    },
    apply: (ctx) => daemonStep(ctx, opts.noService),
  },
];

/** #1626: `oa-bus` on PATH. Never fails the install: a note at most. */
function reportShim(ctx: Ctx): void {
  const argv = ctx.service.argv?.();
  if (!argv || argv.length !== 2) return;
  try {
    const r = installShim({
      userHome: ctx.userHome,
      busHome: ctx.home,
      platform: ctx.platform,
      env: ctx.env,
      argv,
    });
    if (r.kind === "installed") {
      say(ctx, ctx.copy.shimInstalled(tilde(ctx, r.path)));
      if (!r.onPath && r.hint)
        say(ctx, ctx.copy.shimNotOnPath(tilde(ctx, dirname(r.path)), r.hint));
    } else if (r.kind === "other-home")
      say(ctx, ctx.copy.shimOtherHome(tilde(ctx, r.path), tilde(ctx, r.home)));
    else if (r.kind === "foreign")
      say(ctx, ctx.copy.shimForeign(tilde(ctx, r.path)));
  } catch (e) {
    say(ctx, [
      `Could not add the oa-bus command: ${e instanceof Error ? e.message : String(e)}`,
    ]);
  }
}

export async function install(
  opts: InstallOpts & { check?: boolean },
  realCtx: Ctx,
): Promise<number> {
  // A read-only run, or one that only sets the habits, makes nothing to record.
  if (opts.check || opts.habits) return installRun(opts, realCtx);
  const deps = {
    home: realCtx.userHome,
    busHome: realCtx.home,
    env: realCtx.env,
  };
  // Before install writes anything: purge later deletes only what was not there.
  try {
    noteMade(deps);
  } catch {}
  try {
    return await installRun(opts, realCtx);
  } finally {
    try {
      pruneMade(deps);
    } catch {}
  }
}

async function installRun(
  opts: InstallOpts & { check?: boolean },
  realCtx: Ctx,
): Promise<number> {
  if (opts.habits) return habitsCommand(opts.habits, realCtx);
  const json = Boolean(opts.json && !opts.check);
  const ctx: Ctx = json ? { ...realCtx, stdout: realCtx.stderr } : realCtx;
  const c = ctx.copy;
  say(ctx, c.header(ctx.version), "");
  const steps = installSteps(opts, ctx.busCmd);
  if (opts.check) {
    const results = await checkSteps(steps, ctx);
    for (const { step, state } of results) {
      // The harnesses line names each harness found here and how it is wired.
      const states = step.name === "harnesses" ? await harnessStates(ctx) : {};
      const details = Object.entries(states).map(([h, st]) =>
        c.checkHarness(h as Harness, st),
      );
      if (state === "done") say(ctx, c.checkOk(step.label, details));
      else sayErr(ctx, c.checkFailed(step.failed, step.action, details));
    }
    return results.every((r) => r.state === "done") ? 0 : 1;
  }
  const ok = await runSteps(steps, ctx, {
    path: join(ctx.home, "install.json"),
    now: ctx.now,
  });
  if (ok) {
    reportShim(ctx);
    // The shim now exists: what is printed from here on can name oa-bus.
    useBusCmd(ctx);
  }
  const skillFailed = reportSkillFailure(ctx);
  // The always-on habits come last, once everything else is done: a person is
  // asked, an agent gets a question for its user. Nothing is written unasked.
  const habits = ok ? await habitsAfterInstall(ctx, json) : undefined;
  const code = ok && !skillFailed ? 0 : 1;
  if (json)
    realCtx.stdout.write(
      `${JSON.stringify({
        ok: code === 0,
        habits: habits && {
          state: habits.state,
          files: habits.files,
          plugins: habits.plugins,
        },
        question: habits?.question ?? null,
      })}\n`,
    );
  return code;
}
