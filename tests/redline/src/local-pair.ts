import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
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
const BROKER_APP = join(ROOT, "apps", "auth-broker");
/** The local broker's worker name (installs bind it as BROKER via the dev registry). */
export const LOCAL_BROKER = "oa-redline-local-broker";
/** src/fake-idp/auth-core-shim.ts: fake-IdP builds only. */
export const FAKE_IDP_SHIM = join(
  import.meta.dirname,
  "fake-idp",
  "auth-core-shim.ts",
);

/**
 * A fake-IdP pair (the no-human rehearsal): the installs sign in with Google
 * through a local auth broker, and both use the fake IdP at `origin` (its URLs
 * and key swapped in at build time by the shim). Local builds only.
 */
export interface FakeIdpPair {
  origin: string;
  publicJwk: JsonWebKey;
  /** The broker's (shared) Google client. */
  clientId: string;
  clientSecret: string;
  /** Each install's verified Google domain (AUTH_DOMAINS), a then b. */
  tenants: readonly [string, string];
  /** The fake IdP's registered redirect URIs for clientId; the broker's is pushed here. */
  redirectUris: string[];
}

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
  /** A fake-IdP pair's local auth broker. */
  broker?: LocalBroker;
  /** Stops every spawned group, removes the temp dir; returns leftover pids (must be empty). */
  stop(): Promise<number[]>;
}

const rand = () => randomBytes(32).toString("base64url");

/** A loopback port, held (listening) until `release`, so nothing else takes it meanwhile. */
export interface Reserved {
  port: number;
  release(): Promise<void>;
}

/**
 * Reserves a free loopback port and keeps it bound until released, right
 * before the process that needs it starts: a port picked long before wrangler
 * binds it (migrations, the broker's boot) could be taken in between.
 */
export function reservePort(): Promise<Reserved> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      s.unref();
      const a = s.address();
      let done: Promise<void> | undefined;
      res({
        port: typeof a === "object" && a ? a.port : 0,
        release: () => (done ??= new Promise<void>((r) => s.close(() => r()))),
      });
    });
  });
}

