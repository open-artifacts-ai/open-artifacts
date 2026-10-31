#!/usr/bin/env node
// One env's committed vars or rate limits from an app's wrangler.jsonc, as
// JSON on stdout, for deploy-hosted-platform.sh's read-backs ("equals
// committed"). A {{NAME_<ENV>}} placeholder in a var is replaced by the
// environment variable NAME (the value deploy-platform-worker.sh filled); an
// unset or empty one exits 1, so a read-back never compares to a placeholder.
// Usage: node scripts/ops/wrangler-env.ts <wrangler.jsonc> staging|prod vars|ratelimits|alert-pins|signups
// signups: the env block's SIGNUPS_ENABLED as deployed (null when it has none).
// alert-pins (the scheduler, design v7 4.8): "pinned" when the env block's
// alert vars and ALERT_EMAIL's destination are all this env's placeholders,
// "absent" when it holds none of them (before #915), else exit 1, so
// deploy-platform-worker.sh's fills land on all of them or none.
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** JSONC to JSON: comments outside strings, then trailing commas. */
export function stripJsonc(src: string): string {
  let out = "";
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') j += src[j] === "\\" ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j;
    } else if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && src[i + 1] === "*") {
      i = src.indexOf("*/", i + 2);
      if (i < 0) break;
      i++;
    } else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

export type Env = "staging" | "prod";
export interface RateLimit {
  name: string;
  namespace_id: string;
  limit: number | undefined;
  period: number | undefined;
}
interface Block {
  vars?: Record<string, unknown>;
  send_email?: { name?: string; destination_address?: string }[];
  ratelimits?: {
    name: string;
    namespace_id: string | number;
    simple?: { limit?: number; period?: number };
  }[];
}

function block(src: string, env: Env): Block {
  const b = JSON.parse(stripJsonc(src)).env?.[env] as Block | undefined;
  if (!b) throw new Error(`no env.${env} block`);
  return b;
}

/** One var's committed value, each {{NAME_<ENV>}} filled from `values[NAME]`. */
function fillVar(
  k: string,
  v: unknown,
  env: Env,
  values: Record<string, string | undefined>,
): string {
  const up = env.toUpperCase();
  return String(v).replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, p: string) => {
    const name = p.endsWith(`_${up}`) ? p.slice(0, -up.length - 1) : null;
    const value = name ? values[name] : undefined;
    if (!value) throw new Error(`${k}: {{${p}}} has no value`);
    return value;
  });
}

/** The env block's vars, each {{NAME_<ENV>}} filled from `values[NAME]`. */
export function committedVars(
  src: string,
  env: Env,
  values: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(block(src, env).vars ?? {}))
    out[k] = fillVar(k, v, env, values);
  return out;
}

/**
 * The env block's SIGNUPS_ENABLED as the deploy would fill it (a literal, or
 * {{SIGNUPS_ENABLED_<ENV>}} from `values`); null when the block has none.
 */
export function committedSignups(
  src: string,
  env: Env,
  values: Record<string, string | undefined>,
): string | null {
  const v = block(src, env).vars?.SIGNUPS_ENABLED;
  return v === undefined ? null : fillVar("SIGNUPS_ENABLED", v, env, values);
}

/** The env block's rate limits, sorted by name, ids as strings. */
export function committedRateLimits(src: string, env: Env): RateLimit[] {
  return (block(src, env).ratelimits ?? [])
    .map((r) => ({
      name: r.name,
      namespace_id: String(r.namespace_id),
      limit: r.simple?.limit,
      period: r.simple?.period,
    }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

export const ALERT_VARS = [
  "ALERT_TO",
  "ALERT_FROM",
  "SIGNUP_DAILY_CAP",
  "SIGNUPS_ENABLED",
] as const;

/**
 * Whether the env block wires the scheduler's alerts at all: true when any
 * alert var or ALERT_EMAIL's destination_address is present.
 */
export function alertWired(src: string, env: Env): boolean {
  const b = block(src, env);
  return (
    ALERT_VARS.some((k) => b.vars?.[k] !== undefined) ||
    (b.send_email ?? []).some(
      (m) => m.name === "ALERT_EMAIL" && m.destination_address !== undefined,
    )
  );
}

/**
 * What keeps the scheduler's alert wiring from being this env's placeholders:
 * the ALERT_TO, ALERT_FROM, SIGNUP_DAILY_CAP and SIGNUPS_ENABLED vars, and one
 * ALERT_EMAIL send_email binding whose destination_address is {{ALERT_TO_<ENV>}}.
 * Empty when pinned.
 */
export function alertPinProblems(src: string, env: Env): string[] {
  const up = env.toUpperCase();
  const b = block(src, env);
  const out: string[] = [];
  for (const k of ALERT_VARS)
    if (b.vars?.[k] !== `{{${k}_${up}}}`)
      out.push(`vars.${k} is not {{${k}_${up}}}`);
  const mail = (b.send_email ?? []).filter((m) => m.name === "ALERT_EMAIL");
  if (
    mail.length !== 1 ||
    mail[0]?.destination_address !== `{{ALERT_TO_${up}}}`
  )
    out.push(
      `send_email ALERT_EMAIL needs destination_address {{ALERT_TO_${up}}}`,
    );
  return out;
}

// Run as a script (paths compared after symlinks, as macOS's /var is one).
if (
  process.argv[1] &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
) {
  const [file, env, what] = process.argv.slice(2);
  if (!file || (env !== "staging" && env !== "prod") || !what) {
    console.error(
      "usage: wrangler-env.ts <wrangler.jsonc> staging|prod vars|ratelimits|alert-pins|signups",
    );
    process.exit(2);
  }
  try {
    const src = readFileSync(file, "utf8");
    let out: unknown;
    if (what === "vars") out = committedVars(src, env, process.env);
    else if (what === "ratelimits") out = committedRateLimits(src, env);
    else if (what === "signups")
      out = committedSignups(src, env, process.env);
    else if (what === "alert-pins") {
      if (!alertWired(src, env)) out = "absent";
      else {
        const problems = alertPinProblems(src, env);
        if (problems.length) throw new Error(problems.join("; "));
        out = "pinned";
      }
    } else throw new Error(`unknown section ${what}`);
    process.stdout.write(`${JSON.stringify(out)}\n`);
  } catch (e) {
    console.error(`${file}: ${(e as Error).message}`);
    process.exit(1);
  }
}
