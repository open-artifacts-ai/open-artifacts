// Release guard for the red-line fake IdP (tests/redline/src/fake-idp): scans
// a BUILT release Worker bundle (the --outdir of `wrangler deploy --dry-run`,
// the same bytes check-no-test-hooks runs) for any trace of the auth-core
// shim that local fake-IdP builds alias in: its file name, its refusal
// message, its build-time define names, or a fake IdP URL on loopback. It
// also requires Google's real token and JWKS URLs (a bundle without them
// would be no proof). Prints one line; exits 0 or 1.
// Usage: node --experimental-strip-types scripts/ci/check-no-fake-idp.ts <bundle-dir>
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const NAME = "check-no-fake-idp";

/** What only the shim (or a build that baked in a fake IdP) puts in a bundle. */
export const FAKE_IDP_MARKERS: readonly [string, RegExp][] = [
  ["the shim's file name", /auth-core-shim/],
  ["the fake-idp directory", /fake-idp/],
  ["the shim's refusal message", /not a local fake-IdP build/],
  ["the shim's define names", /__OA_FAKE_IDP(_JWK)?__/],
  ["the shim's loopback origin check", /127\\\.0\\\.0\\\.1/],
  [
    "a fake IdP URL",
    /http:\/\/127\.0\.0\.1:\d+\/(o\/oauth2\/v2\/auth|token|oauth2\/v3\/certs)/,
  ],
];

/** Google's real endpoints: present in every real release bundle. */
export const GOOGLE_URLS = [
  "https://oauth2.googleapis.com/token",
  "https://www.googleapis.com/oauth2/v3/certs",
] as const;

const files = (d: string): string[] =>
  readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(d, e.name)) : [join(d, e.name)],
  );

export function checkNoFakeIdp(arg: string): [ok: boolean, msg: string] {
  const dir = resolve(arg);
  if (!existsSync(join(dir, "index.js")))
    return [false, `no bundle at ${join(dir, "index.js")}`];
  const mods = files(dir).filter((f) => /\.(m?js|map)$/.test(f));
  let all = "";
  for (const f of mods) {
    const text = readFileSync(f, "utf8");
    for (const [what, re] of FAKE_IDP_MARKERS)
      if (re.test(text)) return [false, `${relative(dir, f)} holds ${what}`];
    all += text;
  }
  for (const u of GOOGLE_URLS)
    if (!all.includes(u))
      return [false, `no ${u} in the bundle (not a release build?)`];
  return [true, `${mods.length} modules, no fake IdP; Google's URLs present`];
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const arg = process.argv[2];
  const [ok, msg] = arg
    ? checkNoFakeIdp(arg)
    : [false, "usage: check-no-fake-idp.ts <bundle-dir>"];
  console.log(`${NAME}: ${ok ? "ok" : "FAIL"}: ${msg}`);
  process.exit(ok ? 0 : 1);
}