/** Why a spawned wrangler is gone, or undefined while it runs (log: its output). */
export function exitReason(
  what: string,
  code: number | null | undefined,
  log: string,
): string | undefined {
  if (code === undefined) return undefined;
  let tail = "";
  try {
    tail = readFileSync(log, "utf8");
  } catch {}
  const port = /EADDRINUSE|address already in use/i.test(tail)
    ? " (its port was taken: EADDRINUSE)"
    : "";
  return `${what}: wrangler dev exited early (code ${code})${port}; see ${log}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A minimal env for wrangler: no inherited secrets, an isolated HOME. */
function childEnv(dir: string, registry?: string): Record<string, string> {
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return {
    // A fake-IdP pair: every wrangler shares one dev registry, so the
    // installs' BROKER service binding reaches the local broker.
    ...(registry ? { WRANGLER_REGISTRY_PATH: registry } : {}),
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
  cwd = SERVER,
): Promise<void> {
  return new Promise((res, rej) => {
    const fd = openSync(log, "a", 0o600);
    const c = spawn(WRANGLER, args, {
      cwd,
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

/** The fake-IdP build: Google's URLs and key swapped (src/fake-idp/auth-core-shim.ts). */
const fakeIdpBuild = (idp: FakeIdpPair) => ({
  define: {
    __OA_FAKE_IDP__: JSON.stringify(idp.origin),
    __OA_FAKE_IDP_JWK__: JSON.stringify(JSON.stringify(idp.publicJwk)),
  },
  alias: { "@oa/auth-core": FAKE_IDP_SHIM },
});

interface InstallIdp {
  pair: FakeIdpPair;
  tenant: string;
  /** The broker's public (https) origin: the browser leg and AUTH_BROKER_URL. */
  brokerOrigin: string;
}

/**
 * The local pair's FEATURES. "base": every hosted install's
 * `spaces,usage_off` (provision userWorkerMetadata; HOSTED_FEATURES in
 * src/surfaces.ts). "google": the tiers the staging pair moves to: rl-a
 * frozen sync, rl-b Google sync with no directory binding (the space mapping
 * probes then need the directory-groups hook seed), both with content
 * revocation.
 */
export type LocalMode = "base" | "google";
export const LOCAL_MODES: readonly LocalMode[] = ["base", "google"];
export function localFeatures(name: string, mode: LocalMode = "base"): string {
  if (mode === "base") return "spaces,usage_off";
  const sync = name === "rl-b" ? "sync_google" : "sync_frozen";
  return `spaces,${sync},content_revocation,usage_off`;
}

/** REDLINE_LOCAL_MODE (default "base"); throws on any other value. */
export function localModeOf(
  env: Record<string, string | undefined> = process.env,
): LocalMode {
  const m = env.REDLINE_LOCAL_MODE || "base";
  const known = LOCAL_MODES.find((x) => x === m);
  if (!known)
    throw new Error(
      `REDLINE_LOCAL_MODE must be one of ${LOCAL_MODES.join(", ")}`,
    );
  return known;
}

function wranglerConfig(
  i: { name: string; testDomain: string; installId: string },
  port: number,
  idp?: InstallIdp,
  mode: LocalMode = "base",
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
    define: {
      __OA_TEST_HOOKS_ALLOWED__: "true",
      ...(idp ? fakeIdpBuild(idp.pair).define : {}),
    },
    ...(idp
      ? {
          alias: fakeIdpBuild(idp.pair).alias,
          services: [{ binding: "BROKER", service: LOCAL_BROKER }],
        }
      : {}),
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
      // As a hosted install of the chosen tier (localFeatures).
      FEATURES: localFeatures(i.name, mode),
      // Sign-in (R6): codes, and Google on a client of its own (direct
      // transport; Google itself is never called). AUTH_DOMAINS stays off
      // TEST_DOMAIN so hook users sign in by code as guests.
      AUTH_PROVIDERS: "access,google,email",
      GOOGLE_CLIENT_ID: `${i.name}-local.apps.googleusercontent.com`,
      AUTH_DOMAINS: `sso-${i.name}.example`,
      EMAIL_FROM: `noreply@${i.name}.app.localhost`,
      // A fake-IdP pair: Google through the local broker (as hosted), with
      // the tenant's domain verified; TEST_DOMAIN stays outside it.
      ...(idp
        ? {
            AUTH_BROKER_URL: idp.brokerOrigin,
            AUTH_DOMAINS: idp.tenant,
            GOOGLE_CLIENT_ID: idp.pair.clientId,
          }
        : {}),
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

/**
 * Until the install answers as itself (its random installId, test hooks on).
 * `gone` reports a wrangler that already exited: fail now, not at the deadline.
 */
export async function waitHealthy(
  i: Pick<LocalInstall, "name" | "app" | "installId">,
  deadline: number,
  signal?: AbortSignal,
  gone: () => string | undefined = () => undefined,
): Promise<void> {
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("aborted");
    const why = gone();
    if (why) throw new Error(why);
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

/**
 * Until our broker answers: a well-formed authorize for one of our installs
 * redirects to the fake IdP with our client id (only a broker holding our
 * registry and config can). A redirect anywhere else is another process on
 * the port: fail now. `gone` reports a wrangler that already exited.
 */
export async function waitBroker(
  b: { url: string },
  probe: { installId: string; clientId: string },
  deadline: number,
  signal?: AbortSignal,
  gone: () => string | undefined = () => undefined,
): Promise<void> {
  const q = new URLSearchParams({
    install: probe.installId,
    state: "redline-probe",
    nonce: "redline-probe",
    code_challenge: "A".repeat(43),
  });
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("aborted");
    const why = gone();
    if (why) throw new Error(why);
    try {
      const r = await fetch(`${b.url}/google/authorize?${q}`, {
        redirect: "manual",
      });
      await r.body?.cancel();
      if (r.status === 302) {
        const to = new URL(r.headers.get("location") ?? "", b.url);
        if (to.searchParams.get("client_id") === probe.clientId) return;
        throw new Error(
          `the local broker port answers as something else (a redirect to ${to.origin})`,
        );
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("the local broker port"))
        throw e;
    }
    await sleep(500);
  }
  throw new Error("the local broker did not come up in time");
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
  /**
   * A fake-IdP pair (the no-human rehearsal): also boots a local auth broker,
   * and both installs sign in with Google through it against the fake IdP.
   * Each install's TEST_DOMAIN then moves to hooks-<name>.example, outside
   * its Google tenant (as on staging).
   */
  idp?: FakeIdpPair;
  /** The installs' FEATURES (localFeatures); default "base". */
  mode?: LocalMode;
}

/** The local auth broker of a fake-IdP pair. */
export interface LocalBroker {
  /** Its public origin (https, as the installs and the registry name it). */
  origin: string;
  /** Where it really listens (http on loopback). */
  url: string;
  pid: number;
}

/** A fake-IdP pair's install origins are https in the registry; they serve http. */
export const registryOrigin = (app: string) => app.replace(/^http:/, "https:");

/** An install's Ed25519 broker key: PKCS#8 (its secret) and the registry's public half. */
function brokerKey(): { pkcs8: string; x: string; kid: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pkcs8 = privateKey
    .export({ format: "der", type: "pkcs8" })
    .toString("base64url");
  const x = (publicKey.export({ format: "jwk" }) as { x: string }).x;
  const kid = createHash("sha256")
    .update(Buffer.from(x, "base64url"))
    .digest("base64url")
    .slice(0, 16);
  return { pkcs8, x, kid };
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
  /** Ports still held for a process that hasn't started (released on any exit). */
  const held: Reserved[] = [];
  const hold = async (): Promise<number> => {
    const r = await reservePort();
    held.push(r);
    return r.port;
  };
  const releaseHeld = (ports: number[]) =>
    Promise.all(
      held.filter((r) => ports.includes(r.port)).map((r) => r.release()),
    );
  /** Each spawned wrangler dev's exit code once it exited (null: by signal). */
  const exits = new Map<number, number | null>();
  let stopped = false;
  const stop = async (): Promise<number[]> => {
    await Promise.all(held.map((r) => r.release()));
    if (!stopped) {
      stopped = true;
      await Promise.all([...pids].map(stopGroup));
      rmSync(dir, { recursive: true, force: true });
    }
    // Only groups that refused to die stay tracked.
    return [...pids].flatMap(groupMembers);
  };
  /**
   * wrangler dev in its own process group, output to `log`. Its two ports are
   * released from their reservation only now, right before it binds them.
   */
  const dev = async (
    what: string,
    config: string,
    port: number,
    persistTo: string,
    env: Record<string, string>,
    log: string,
    inspector: number,
    cwd = SERVER,
  ): Promise<{ pid: number; gone: () => string | undefined }> => {
    await releaseHeld([port, inspector]);
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
      { cwd, env, detached: true, stdio: ["ignore", fd, fd] },
    );
    closeSync(fd);
    track(child);
    child.on("exit", (code) => {
      if (!child.pid) return;
      exits.set(child.pid, code);
      exited(child.pid);
    });
    if (!child.pid) throw new Error(`${what}: wrangler dev did not start`);
    const pid = child.pid;
    return {
      pid,
      gone: () =>
        exits.has(pid) ? exitReason(what, exits.get(pid), log) : undefined,
    };
  };
  const gone = new Map<number, () => string | undefined>();
  let broker: LocalBroker | undefined;
  try {
    o.signal?.addEventListener("abort", () => {
      for (const p of [...pids]) void stopGroup(p);
    });
    const registry = o.idp ? join(dir, "dev-registry") : undefined;
    if (registry) mkdirSync(registry, { mode: 0o700 });
    // Ports, ids and broker keys first: the broker's registry names them.
    const plan: {
      spec: (typeof LOCAL_INSTALLS)[number];
      port: number;
      inspector: number;
      installId: string;
      key?: ReturnType<typeof brokerKey>;
    }[] = [];
    for (const spec of LOCAL_INSTALLS)
      plan.push({
        spec,
        port: await hold(),
        inspector: await hold(),
        installId: `${spec.name}-local-${randomBytes(3).toString("hex")}`,
        ...(o.idp ? { key: brokerKey() } : {}),
      });

    if (o.idp) broker = await bootBroker(o.idp, plan);

    for (const [
      n,
      { spec, port, inspector, installId, key },
    ] of plan.entries()) {
      if (o.signal?.aborted) throw new Error("aborted");
      const sub = join(dir, spec.name);
      mkdirSync(sub, { mode: 0o700 });
      const testDomain = o.idp ? `hooks-${spec.name}.example` : spec.testDomain;
      const values: Record<string, string> = Object.fromEntries(
        SECRET_NAMES.map((n) => [n, rand()]),
      );
      if (key) values.BROKER_SIGNING_KEY = key.pkcs8;
      secrets.push(...Object.values(values));
      writeFileSync(
        join(sub, ".dev.vars"),
        `${Object.entries(values)
          .map(([k, v]) => `${k}="${v}"`)
          .join("\n")}\n`,
        { mode: 0o600 },
      );
      const hookKeyFile = join(sub, "hook-key");
      writeFileSync(hookKeyFile, `${values.TEST_HOOK_KEY}\n`, { mode: 0o600 });
      const config = join(sub, "wrangler.json");
      const cfg = wranglerConfig(
        { name: spec.name, testDomain, installId },
        port,
        o.idp && broker
          ? {
              pair: o.idp,
              tenant: o.idp.tenants[n] as string,
              brokerOrigin: broker.origin,
            }
          : undefined,
        o.mode,
      );
      writeFileSync(config, JSON.stringify(cfg, null, 2), { mode: 0o600 });
      const persistTo = join(sub, "state");
      const env = childEnv(sub, registry);
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
      const { pid, gone: g } = await dev(
        spec.name,
        config,
        port,
        persistTo,
        env,
        log,
        inspector,
      );
      gone.set(pid, g);
      installs.push({
        name: spec.name,
        testDomain,
        installId,
        port,
        app: `http://${spec.name}.app.localhost:${port}`,
        content: `http://${spec.name}.content.localhost:${port}`,
        dir: sub,
        config,
        persistTo,
        hookKeyFile,
        pid,
      });
    }
    const deadline = Date.now() + (o.bootMs ?? 180_000);
    await Promise.all([
      ...installs.map((i) =>
        waitHealthy(i, deadline, o.signal, gone.get(i.pid)),
      ),
      ...(broker && o.idp
        ? [
            waitBroker(
              broker,
              {
                installId: (plan[0] as (typeof plan)[number]).installId,
                clientId: o.idp.clientId,
              },
              deadline,
              o.signal,
              gone.get(broker.pid),
            ),
          ]
        : []),
    ]);
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
    return {
      dir,
      installs,
      targets,
      targetsFile,
      pids,
      spawned,
      stop,
      ...(broker ? { broker } : {}),
    };

    /** The local auth broker: its config, the registry entries, wrangler dev. */
    async function bootBroker(
      idp: FakeIdpPair,
      installsPlan: typeof plan,
    ): Promise<LocalBroker> {
      const sub = join(dir, "broker");
      mkdirSync(sub, { mode: 0o700 });
      const port = await hold();
      const inspector = await hold();
      const origin = `https://auth.localhost:${port}`;
      idp.redirectUris.push(`${origin}/google/callback`);
      const values = {
        GOOGLE_CLIENT_SECRET: idp.clientSecret,
        BROKER_STATE_KEY: rand(),
      };
      secrets.push(...Object.values(values));
      writeFileSync(
        join(sub, ".dev.vars"),
        `${Object.entries(values)
          .map(([k, v]) => `${k}="${v}"`)
          .join("\n")}\n`,
        { mode: 0o600 },
      );
      const base = JSON.parse(
        readFileSync(join(BROKER_APP, "wrangler.test.jsonc"), "utf8"),
      );
      const build = fakeIdpBuild(idp);
      const cfg = {
        name: LOCAL_BROKER,
        main: join(BROKER_APP, "src", "index.ts"),
        compatibility_date: base.compatibility_date,
        kv_namespaces: [{ binding: "BROKER_REGISTRY", id: "redline-registry" }],
        ratelimits: base.ratelimits,
        define: build.define,
        alias: build.alias,
        dev: { ip: "127.0.0.1", port, local_protocol: "http" },
        vars: { GOOGLE_CLIENT_ID: idp.clientId, BROKER_ORIGIN: origin },
      };
      const config = join(sub, "wrangler.json");
      writeFileSync(config, JSON.stringify(cfg, null, 2), { mode: 0o600 });
      const persistTo = join(sub, "state");
      const env = childEnv(sub, registry);
      const log = join(sub, "wrangler.log");
      for (const [n, p] of installsPlan.entries()) {
        if (!p.key) throw new Error("broker: an install has no key");
        // Public data only (origin, public key, domains): argv is fine.
        const entry = {
          installId: p.installId,
          origin: registryOrigin(
            `http://${p.spec.name}.app.localhost:${p.port}`,
          ),
          keys: [{ kid: p.key.kid, x: p.key.x }],
          domains: [idp.tenants[n]],
        };
        await runWrangler(
          [
            "kv",
            "key",
            "put",
            `install:${p.installId}`,
            JSON.stringify(entry),
            "--binding",
            "BROKER_REGISTRY",
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
          BROKER_APP,
        );
      }
      const { pid, gone: g } = await dev(
        "broker",
        config,
        port,
        persistTo,
        env,
        log,
        inspector,
        BROKER_APP,
      );
      gone.set(pid, g);
      return { origin, url: `http://127.0.0.1:${port}`, pid };
    }
  } catch (e) {
    // Failure output: the last log lines, secrets redacted; never env.
    for (const i of [...LOCAL_INSTALLS.map((x) => x.name), "broker"]) {
      const log = join(dir, i, "wrangler.log");
      if (existsSync(log)) {
        const tail = readFileSync(log, "utf8")
          .split("\n")
          .slice(-15)
          .join("\n");
        process.stderr.write(
          `--- ${i} wrangler log (tail, redacted) ---\n${redact(tail, secrets)}\n`,
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
