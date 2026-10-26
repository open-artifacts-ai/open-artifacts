import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Two local installs under `wrangler dev`, on the redline build
// (__OA_TEST_HOOKS_ALLOWED__ true), each with its own port, secrets, D1/R2/KV/DO
// state, app and content hosts and TEST_DOMAIN. Everything lives in one fresh
// 0700 temp dir that stop() removes. Cleanup is PID-scoped: each wrangler runs
// in its own process group (detached), and only those groups are signalled.
// Secrets go to wrangler via a 0600 .dev.vars next to its config, never argv.

const ROOT = join(import.meta.dirname, "..", "..", "..");
const SERVER = join(ROOT, "apps", "server");
const WRANGLER = join(SERVER, "node_modules", ".bin", "wrangler");

/** The tenant fixtures (P5 plan, Task 3). */
export const LOCAL_INSTALLS = [
  { name: "rl-a", testDomain: "oa-redline-a.fyi" },
  { name: "rl-b", testDomain: "oa-redline-c.fyi" },
] as const;

const SECRET_NAMES = [
  "SESSION_SECRET",
  "CONTENT_SIGNING_KEY",
  "TEST_HOOK_KEY",
  "ACCESS_CLIENT_SECRET",
  "GOOGLE_CLIENT_SECRET",
] as const;

export interface LocalInstall {
  name: string;
  testDomain: string;
  installId: string;
  port: number;
  app: string;
  content: string;
  dir: string;
  config: string;
  persistTo: string;
  hookKeyFile: string;
  pid: number;
}

export interface LocalPair {
  dir: string;
  installs: LocalInstall[];
  /** REDLINE_TARGETS JSON (paths only, no secrets). */
  targets: string;
  targetsFile: string;
  /** Groups still live: one is dropped once confirmed empty and never signalled again. */
  pids: number[];
  /** Every process group spawned, live or finished (for reporting). */
  spawned: number[];
  /** Stops every spawned group, removes the temp dir; returns leftover pids (must be empty). */
  stop(): Promise<number[]>;
}

const rand = () => randomBytes(32).toString("base64url");

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      const p = typeof a === "object" && a ? a.port : 0;
      s.close(() => res(p));
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A minimal env for wrangler: no inherited secrets, an isolated HOME. */
function childEnv(dir: string): Record<string, string> {
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    WRANGLER_LOG_PATH: join(dir, "wrangler-logs"),
    WRANGLER_SEND_METRICS: "false",
    CI: "1",
    NO_COLOR: "1",
  };
}

