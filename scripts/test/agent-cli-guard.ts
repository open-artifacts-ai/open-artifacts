/**
 * Vitest setupFile (#2168): no test may run a real agent CLI or touch the
 * developer's real harness config. Wire it LAST in `setupFiles` of every
 * Node-environment config (after any file that sets its own HOME); the
 * meta-test fails when a Node config is neither wired nor allowlisted.
 *
 * 1. HOME and every harness-home variable the source honors point into a
 *    temp dir, unless a test or an earlier setup file already put them
 *    inside one: XDG_CONFIG_HOME, USERPROFILE, CLAUDE_CONFIG_DIR,
 *    CODEX_HOME, OA_BUS_HOME, PI_CODING_AGENT_DIR, HERMES_HOME,
 *    OPENCLAW_STATE_DIR, OPENCODE_CONFIG_DIR. OPENCLAW_HOME and
 *    OA_BUS_CLAUDE_SESSIONS_DIR are deleted when outside a temp dir (they
 *    are bases or overrides that otherwise default under HOME). Name-only
 *    variables (PI_CONFIG_DIR, PI_PROFILE, OMP_PROFILE) resolve under HOME
 *    and are left alone.
 * 2. A stub bin dir goes first on PATH with claude, codex, pi, omp, hermes,
 *    openclaw, opencode and oa-bus. Each prints a message and exits 97, so
 *    even `bash -c '... pi mcp add ...'` cannot reach a real binary. This is
 *    the only protection inside worker_threads, which get an unpatched
 *    child_process, and inside any child process.
 * 3. In the main thread of each test worker, child_process spawn,
 *    spawnSync, execFile, execFileSync, exec and execSync throw when:
 *    - the command (or the command after env/nohup/exec/command) is a
 *      guarded CLI that resolves, by path or by the PATH in options.env, to
 *      a binary outside the stub dir and temp dirs; or
 *    - ANY argv element or shell word is an absolute path whose basename is
 *      a guarded CLI outside the stub dir and temp dirs (`timeout 5 /abs/pi`,
 *      `env -u X /abs/pi`, `sh -c "/abs/pi"`, `cd / && /abs/pi`).
 *    - ANY argv element or shell word is an absolute path whose real path
 *      is the target of a guarded CLI symlink found on the PATH at setup
 *      (`node /abs/.../pi-coding-agent/dist/cli.js`, `bun /abs/cli.js`),
 *      outside the stub dir and temp dirs. The targets are collected from
 *      the PATH before the stub dir goes on it (see guardEntriesOn).
 *    Not covered: a CLI reached by a bare name inside a shell string after
 *    the first word (PATH stubs cover it), a path built at run time inside
 *    the child, a JS entry the PATH does not link to, or a CLI whose
 *    entry is a relative path with a changed cwd inside a shell string.
 * Trusted by design: anything under a temp dir (/tmp, /var/tmp, os.tmpdir),
 * where tests build their own fakes, including symlinks to system tools.
 * Not exercised: the DEFAULT_PATH fallback and the macOS /private symlink
 * handling.
 */
import type * as cpTypes from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";

export const AGENT_CLIS = [
  "claude",
  "codex",
  "pi",
  "omp",
  "hermes",
  "openclaw",
  "opencode",
  "oa-bus",
] as const;
const CLI_SET: ReadonlySet<string> = new Set(AGENT_CLIS);
export const BLOCK_EXIT = 97;
export const blockMessage = (name: string) =>
  `real ${name} blocked by the test guard (#2168)`;

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};
const under = (p: string, dir: string) =>
  p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep);

