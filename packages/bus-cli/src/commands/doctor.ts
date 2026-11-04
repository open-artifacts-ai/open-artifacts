import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MIN_PROMPT_ID_VERSION,
  opencodeVersion,
  supportsPromptId,
} from "@oa/bus-adapter-opencode";
import {
  codexBinFile,
  globalFile,
  isGlobalDir,
  nearestConfig,
  readGlobalDirs,
} from "@oa/bus-daemon";
import {
  type Ctx,
  probeDaemon,
  say,
  sayErr,
  socketFolderLines,
  tilde,
} from "../context.ts";
import { readMachine } from "../machine.ts";
import { checkAdapters, type Harness } from "../steps/adapters.ts";
import {
  codexConfig,
  codexHome,
  findCodexBin,
  readToml,
  sandboxRisk,
} from "../steps/codex.ts";
import { errorTail } from "./login.ts";
import { type Healthz, healthzBody, hostOf, updateTarget } from "./status.ts";

const MIN_NODE = 22;
const HEALTHZ_TIMEOUT_MS = 10_000;

const sameOrigin = (url: string, hub: string) => {
  try {
    return url === "" || new URL(url).origin === new URL(hub).origin;
  } catch {
    return false;
  }
};

type Health = Healthz & { error?: string };

/** `/healthz`: no error when it answered 2xx, else the transcript's muted tail; and its version and problem, if any. */
async function healthz(ctx: Ctx, hub: string): Promise<Health> {
  try {
    const res = await ctx.fetch(`${hub.replace(/\/+$/, "")}/healthz`, {
      signal: AbortSignal.timeout(HEALTHZ_TIMEOUT_MS),
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    // Redirects are followed for reachability; the body counts only from the hub's own origin.
    return sameOrigin(res.url, hub) ? await healthzBody(res) : {};
  } catch (e) {
    return { error: errorTail(e) };
  }
}

/** isolatePeerMachines from Claude's settings; undefined when there is no settings file. */
function claudeIsolates(path: string): boolean | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    return (
      (JSON.parse(text) as { isolatePeerMachines?: unknown })
        .isolatePeerMachines === true
    );
  } catch {
    return undefined;
  }
}

/**
 * Whether the cwd's `.oa-bus.json`, read as the daemon reads it, asks for
 * global while the cwd is not in the user's allowlist: the daemon ignores
 * the request (C19).
 */
function asksForGlobal(ctx: Ctx, dirs: string[]): boolean {
  if (nearestConfig(ctx.cwd).global !== true) return false;
  return !isGlobalDir(ctx.cwd, dirs);
}

/**
 * Codex, after its wiring line: the binary the daemon wakes threads with,
 * the Codex home the service reads, and a sandbox that lets a thread write
 * Codex's own folder, which the attestation assumes only Codex writes
 * (docs/probes/codex.md §2).
 */
function codexChecks(
  ctx: Ctx,
  out: { pass: (line: string) => void; warn: (lines: string[]) => void },
) {
  const c = ctx.copy;
  // The daemon's own order: the pin, then PATH, then the app.
  const bin = findCodexBin({
    configFile: codexBinFile(ctx.home),
    path: ctx.env.PATH,
    app: ctx.codexApp,
  });
  if (bin) out.pass(c.codexWakes(tilde(ctx, bin)));
  else out.warn(c.codexNoWakeCheck());
  if (ctx.service.kind) {
    const shell = codexHome(ctx.userHome, ctx.env);
    const service = codexHome(ctx.userHome, ctx.service.env?.() ?? {});
    if (shell !== service)
      out.warn(c.codexHomeMismatch(tilde(ctx, shell), tilde(ctx, service)));
  }
  const config = codexConfig(ctx.userHome, ctx.env);
  let risk: ReturnType<typeof sandboxRisk>;
  try {
    risk = sandboxRisk(
      readToml(config).doc,
      ctx.userHome,
      codexHome(ctx.userHome, ctx.env),
    );
  } catch {}
  if (risk === "full-access") out.warn(c.codexFullAccess(tilde(ctx, config)));
  if (risk === "writable-root")
    out.warn(
      c.codexWritableHome(
        tilde(ctx, codexHome(ctx.userHome, ctx.env)),
        tilde(ctx, config),
      ),
    );
}