function alive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Pids still in process group `pgid` (pgrep -g lists; it never signals). */
export function groupMembers(pgid: number): number[] {
  try {
    return execFileSync("pgrep", ["-g", String(pgid)], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .map(Number);
  } catch {
    return [];
  }
}

/** Direct children of this process (pgrep -P). */
export function ownChildren(): number[] {
  try {
    return execFileSync("pgrep", ["-P", String(process.pid)], {
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean)
      .map(Number);
  } catch {
    return [];
  }
}

async function killGroup(pgid: number): Promise<void> {
  if (!alive(pgid)) return;
  try {
    process.kill(-pgid, "SIGTERM");
  } catch {}
  for (let i = 0; i < 40 && alive(pgid); i++) await sleep(100);
  if (alive(pgid)) {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {}
    for (let i = 0; i < 20 && alive(pgid); i++) await sleep(100);
  }
}

/** Runs a wrangler subcommand to completion, bounded; output to a log file. */
function runWrangler(
  args: string[],
  env: Record<string, string>,
  log: string,
  timeoutMs: number,
  track: (c: ChildProcess) => void,
  exited: (pid: number) => void,
): Promise<void> {
  return new Promise((res, rej) => {
    const fd = openSync(log, "a", 0o600);
    const c = spawn(WRANGLER, args, {
      cwd: SERVER,
      env,
      detached: true,
      stdio: ["ignore", fd, fd],
    });
    closeSync(fd);
    track(c);
    const t = setTimeout(() => {
      // The exit handler below reaps the group once it is gone.
      if (c.pid) void killGroup(c.pid);
      rej(new Error(`wrangler ${args[0]} timed out`));
    }, timeoutMs);
    c.on("exit", (code) => {
      clearTimeout(t);
      if (c.pid) exited(c.pid);
      code === 0 ? res() : rej(new Error(`wrangler ${args[0]} exited ${code}`));
    });
    c.on("error", (e) => {
      clearTimeout(t);
      rej(e);
    });
  });
}

function wranglerConfig(
  i: { name: string; testDomain: string; installId: string },
  port: number,
) {
  const base = JSON.parse(
    readFileSync(join(SERVER, "wrangler.test.jsonc"), "utf8"),
  );
  const vars = { ...base.vars };
  for (const s of SECRET_NAMES) delete vars[s];
  base.d1_databases[0].migrations_dir = join(SERVER, "migrations");
  base.d1_databases[0].database_name = `oa-redline-${i.name}`;
  return {
    ...base,
    name: `oa-redline-local-${i.name}`,
    main: join(SERVER, "src", "index.ts"),
    define: { __OA_TEST_HOOKS_ALLOWED__: "true" },
    dev: { ip: "127.0.0.1", port, local_protocol: "http" },
    vars: {
      ...vars,
      APP_HOST: `${i.name}.app.localhost`,
      CONTENT_HOST: `${i.name}.content.localhost`,
      ENVIRONMENT: "dev",
      OWNER_EMAIL: `owner@${i.testDomain}`,
      INSTALL_ID: i.installId,
      TEST_HOOKS: "1",
      TEST_DOMAIN: i.testDomain,
      // As every hosted install (provision userWorkerMetadata; HOSTED_FEATURES
      // in src/surfaces.ts).
      FEATURES: "spaces,usage_off",
      // Sign-in (R6): codes, and Google on a client of its own (direct
      // transport; Google itself is never called). AUTH_DOMAINS stays off
      // TEST_DOMAIN so hook users sign in by code as guests.
      AUTH_PROVIDERS: "access,google,email",
      GOOGLE_CLIENT_ID: `${i.name}-local.apps.googleusercontent.com`,
      AUTH_DOMAINS: `sso-${i.name}.example`,
      EMAIL_FROM: `noreply@${i.name}.app.localhost`,
    },
    // Miniflare keeps sent mail local (never delivered).
    send_email: [{ name: "EMAIL" }],
  };
}

/** Redacts every given secret from `s` (for failure output from wrangler logs). */
export function redact(s: string, secrets: readonly string[]): string {
  let out = s;
  for (const v of secrets) if (v) out = out.split(v).join("[redacted]");
  return out;
}

async function waitHealthy(
  i: LocalInstall,
  deadline: number,
  signal?: AbortSignal,
): Promise<void> {
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("aborted");
    try {
      const r = await fetch(`${i.app}/healthz`, { redirect: "manual" });
      if (r.status === 200) {
        const h = (await r.json()) as {
          testHooks?: unknown;
          installId?: unknown;
        };
        if (h.testHooks === true && h.installId === i.installId) return;
        throw new Error(`${i.name} /healthz: testHooks or installId wrong`);
      }
      await r.body?.cancel();
    } catch (e) {
      if (e instanceof Error && e.message.includes("/healthz:")) throw e;
    }
    await sleep(500);
  }
  throw new Error(`${i.name} did not become healthy in time`);
}

export interface StartOpts {
  /** Per-install boot deadline (default 180 s). */
  bootMs?: number;
  /** Aborting stops everything spawned so far; startLocalPair then rejects. */
  signal?: AbortSignal;
  /** Called with each spawned process (group) id, as it is spawned. */
  onSpawn?: (pid: number) => void;
  /** Called once a spawned group is confirmed empty (never signal it after). */
  onReap?: (pid: number) => void;
}

/** Boots the pair. On any failure, everything spawned is stopped and removed before it throws. */
export async function startLocalPair(o: StartOpts = {}): Promise<LocalPair> {
  if (!existsSync(WRANGLER))
    throw new Error("wrangler missing: run pnpm install");
  if (!existsSync(join(SERVER, "src", "version.gen.ts")))
    throw new Error("server not generated: run pnpm -F @oa/server run gen");
  const dir = mkdtempSync(join(tmpdir(), "oa-redline-"));
  chmodSync(dir, 0o700);
  const pids: number[] = [];
  const spawned: number[] = [];
  const secrets: string[] = [];
  const installs: LocalInstall[] = [];
  /** Drops a group once it is confirmed empty; true when it is gone. */
  const reap = (pg: number): boolean => {
    if (!pids.includes(pg)) return true;
    if (alive(pg) || groupMembers(pg).length > 0) return false;
    pids.splice(pids.indexOf(pg), 1);
    o.onReap?.(pg);
    return true;
  };
  /** Signals a tracked, still-live group only. */
  const stopGroup = async (pg: number): Promise<void> => {
    if (reap(pg)) return;
    await killGroup(pg);
    reap(pg);
  };
  const track = (c: ChildProcess) => {
    if (!c.pid) return;
    pids.push(c.pid);
    spawned.push(c.pid);
    o.onSpawn?.(c.pid);
    if (o.signal?.aborted) void stopGroup(c.pid);
  };
  const exited = (pg: number) => {
    // The leader exited; the group may linger briefly (workerd children).
    if (!reap(pg)) setTimeout(() => reap(pg), 500).unref();
  };
  let stopped = false;
  const stop = async (): Promise<number[]> => {
    if (!stopped) {
      stopped = true;
      await Promise.all([...pids].map(stopGroup));
      rmSync(dir, { recursive: true, force: true });
    }
    // Only groups that refused to die stay tracked.
    return [...pids].flatMap(groupMembers);
  };
  try {
    o.signal?.addEventListener("abort", () => {
      for (const p of [...pids]) void stopGroup(p);
    });
    for (const spec of LOCAL_INSTALLS) {
      if (o.signal?.aborted) throw new Error("aborted");
      const sub = join(dir, spec.name);
      mkdirSync(sub, { mode: 0o700 });
      const port = await freePort();
      const inspector = await freePort();
      const installId = `${spec.name}-local-${randomBytes(3).toString("hex")}`;
      const values = Object.fromEntries(SECRET_NAMES.map((n) => [n, rand()]));
      secrets.push(...Object.values(values));
      writeFileSync(
        join(sub, ".dev.vars"),
        `${SECRET_NAMES.map((n) => `${n}="${values[n]}"`).join("\n")}\n`,
        { mode: 0o600 },
      );
      const hookKeyFile = join(sub, "hook-key");
      writeFileSync(hookKeyFile, `${values.TEST_HOOK_KEY}\n`, { mode: 0o600 });
      const config = join(sub, "wrangler.json");
      const cfg = wranglerConfig({ ...spec, installId }, port);
      writeFileSync(config, JSON.stringify(cfg, null, 2), { mode: 0o600 });
      const persistTo = join(sub, "state");
      const env = childEnv(sub);
      const log = join(sub, "wrangler.log");
      await runWrangler(
        [
          "d1",
          "migrations",
          "apply",
          cfg.d1_databases[0].database_name,
          "--local",
          "--config",
          config,
          "--persist-to",
          persistTo,
        ],
        env,
        log,
        120_000,
        track,
        exited,
      );
      const fd = openSync(log, "a", 0o600);
      const child = spawn(
        WRANGLER,
        [
          "dev",
          "--config",
          config,
          "--ip",
          "127.0.0.1",
          "--port",
          String(port),
          "--inspector-port",
          String(inspector),
          "--persist-to",
          persistTo,
          "--show-interactive-dev-session=false",
        ],
        { cwd: SERVER, env, detached: true, stdio: ["ignore", fd, fd] },
      );
      closeSync(fd);
      track(child);
      child.on("exit", () => child.pid && exited(child.pid));
      if (!child.pid)
        throw new Error(`${spec.name}: wrangler dev did not start`);
      installs.push({
        name: spec.name,
        testDomain: spec.testDomain,
        installId,
        port,
        app: `http://${spec.name}.app.localhost:${port}`,
        content: `http://${spec.name}.content.localhost:${port}`,
        dir: sub,
        config,
        persistTo,
        hookKeyFile,
        pid: child.pid,
      });
    }
    const deadline = Date.now() + (o.bootMs ?? 180_000);
    await Promise.all(installs.map((i) => waitHealthy(i, deadline, o.signal)));
    const [a, b] = installs.map((i) => ({
      name: i.name,
      installId: i.installId,
      app: i.app,
      content: i.content,
      testDomain: i.testDomain,
      cookieName: "oa_session",
      hookKeyFile: i.hookKeyFile,
      local: {
        wrangler: WRANGLER,
        config: i.config,
        persistTo: i.persistTo,
        db: `oa-redline-${i.name}`,
      },
    }));
    const targets = JSON.stringify({ mode: "local", a, b });
    const targetsFile = join(dir, "targets.json");
    writeFileSync(targetsFile, targets, { mode: 0o600 });
    return { dir, installs, targets, targetsFile, pids, spawned, stop };
  } catch (e) {
    // Failure output: the last log lines, secrets redacted; never env.
    for (const i of LOCAL_INSTALLS) {
      const log = join(dir, i.name, "wrangler.log");
      if (existsSync(log)) {
        const tail = readFileSync(log, "utf8")
          .split("\n")
          .slice(-15)
          .join("\n");
        process.stderr.write(
          `--- ${i.name} wrangler log (tail, redacted) ---\n${redact(tail, secrets)}\n`,
        );
      }
    }
    const left = await stop();
    if (left.length)
      process.stderr.write(`local-pair: leftover pids ${left.join(" ")}\n`);
    throw e;
  }
}

/** Reads one row count from a local install's D1 (local mode only). */
export function localD1Count(
  l: { wrangler: string; config: string; persistTo: string; db: string },
  sql: string,
): number {
  const dir = join(l.persistTo, "..");
  const out = execFileSync(
    l.wrangler,
    [
      "d1",
      "execute",
      l.db,
      "--local",
      "--config",
      l.config,
      "--persist-to",
      l.persistTo,
      "--json",
      "--command",
      sql,
    ],
    {
      cwd: SERVER,
      env: childEnv(dir),
      encoding: "utf8",
      timeout: 60_000,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const rows = JSON.parse(out)?.[0]?.results;
  const n = Array.isArray(rows)
    ? Number(Object.values(rows[0] ?? {})[0])
    : Number.NaN;
  if (!Number.isFinite(n)) throw new Error("local D1: unreadable count");
  return n;
}