const TMP = real(tmpdir());
/** Where tests make their own fake CLIs: the OS temp dir or a literal /tmp. */
const TMP_ROOTS = [...new Set([TMP, real("/tmp"), real("/var/tmp")])];
const GUARD_DIR = real(mkdtempSync(join(TMP, "oa-agent-cli-guard-")));
export const STUB_DIR = join(GUARD_DIR, "bin");
mkdirSync(STUB_DIR);
mkdirSync(join(GUARD_DIR, "home"));
for (const name of AGENT_CLIS) {
  const file = join(STUB_DIR, name);
  writeFileSync(
    file,
    `#!/bin/sh\necho "${blockMessage(name)}" >&2\nexit ${BLOCK_EXIT}\n`,
  );
  chmodSync(file, 0o755);
}
// One exit listener per process; setup files re-run for every test file.
const DIRS = Symbol.for("oa.agentCliGuard.dirs");
const g = globalThis as unknown as Record<symbol, string[] | undefined>;
if (!g[DIRS]) {
  const dirs: string[] = [];
  g[DIRS] = dirs;
  process.on("exit", () => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
}
g[DIRS]?.push(GUARD_DIR);

// 1. Config homes. Package-manager caches are not harness config: keep
// corepack on its real cache (by path only, never read here), or a spawned
// `pnpm` in a temp workspace would download itself under the temp HOME.
if (!process.env.COREPACK_HOME && process.env.HOME)
  process.env.COREPACK_HOME = join(
    process.env.XDG_CACHE_HOME ?? join(process.env.HOME, ".cache"),
    "node",
    "corepack",
  );
const inTmp = (v: string | undefined) =>
  !!v && TMP_ROOTS.some((t) => under(real(v), t));
if (!inTmp(process.env.HOME)) process.env.HOME = join(GUARD_DIR, "home");
const HOME = process.env.HOME as string;
const place = (name: string, rel: string) => {
  if (!inTmp(process.env[name])) process.env[name] = join(HOME, rel);
};
place("XDG_CONFIG_HOME", ".config");
place("USERPROFILE", ".");
place("OPENCLAW_STATE_DIR", ".openclaw");
place("OPENCODE_CONFIG_DIR", join(".config", "opencode"));
for (const k of ["OPENCLAW_HOME", "OA_BUS_CLAUDE_SESSIONS_DIR"])
  if (!inTmp(process.env[k])) delete process.env[k];
place("CLAUDE_CONFIG_DIR", ".claude");
place("CODEX_HOME", ".codex");
place("OA_BUS_HOME", ".oa-bus");
place("PI_CODING_AGENT_DIR", join(".pi", "agent"));
place("HERMES_HOME", ".hermes");

// Real files the guarded names resolve to on a PATH: a bin symlink such as
// `pi -> ../lib/node_modules/.../dist/cli.js` runs the same code as
// `node <abs>/cli.js`. Anything under the stub dir or a temp dir is left out.
const ENTRIES = new Set<string>();
// Kept only when the target looks like the CLI's own entry: a guarded
// basename or a JS file. A shared shim (volta-shim, mise) is not an entry,
// nor is a target that a non-guarded executable in the same dir also
// resolves to (blocking it would block `node`, `npm`, ...).
export function guardEntriesOn(path: string): void {
  for (const d of path.split(delimiter)) {
    if (!d) continue;
    let siblings: string[] | undefined;
    for (const n of AGENT_CLIS) {
      const f = join(d, n);
      if (!isExecFile(f)) continue;
      const r = real(f);
      if (under(r, STUB_DIR) || TMP_ROOTS.some((t) => under(r, t))) continue;
      if (!CLI_SET.has(basename(r)) && !/\.[cm]?js$/.test(r)) continue;
      siblings ??= readdirSync(d)
        .filter((e) => !CLI_SET.has(e))
        .map((e) => real(join(d, e)));
      if (siblings.includes(r)) continue;
      ENTRIES.add(r);
    }
  }
}
function isExecFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}
guardEntriesOn(process.env.PATH ?? "");

// 2. Stub dir first on PATH.
const pathParts = (process.env.PATH ?? "")
  .split(delimiter)
  .filter((p) => p && p !== STUB_DIR);
process.env.PATH = [STUB_DIR, ...pathParts].join(delimiter);

// 3. child_process wrappers.
const isExec = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};
// Lexical and real parent dir both count, so a fake that is a symlink to a
// system tool (perl, node) inside a temp dir stays allowed.
const allowed = (p: string) => {
  const dirs = [dirname(resolve(p)), real(dirname(resolve(p)))];
  return dirs.some(
    (d) => under(d, STUB_DIR) || TMP_ROOTS.some((t) => under(d, t)),
  );
};
const DEFAULT_PATH = "/usr/local/bin:/usr/bin:/bin";
const WRAPPERS = new Set(["env", "nohup", "exec", "command"]);

