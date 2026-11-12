// Release gate: fail if the built landing site still contains TODO fallbacks
// or unrendered {{ placeholders }}, or if a page doesn't declare UTF-8 first
// in <head> (the hero's glyphs turn to mojibake otherwise). Usage: node check-landing-dist.ts [distDir]
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const TEXT_EXT = new Set([
  ".html",
  ".txt",
  ".md",
  ".json",
  ".xml",
  ".js",
  ".mjs",
  ".css",
]);
const TOKENS = ["TODO", "{{", "OA-UNRELEASED"];
const NO_SIGNUP =
  'Get started free link without a sign-up URL (set HOSTED_SIGNUP_URL for the landing build; its href is "#pricing" or missing)';
const CHARSET = /<head[^>]*>\s*<meta charset="utf-8"\s*\/?>/i;
const MAX_LINES = 20;

function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile()) yield p;
  }
}

export function scan(
  dist: string,
): { file: string; line: number; token: string }[] {
  const hits: { file: string; line: number; token: string }[] = [];
  for (const file of walk(dist)) {
    if (!TEXT_EXT.has(extname(file).toLowerCase())) continue;
    const buf = readFileSync(file);
    if (buf.includes(0)) continue; // binary
    const body = buf.toString("utf8");
    if (extname(file).toLowerCase() === ".html" && !CHARSET.test(body))
      hits.push({ file, line: 1, token: "missing charset" });
    body.split("\n").forEach((text, i) => {
      for (const token of TOKENS)
        if (text.includes(token)) hits.push({ file, line: i + 1, token });
    });
    // Every "Get started free" button must go to the hosted sign-up URL, which
    // the build gets from HOSTED_SIGNUP_URL. Without it the link falls back to
    // the pricing table.
    if (extname(file).toLowerCase() === ".html")
      for (const m of body.matchAll(
        /<a\b([^>]*)>\s*Get started free\s*<\/a>/g,
      )) {
        const href = /\bhref="([^"]*)"/.exec(m[1] ?? "")?.[1]?.trim();
        if (!href || href === "#pricing" || href === "#")
          hits.push({
            file,
            line: body.slice(0, m.index).split("\n").length,
            token: NO_SIGNUP,
          });
      }
  }
  return hits;
}

function main(): number {
  const dist = resolve(process.argv[2] ?? join(root, "apps/landing/dist"));
  if (!existsSync(dist) || !statSync(dist).isDirectory()) {
    console.error(`::error::landing dist not found: ${dist}`);
    return 2;
  }
  const hits = scan(dist);
  if (hits.length === 0) {
    console.log("ok: landing dist clean");
    return 0;
  }
  for (const h of hits.slice(0, MAX_LINES))
    console.log(
      `::error file=${h.file}::landing not release-ready: found "${h.token}" in ${h.file}:${h.line}`,
    );
  if (hits.length > MAX_LINES)
    console.log(`... and ${hits.length - MAX_LINES} more`);
  const files = new Set(hits.map((h) => h.file)).size;
  console.log(
    `::error::Landing deploy skipped: ${hits.length} ${TOKENS.join(" / ")} / missing charset / sign-up link hit(s) in ${files} file(s). The release is already created; fix the landing, then re-run this workflow via workflow_dispatch with the tag.`,
  );
  return 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exit(main());
}
