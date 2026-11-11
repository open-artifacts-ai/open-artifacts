import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

type Env = Record<string, string | undefined>;

const placeholder = (v: string | undefined): string | undefined => {
  const t = v?.trim();
  return !t || t === "undefined" || t === "null" ? undefined : t;
};

/**
 * OpenClaw's effective home. Mirrors resolveRequiredHomeDir in OpenClaw
 * 2026.6.5 (dist/config-utils-BEvSJyjG.js): OPENCLAW_HOME, else HOME, else
 * USERPROFILE, else the OS home; a leading `~` in OPENCLAW_HOME is the raw home.
 */
function homeDir(env: Env, home: () => string): string {
  const raw = () =>
    placeholder(env.HOME) ??
    placeholder(env.USERPROFILE) ??
    placeholder(home());
  const explicit = placeholder(env.OPENCLAW_HOME);
  const base = explicit
    ? explicit.replace(/^~(?=$|[\\/])/, raw() ?? "")
    : raw();
  return base ? resolve(base) : resolve(process.cwd());
}

const userPath = (input: string, env: Env, home: () => string): string => {
  const t = input.trim();
  return t.startsWith("~")
    ? resolve(t.replace(/^~(?=$|[\\/])/, homeDir(env, home)))
    : resolve(t);
};

/**
 * The state directory of the OpenClaw process this plugin runs in. Mirrors
 * OpenClaw 2026.6.5:
 * - resolveStateDir (dist/config-utils-BEvSJyjG.js): OPENCLAW_STATE_DIR, else
 *   <home>/.openclaw, else a legacy <home>/.clawdbot when only that exists.
 * - OPENCLAW_PROFILE is not read: resolveStateDir ignores it. Only the
 *   `--profile <p>` flag (applyCliProfileEnv, dist/profile-BEs8qKtq.js) sets
 *   OPENCLAW_STATE_DIR to <home>/.openclaw-<p>, and a plugin sees that variable.
 */
export function resolveStateDir(
  env: Env = process.env,
  home: () => string = homedir,
  exists: (p: string) => boolean = existsSync,
): string {
  const override = env.OPENCLAW_STATE_DIR?.trim();
  if (override) return userPath(override, env, home);
  const h = homeDir(env, home);
  const next = join(h, ".openclaw");
  if (env.OPENCLAW_TEST_FAST === "1" || exists(next)) return next;
  const legacy = join(h, ".clawdbot");
  return exists(legacy) ? legacy : next;
}
