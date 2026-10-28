import { beforeAll, describe, it } from "vitest";
import { liveFetch } from "./live-fetch.js";
import { checkHealth, stagingOrigin } from "./live-guard.js";
import { readSecretFile } from "./secret-file.js";
import { type Install, SIGNIN_NEGATIVE_CASES } from "./signin-negative.js";

// pnpm xt:live (sets XT_LIVE=1): the catalog against two live staging
// installs. Origins from env (XT_A, XT_B and their content hosts XT_A_CONTENT,
// XT_B_CONTENT); credentials ONLY from 0600 files (XT_A_KEY_FILE,
// XT_B_KEY_FILE, XT_TURNSTILE_FILE), each read once, after the guards pass:
// staging-allowlisted https origins, /healthz testHooks:true on both, and
// distinct installIds. Both installs must run with TEST_DOMAIN=xt-guest.example
// (XT_DOMAIN, #393): the session hook only serves addresses under it.
const need = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is required for xt:live`);
  return v;
};

function live(origin: string, contentOrigin: string): Install {
  return {
    origin,
    contentOrigin,
    hookKey: "",
    sessionCookie: "__Host-oa_session",
    codeCookie: "__Host-oa_code",
    // fetch never sends a caller's Host header: the URL picks the install.
    fetch: (req) => {
      const h = new Headers(req.headers);
      h.delete("host");
      return liveFetch(new Request(req, { headers: h }));
    },
  };
}

const live_ = process.env.XT_LIVE === "1";
let A: Install;
let B: Install;

describe.runIf(live_)("sign-in negative catalog (live)", () => {
  beforeAll(async () => {
    A = live(stagingOrigin(need("XT_A")), stagingOrigin(need("XT_A_CONTENT")));
    B = live(stagingOrigin(need("XT_B")), stagingOrigin(need("XT_B_CONTENT")));
    const text = async (o: string) => {
      const r = await liveFetch(
        new Request(`${o}/healthz`, { redirect: "manual" }),
      );
      if (r.status !== 200)
        throw new Error(`${new URL(o).host} /healthz: ${r.status}`);
      return r.text();
    };
    checkHealth(await text(A.origin), await text(B.origin));
    A.hookKey = readSecretFile(need("XT_A_KEY_FILE"));
    B.hookKey = readSecretFile(need("XT_B_KEY_FILE"));
    const turnstile = process.env.XT_TURNSTILE_FILE
      ? readSecretFile(process.env.XT_TURNSTILE_FILE)
      : undefined;
    A.turnstileToken = turnstile;
    B.turnstileToken = turnstile;
  });

  for (const c of SIGNIN_NEGATIVE_CASES) it(c.name, () => c.run(A, B));
  for (const c of SIGNIN_NEGATIVE_CASES)
    it(`${c.name} (B to A)`, () => c.run(B, A));
});
