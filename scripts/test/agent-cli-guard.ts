/**
 * Vitest setupFile (#2168): no test may run a real agent CLI or touch the
 * developer's real harness config. Wire it LAST in `setupFiles` of every
 * Node-environment config (after any file that sets its own HOME).
 *
 * 1. HOME, XDG_CONFIG_HOME, CLAUDE_CONFIG_DIR, CODEX_HOME, OA_BUS_HOME,
 *    PI_CODING_AGENT_DIR and HERMES_HOME point into a temp dir, unless a
 *    test or an earlier setup file already put them inside one.
 * 2. A stub bin dir goes first on PATH with claude, codex, pi, omp, hermes,
 *    openclaw, opencode and oa-bus. Each prints a message and exits 97, so
 *    even `bash -c '... pi mcp add ...'` cannot reach a real binary.
 * 3. child_process spawn, spawnSync, execFile, execFileSync, exec and
 *    execSync throw when the command is one of those CLIs and resolves to a
 *    real binary (a path outside the stub dir and the OS temp dir). Tests
 *    that put their own fake CLI in a temp dir, or inject a fake exec
 *    function, are unaffected.
 */
import type * as cpTypes from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve, sep } from "node:path";

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
for (const name of AGENT_CLIS) {
  const file = join(STUB_DIR, name);
  writeFileSync(
    file,
    `#!/bin/sh\necho "${blockMessage(name)}" >&2\nexit ${BLOCK_EXIT}\n`,
  );
  chmodSync(file, 0o755);
}
process.on("exit", () => rmSync(GUARD_DIR, { recursive: true, force: true }));

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
place("CLAUDE_CONFIG_DIR", ".claude");
place("CODEX_HOME", ".codex");
place("OA_BUS_HOME", ".oa-bus");
place("PI_CODING_AGENT_DIR", join(".pi", "agent"));
place("HERMES_HOME", ".hermes");

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
  for (const p of found)
    if (!allowed(p))
      throw new Error(
        `${blockMessage(name)}: refused to run the real binary ${p}. Put a fake ${name} in a temp dir on PATH, or inject a fake exec function.`,
      );
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
if (!target[GUARDED]) {
  target[GUARDED] = true;
  const fileFns = ["spawn", "spawnSync", "execFile", "execFileSync"] as const;
  for (const fn of fileFns) {
    const orig = target[fn] as (...a: unknown[]) => unknown;
    (target as unknown as Record<string, unknown>)[fn] = function (
      this: unknown,
      ...a: unknown[]
    ) {
      const opts = optsOf(a.slice(1));
      const file = String(a[0]);
      const args = Array.isArray(a[1]) ? (a[1] as string[]) : [];
      if (opts.shell) checkShellString(file, opts.env, cwdOf(opts));
      else check(file, args, opts.env, cwdOf(opts));
      return orig.apply(this, a);
    };
  }
  for (const fn of ["exec", "execSync"] as const) {
    const orig = target[fn] as (...a: unknown[]) => unknown;
    (target as unknown as Record<string, unknown>)[fn] = function (
      this: unknown,
      ...a: unknown[]
    ) {
      const opts = optsOf(a.slice(1));
      checkShellString(String(a[0]), opts.env, cwdOf(opts));
      return orig.apply(this, a);
    };
  }
  syncBuiltinESMExports();
}
