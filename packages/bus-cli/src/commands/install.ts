import { join } from "node:path";
import { canonicalHome, daemonSocketPath } from "@oa/bus-adapter-claude-code";
import {
  MIN_PROMPT_ID_VERSION,
  opencodeVersion,
  supportsPromptId,
} from "@oa/bus-adapter-opencode";
import { displayRole, type StatusReply } from "@oa/bus-ipc";
import {
  askDaemon,
  type Ctx,
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
} from "../steps/adapters.ts";
import { checkSteps, runSteps, type Step } from "../steps/step.ts";
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
  const asked = opts.hub ?? ctx.env.OA_BUS_HUB;
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

async function harnessesStep(ctx: Ctx): Promise<boolean> {
  const c = ctx.copy;
  const out = await installAdapters({
    home: ctx.userHome,
    busHome: ctx.home,
    env: ctx.env,
    // The service runs this same copy.
    busBin: ctx.service.cli(),
    assets: readAssets(),
    which: ctx.which,
    exec: ctx.exec,
    codexApp: ctx.codexApp,
  });
  if (out.installed.length > 0) say(ctx, c.configured(out.installed));
  else if (out.skipped.length === 0) say(ctx, c.noHarness());
  if (out.sharedPiFile) say(ctx, c.sharedPiFile());
  if (out.codexNoWake) say(ctx, c.codexNoWake());
  for (const s of out.skipped)
    say(ctx, await skippedLines(ctx, s.harness, s.reason));
  if (out.installed.includes("opencode"))
    say(ctx, out.opencodeRestarted ? c.restarted() : c.opencodeNotRunning());
  return true;
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
  const { running } = await ctx.service.ensure();
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
  // Agent card (AC5c): a role column only when a row has a role, and a row's
  // status on the line under it. A daemon below the gate sends neither.
  const shown = rows.slice(0, ROSTER_ROWS);
  const roles = shown.some((r) => displayRole(r) !== undefined);
  const now = ctx.now();
  return {
    lines: [
      c.rosterHeader(ns.namespace, rows.length - queued, queued),
      ...shown.flatMap((r) => {
        const says = c.rosterSays(r, now);
        return [c.rosterRow(r, roles), ...(says ? [says] : [])];
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

export const installSteps = (opts: InstallOpts): Step<Ctx>[] => [
  {
    name: "login",
    label: "Machine approved",
    failed: "Machine not approved",
    action: "Run npx @open-artifacts/bus to approve it.",
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
    action: "Run npx @open-artifacts/bus to configure them.",
    check: async (ctx) =>
      Object.values(
        checkAdapters({
          home: ctx.userHome,
          busHome: ctx.home,
          env: ctx.env,
          which: ctx.which,
          codexApp: ctx.codexApp,
          busBin: ctx.service.argv?.(),
        }),
      ).includes("missing")
        ? "todo"
        : "done",
    apply: harnessesStep,
  },
  {
    name: "daemon",
    label: "Daemon answering",
    failed: "Daemon not answering",
    action: "Run npx @open-artifacts/bus to start it.",
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

export async function install(
  opts: InstallOpts & { check?: boolean },
  ctx: Ctx,
): Promise<number> {
  const c = ctx.copy;
  say(ctx, c.header(ctx.version), "");
  const steps = installSteps(opts);
  if (opts.check) {
    const results = await checkSteps(steps, ctx);
    for (const { step, state } of results) {
      if (state === "done") say(ctx, c.checkOk(step.label));
      else sayErr(ctx, c.checkFailed(step.failed, step.action));
    }
    return results.every((r) => r.state === "done") ? 0 : 1;
  }
  const ok = await runSteps(steps, ctx, {
    path: join(ctx.home, "install.json"),
    now: ctx.now,
  });
  return ok ? 0 : 1;
}