/** Throws on any word that is an absolute path to a real guarded CLI. */
function scanWords(parts: readonly string[], cwd: string | undefined): void {
  for (const part of parts)
    for (const w of part.split(/[\s;&|()"'`$<>=]+/))
      if (w.startsWith("/")) {
        const abs = resolve(cwd ?? process.cwd(), w);
        if (CLI_SET.has(basename(w))) refuse(basename(w), abs);
        else if (ENTRIES.size > 0 && ENTRIES.has(real(abs)))
          refuse(basename(w), real(abs));
      }
}

function refuse(name: string, p: string): void {
  if (!allowed(p))
    throw new Error(
      `${blockMessage(name)}: refused to run the real binary ${p}. Put a fake ${name} in a temp dir on PATH, or inject a fake exec function.`,
    );
}

function check(
  cmd: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv | undefined,
  cwd: string | undefined,
  depth = 0,
): void {
  if (!cmd || depth > 4) return;
  const name = basename(cmd);
  if (WRAPPERS.has(name)) {
    const rest = [...args];
    while (rest[0]?.startsWith("-") || /^[A-Za-z_]\w*=/.test(rest[0] ?? ""))
      rest.shift();
    const next = rest.shift();
    if (next) check(next, rest, env, cwd, depth + 1);
    return;
  }
  if (!CLI_SET.has(name)) return;
  const found: string[] = [];
  if (cmd.includes("/")) found.push(resolve(cwd ?? process.cwd(), cmd));
  else {
    const path = env ? (env.PATH ?? DEFAULT_PATH) : (process.env.PATH ?? "");
    for (const d of path.split(delimiter))
      if (d && isExec(join(d, cmd))) {
        found.push(join(d, cmd));
        break;
      }
  }
  for (const p of found) refuse(name, p);
}

/** The command a shell string starts with, skipping VAR=value words. */
function checkShellString(
  line: string,
  env: NodeJS.ProcessEnv | undefined,
  cwd: string | undefined,
): void {
  const words = line.trim().split(/\s+/);
  while (/^[A-Za-z_]\w*=/.test(words[0] ?? "")) words.shift();
  const first = words.shift();
  if (first) check(first.replace(/^['"]|['"]$/g, ""), words, env, cwd);
}

type Opts = { env?: NodeJS.ProcessEnv; cwd?: string | URL; shell?: unknown };
const optsOf = (a: unknown[]): Opts => {
  for (const x of a)
    if (x && typeof x === "object" && !Array.isArray(x)) return x as Opts;
  return {};
};
const cwdOf = (o: Opts) => (typeof o.cwd === "string" ? o.cwd : undefined);

const GUARDED = Symbol.for("oa.agentCliGuard");
const req = createRequire(import.meta.url);
const target = req("node:child_process") as typeof cpTypes & {
  [GUARDED]?: boolean;
};
type Fn = (...a: unknown[]) => unknown;
/** Wrap `orig` so `inspect` runs first; the result and `this` pass through
 * untouched. promisify.custom (execFile, exec) is wrapped too, or
 * util.promisify would fall back to a generic version that drops the
 * `child` on the returned promise and changes timeout behavior. */
function guarded(orig: Fn, inspect: (a: unknown[]) => void): Fn {
  const wrapper = function (this: unknown, ...a: unknown[]) {
    inspect(a);
    return orig.apply(this, a);
  };
  const custom = (orig as unknown as Record<symbol, Fn | undefined>)[
    promisify.custom
  ];
  if (custom)
    (wrapper as unknown as Record<symbol, Fn>)[promisify.custom] = function (
      this: unknown,
      ...a: unknown[]
    ) {
      inspect(a);
      return custom.apply(this, a);
    };
  return wrapper;
}

if (!target[GUARDED]) {
  target[GUARDED] = true;
  const t = target as unknown as Record<string, Fn>;
  for (const fn of ["spawn", "spawnSync", "execFile", "execFileSync"])
    t[fn] = guarded(t[fn] as Fn, (a) => {
      const opts = optsOf(a.slice(1));
      const file = String(a[0]);
      const args = Array.isArray(a[1]) ? (a[1] as string[]) : [];
      scanWords([file, ...args], cwdOf(opts));
      if (opts.shell) checkShellString(file, opts.env, cwdOf(opts));
      else check(file, args, opts.env, cwdOf(opts));
    });
  for (const fn of ["exec", "execSync"])
    t[fn] = guarded(t[fn] as Fn, (a) => {
      const opts = optsOf(a.slice(1));
      scanWords([String(a[0])], cwdOf(opts));
      checkShellString(String(a[0]), opts.env, cwdOf(opts));
    });
  syncBuiltinESMExports();
}
