#!/usr/bin/env node
// One env's committed vars or rate limits from an app's wrangler.jsonc, as
// JSON on stdout, for deploy-hosted-platform.sh's read-backs ("equals
// committed"). A {{NAME_<ENV>}} placeholder in a var is replaced by the
// environment variable NAME (the value deploy-platform-worker.sh filled); an
// unset or empty one exits 1, so a read-back never compares to a placeholder.
// Usage: node scripts/ops/wrangler-env.ts <wrangler.jsonc> staging|prod vars|ratelimits|alert-pins
// alert-pins (the scheduler, design v7 4.8): exit 1 unless the env block's
// alert vars and ALERT_EMAIL's destination are this env's placeholders, so
// deploy-platform-worker.sh's fills always land.
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

/** The env block's vars, each {{NAME_<ENV>}} filled from `values[NAME]`. */
export function committedVars(
  src: string,
  env: Env,
  values: Record<string, string | undefined>,
): Record<string, string> {
  const up = env.toUpperCase();
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(block(src, env).vars ?? {})) {
    out[k] = String(v).replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, p: string) => {
      const name = p.endsWith(`_${up}`) ? p.slice(0, -up.length - 1) : null;
      const value = name ? values[name] : undefined;
      if (!value) throw new Error(`${k}: {{${p}}} has no value`);
      return value;
    });
  }
  return out;
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
  for (const k of [
    "ALERT_TO",
    "ALERT_FROM",
    "SIGNUP_DAILY_CAP",
    "SIGNUPS_ENABLED",
  ])
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
      "usage: wrangler-env.ts <wrangler.jsonc> staging|prod vars|ratelimits|alert-pins",
    );
    process.exit(2);
  }
  try {
    const src = readFileSync(file, "utf8");
    let out: unknown;
    if (what === "vars") out = committedVars(src, env, process.env);
    else if (what === "ratelimits") out = committedRateLimits(src, env);
    else if (what === "alert-pins") {
      const problems = alertPinProblems(src, env);
      if (problems.length) throw new Error(problems.join("; "));
      out = "pinned";
    } else throw new Error(`unknown section ${what}`);
    process.stdout.write(`${JSON.stringify(out)}\n`);
  } catch (e) {
    console.error(`${file}: ${(e as Error).message}`);
    process.exit(1);
  }
}
