#!/usr/bin/env node
// One env's committed vars or rate limits from an app's wrangler.jsonc, as
// JSON on stdout, for deploy-hosted-platform.sh's read-backs ("equals
// committed"). A {{NAME_<ENV>}} placeholder in a var is replaced by the
// environment variable NAME (the value deploy-platform-worker.sh filled); an
// unset or empty one exits 1, so a read-back never compares to a placeholder.
// Usage: node scripts/ops/wrangler-env.mjs <wrangler.jsonc> staging|prod vars|ratelimits
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** JSONC to JSON: comments outside strings, then trailing commas. */
export function stripJsonc(src) {
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

/** The env block's vars (placeholders filled from `values`) or rate limits. */
export function envSection(src, env, what, values) {
  const block = JSON.parse(stripJsonc(src)).env?.[env];
  if (!block) throw new Error(`no env.${env} block`);
  if (what === "ratelimits")
    return (block.ratelimits ?? [])
      .map((r) => ({
        name: r.name,
        namespace_id: String(r.namespace_id),
        limit: r.simple?.limit,
        period: r.simple?.period,
      }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
  if (what !== "vars") throw new Error(`unknown section ${what}`);
  const up = env.toUpperCase();
  const out = {};
  for (const [k, v] of Object.entries(block.vars ?? {})) {
    out[k] = String(v).replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, p) => {
      const name = p.endsWith(`_${up}`) ? p.slice(0, -up.length - 1) : null;
      const value = name ? values[name] : undefined;
      if (!value) throw new Error(`${k}: {{${p}}} has no value`);
      return value;
    });
  }
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
      "usage: wrangler-env.mjs <wrangler.jsonc> staging|prod vars|ratelimits",
    );
    process.exit(2);
  }
  try {
    const out = envSection(readFileSync(file, "utf8"), env, what, process.env);
    process.stdout.write(`${JSON.stringify(out)}\n`);
  } catch (e) {
    console.error(`${file}: ${e.message}`);
    process.exit(1);
  }
}