/**
 * Transcript state 8. Read-only: it changes nothing, execs only
 * `opencode --version`, and shows a token only as `oa_machine_…7f3a`.
 */
export async function doctor(ctx: Ctx): Promise<number> {
  const c = ctx.copy;
  const n = { failed: 0, warnings: 0, passed: 0 };
  const pass = (line: string) => {
    n.passed++;
    say(ctx, line);
  };
  const warn = (lines: string[]) => {
    n.warnings++;
    say(ctx, lines);
  };
  const fail = (lines: string[]) => {
    n.failed++;
    sayErr(ctx, lines);
  };
  say(ctx, c.header(ctx.version), "");

  const node = ctx.nodeVersion.replace(/^v/, "");
  if (Number(node.split(".")[0]) >= MIN_NODE) pass(c.nodeOk(node));
  else fail(c.nodeOld(node));

  const machineFile = tilde(ctx, join(ctx.home, "machine.json"));
  const m = readMachine(ctx.home);
  if (m.state !== "ok") fail(c.noCredentials(machineFile));
  else if (m.revoked) fail(c.revokedCheck());
  else pass(c.credentials(machineFile, m.token));

  // machine.json's hub; OA_BUS_HUB only matters before login.
  const hub = m.state === "ok" ? m.hub : ctx.env.OA_BUS_HUB;
  let seen: Promise<Health> | undefined;
  const health = () => {
    seen ??= healthz(ctx, hub ?? "");
    return seen;
  };

  const probe = await probeDaemon(ctx, { timeoutMs: 3000 });
  if (probe.state === "up") {
    const st = probe.st;
    const lines = c.daemonRunning(
      st.pid,
      ctx.service.kind,
      ctx.service.fallback,
    );
    if (ctx.service.kind) pass(lines[0] as string);
    else warn(lines);
    const update = await updateTarget(
      ctx,
      st,
      async () => (await health()).version,
    );
    if (update) warn(c.updateAvailable(update, st.version));
  } else
    fail(
      probe.state === "stalled"
        ? c.daemonNotResponding()
        : (socketFolderLines(ctx) ?? c.daemonNotRunning()),
    );
  for (const p of ctx.service.problems?.() ?? [])
    if (p.kind === "node-missing") fail(c.serviceNodeMissing(p.node));
    else warn(c.lingerOff());

  if (hub !== undefined) {
    const { error, problem } = await health();
    if (error === undefined) pass(c.hubReachable(hostOf(hub)));
    else fail(c.hubNotReachable(hostOf(hub), error, "doctor"));
    if (problem !== undefined) fail(c.hubProblem(problem));
  }

  const wiring = checkAdapters({
    home: ctx.userHome,
    busHome: ctx.home,
    env: ctx.env,
    which: ctx.which,
    codexApp: ctx.codexApp,
    busBin: ctx.service.argv?.(),
  });
  for (const h of ["claude", "opencode", "pi", "omp", "codex"] as Harness[]) {
    if (wiring[h] === "absent") continue;
    let version: string | undefined;
    if (h === "opencode") {
      // Checked before wiring: an OpenCode install skipped is not wired.
      version = await opencodeVersion(ctx.exec);
      if (version === undefined) {
        warn(c.opencodeUnknown());
        continue;
      }
      if (!supportsPromptId(version)) {
        warn(c.opencodeTooOld(version, MIN_PROMPT_ID_VERSION));
        continue;
      }
    }
    if (wiring[h] === "configured") pass(c.wired(h, version));
    else fail(c.notWired(h));
    if (h === "claude") {
      const settings = join(
        ctx.env.CLAUDE_CONFIG_DIR ?? join(ctx.userHome, ".claude"),
        "settings.json",
      );
      const isolates = claudeIsolates(settings);
      if (isolates === false) pass(c.claudeAccepts());
      if (isolates === true) warn(c.claudeIsolates(tilde(ctx, settings)));
    }
    if (h === "codex") codexChecks(ctx, { pass, warn });
  }

  const allow = globalFile(ctx.home);
  const list = readGlobalDirs(allow);
  if (list.error) warn(c.globalUnusable(tilde(ctx, allow), list.error));
  if (asksForGlobal(ctx, list.dirs)) warn(c.globalAsked());

  say(ctx, "", c.summary(n.failed, n.warnings, n.passed));
  return n.failed > 0 ? 1 : 0;
}
