// Release gate: fail if the built landing site still contains TODO fallbacks
// or unrendered {{ placeholders }}, or if a page doesn't declare UTF-8 first
// in <head> (the hero's glyphs turn to mojibake otherwise), or if the home
// page's "Get started free" buttons are missing or do not go to the hosted
// sign-up URL. Usage: node check-landing-dist.ts [distDir] [--probe-signup]
// --probe-signup (release only) also requests the sign-up URL found in the
// built home page (not the env), follows redirects, and fails unless the final
// answer is 2xx, so a release cannot ship dead sign-up buttons.
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
const SIGNUP_LABEL = "Get started free";
const NO_SIGNUP =
  'Get started free link without a sign-up URL (set HOSTED_SIGNUP_URL for the landing build; its href is "#pricing" or missing)';
const NO_BUTTONS =
  'no "Get started free" link on the home page (the sign-up buttons are gone)';
const LOGIN_LABEL = "Log in";
const NO_LOGIN_URL =
  "Log in link that does not point at the sign-up URL (it must be the same HOSTED_SIGNUP_URL as the Get started free buttons)";
const NO_LOGIN =
  'no "Log in" link in the home page header (it goes to the sign-up URL)';
const CHARSET = /<head[^>]*>\s*<meta charset="utf-8"\s*\/?>/i;
const MAX_LINES = 20;

function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile()) yield p;
  }
}

/** Links whose visible text is `label`, even with inner tags. */
function linksLabelled(body: string, label: string) {
  const out: { index: number; href: string | undefined }[] = [];
  for (const m of body.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)) {
    const text = (m[2] ?? "")
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (text !== label) continue;
    out.push({
      index: m.index ?? 0,
      href: /\bhref="([^"]*)"/.exec(m[1] ?? "")?.[1]?.trim(),
    });
  }
  return out;
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
    // the pricing table. The home page must have them at all.
    if (extname(file).toLowerCase() === ".html") {
      const links = linksLabelled(body, SIGNUP_LABEL);
      const lineOf = (index: number) => body.slice(0, index).split("\n").length;
      const dead = (href: string | undefined) =>
        !href || href === "#pricing" || href === "#";
      for (const l of links)
        if (dead(l.href))
          hits.push({ file, line: lineOf(l.index), token: NO_SIGNUP });
      if (file === join(dist, "index.html")) {
        if (links.length === 0) hits.push({ file, line: 1, token: NO_BUTTONS });
        // The header's "Log in" goes to the same sign-up URL, and is there
        // whenever the buttons have one.
        const logins = linksLabelled(body, LOGIN_LABEL);
        const url = links.find((l) => !dead(l.href))?.href;
        for (const l of logins)
          if (dead(l.href) || (url && l.href !== url))
            hits.push({ file, line: lineOf(l.index), token: NO_LOGIN_URL });
        if (url && logins.length === 0)
          hits.push({ file, line: 1, token: NO_LOGIN });
      }
    }
  }
  return hits;
}

/** The sign-up URL the built home page links to (first live Get started free). */
export function signupUrlInDist(dist: string): string | undefined {
  const file = join(dist, "index.html");
  if (!existsSync(file)) return undefined;
  return linksLabelled(readFileSync(file, "utf8"), SIGNUP_LABEL).find(
    (l) => l.href && l.href !== "#pricing" && l.href !== "#",
  )?.href;
}

/**
 * Release mode: the sign-up URL must end on a 2xx after redirects.
 * Returns an error message, or null when it is fine. `fetchFn` is injectable.
 */
export async function probeSignup(
  url: string | undefined,
  fetchFn: typeof fetch = fetch,
): Promise<string | null> {
  const u = url?.trim();
  if (!u)
    return "no sign-up URL was found in the built home page, so there is nothing to probe";
  try {
    // Follow redirects: what counts is where a visitor ends up, and that
    // final page must answer 2xx.
    const res = await fetchFn(u, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status >= 200 && res.status < 300) return null;
    return `the sign-up URL ${u} ends on a ${res.status}; sign-up buttons would be dead links`;
  } catch (e) {
    return `the sign-up URL ${u} could not be reached (${e instanceof Error ? e.message : String(e)})`;
  }
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const probe = args.includes("--probe-signup");
  const dist = resolve(
    args.find((a) => !a.startsWith("--")) ?? join(root, "apps/landing/dist"),
  );
  if (!existsSync(dist) || !statSync(dist).isDirectory()) {
    console.error(`::error::landing dist not found: ${dist}`);
    return 2;
  }
  const hits = scan(dist);
  // The URL probed is the one the built page actually links to, not the env.
  const probeError = probe ? await probeSignup(signupUrlInDist(dist)) : null;
  if (hits.length === 0 && !probeError) {
    console.log("ok: landing dist clean");
    return 0;
  }
  for (const h of hits.slice(0, MAX_LINES))
    console.log(
      `::error file=${h.file}::landing not release-ready: found "${h.token}" in ${h.file}:${h.line}`,
    );
  if (hits.length > MAX_LINES)
    console.log(`... and ${hits.length - MAX_LINES} more`);
  if (probeError)
    console.log(`::error::landing not release-ready: ${probeError}`);
  const files = new Set(hits.map((h) => h.file)).size;
  console.log(
    `::error::Landing deploy skipped: ${hits.length} ${TOKENS.join(" / ")} / missing charset / sign-up link hit(s) in ${files} file(s)${probeError ? " and a sign-up URL that does not answer" : ""}. The release is already created; fix the landing, then re-run this workflow via workflow_dispatch with the tag.`,
  );
  return 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exit(await main());
}
