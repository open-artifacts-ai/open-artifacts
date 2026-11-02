// Deploy preflight: fail if a Worker secret the code requires is not set.
// Required = non-optional `string` fields of `Env` (apps/server/src/env.ts)
// that are not vars in wrangler.staging.jsonc nor DEPLOY_VARS. Reads the JSON from
// `wrangler secret list --format json` on stdin; prints names only.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

/** Remove // and block comments outside string literals. */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? src.length : end + 2;
      out += " ";
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

export const stripJsonc = (src: string) =>
  stripComments(src).replace(/,(\s*[}\]])/g, "$1");

const BINDING =
  /^(D1Database|R2Bucket|KVNamespace|Fetcher|RateLimit|DurableObjectNamespace|SendEmail)(<[^;{}]*>)?$/;
const LITERAL_UNION = /^\|?\s*("[^"]*"|'[^']*')(\s*\|\s*("[^"]*"|'[^']*'))*$/;

function interfaceBody(src: string): string {
  const m = /\binterface\s+Env\s*{/.exec(src);
  if (!m) throw new Error("interface Env not found");
  let depth = 1;
  for (let i = m.index + m[0].length; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0)
      return src.slice(m.index + m[0].length, i);
  }
  throw new Error("interface Env is not closed");
}

/** Split into members at depth-0 `;`/`,`, or at a newline when the member is complete. */
function members(body: string): string[] {
  const out: string[] = [];
  let cur = "";
  let depth = 0;
  const flush = () => {
    if (cur.trim()) out.push(cur.trim());
    cur = "";
  };
  const lines = body.split("\n");
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li] as string;
    for (const ch of line) {
      if ("{[(<".includes(ch)) depth++;
      else if ("}])>".includes(ch)) depth--;
      if (depth === 0 && (ch === ";" || ch === ",")) flush();
      else cur += ch;
    }
    const t = cur.trim();
    const next = (lines[li + 1] ?? "").trim();
    const open = t.endsWith("|") || t.endsWith(":") || next.startsWith("|");
    if (depth === 0 && !open) flush();
    else cur += "\n";
  }
  flush();
  return out;
}

/**
 * Vars deploy-staging.yml passes with `wrangler deploy --var` instead of
 * committing them: OWNER_EMAIL is the owner's address, from the
 * OA_OWNER_EMAIL secret (#1084).
 */
export const DEPLOY_VARS: readonly string[] = ["OWNER_EMAIL"];

export function requiredSecrets(
  envTs: string,
  wranglerJsonc: string,
): string[] {
  const cfg = JSON.parse(stripJsonc(wranglerJsonc));
  const vars = new Set([
    ...Object.keys(cfg.env?.staging?.vars ?? {}),
    ...DEPLOY_VARS,
  ]);
  const names: string[] = [];
  for (const member of members(
    stripComments(interfaceBody(stripComments(envTs))),
  )) {
    const m =
      /^(?:readonly\s+)?([A-Za-z_][A-Za-z0-9_]*)(\?)?\s*:\s*([\s\S]+)$/.exec(
        member,
      );
    if (!m) throw new Error(`cannot parse Env member: ${member}`);
    const name = m[1] as string;
    const type = (m[3] as string).replace(/\s+/g, " ").trim();
    if (type === "string") {
      if (!m[2] && !vars.has(name)) names.push(name);
    } else if (type === "string | undefined" || type === "undefined | string") {
      // optional
    } else if (LITERAL_UNION.test(type) || BINDING.test(type)) {
      // var literal or binding
    } else {
      throw new Error(`unrecognized type for Env.${name}: ${type}`);
    }
  }
  return names;
}

export function missingSecrets(
  envTs: string,
  wranglerJsonc: string,
  listed: { name: string }[],
): string[] {
  const have = new Set(listed.map((s) => s.name));
  return requiredSecrets(envTs, wranglerJsonc).filter((n) => !have.has(n));
}

function main(): number {
  const envTs = readFileSync(join(root, "apps/server/src/env.ts"), "utf8");
  const wrangler = readFileSync(
    join(root, "apps/server/wrangler.staging.jsonc"),
    "utf8",
  );
  let listed: { name: string }[];
  try {
    const raw = readFileSync(0, "utf8");
    const start = raw.indexOf("[");
    if (start < 0) throw new Error("no JSON array in input");
    listed = JSON.parse(raw.slice(start));
    if (!Array.isArray(listed)) throw new Error("not an array");
  } catch (e) {
    console.error(
      `::error::cannot parse wrangler secret list output: ${(e as Error).message}`,
    );
    return 2;
  }
  const missing = missingSecrets(envTs, wrangler, listed);
  if (missing.length > 0) {
    console.error(`::error::missing Worker secrets: ${missing.join(", ")}`);
    return 1;
  }
  console.log(
    `ok: all ${requiredSecrets(envTs, wrangler).length} required Worker secrets are set`,
  );
  return 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exit(main());
}
