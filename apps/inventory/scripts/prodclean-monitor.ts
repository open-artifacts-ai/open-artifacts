import { pathToFileURL } from "node:url";
import {
  InventoryHealthSchema,
  type ProdcleanReport,
} from "@oa/shared/provisioning";
import {
  type ProdCleanOpts,
  ProdDirty,
  prodClean,
  prodCleanLine,
} from "../../../tests/redline/src/prod.ts";
import {
  type ProdProbe,
  parseProd,
  prodSecretsOf,
} from "../../../tests/redline/src/targets.ts";

// The hourly prod-clean monitor (design v7 6, 5.8), run by
// .github/workflows/prodclean-monitor.yml. The repo is public: stdout is one
// line, `prod-clean: pass` or `prod-clean: fail (<code>)`, and nothing goes
// to stderr. The detail goes only to inventory's POST /prodclean, which the
// scheduler alerts and emails from.
//
// Checks: prodClean (the red-line probe) with a GitHub OIDC bearer for the
// prod inventory, the scheduler's dead-man tick, and the two red-line prod
// tokens' expiry.
//
// Env: INVENTORY_URL, INVENTORY_OIDC_AUDIENCE, REDLINE_PROD_ACCOUNT_ID,
// REDLINE_PROD_SECRETS_DIR (the 0600 REDLINE_PROD_R2_TOKEN and
// _SCRIPTS_TOKEN files) and the runner's ACTIONS_ID_TOKEN_REQUEST_URL and
// _TOKEN (id-token: write).

// TODO(contract): no @oa/shared constant for the 10 min dead-man (WorldSchema
// says "over 10 min"); the scheduler, R27 and this should share one.
export const SCHEDULER_STALE_MS = 10 * 60_000;
// TODO(contract): the design says "issue 10 days ahead" with no method; this
// reads expires_on from Cloudflare's token verify.
export const REDLINE_TOKEN_WARN_MS = 10 * 24 * 60 * 60_000;

const CF_API = "https://api.cloudflare.com/client/v4";

export interface Io {
  out: (line: string) => void;
}

export interface Deps {
  fetch: typeof fetch;
  now: () => number;
  /** The prod release public key (tests sign with their own). */
  pubkey?: string;
}

// Plain fields: node runs this file with type stripping only.
class Fail extends Error {
  readonly code: string;
  readonly installId?: string;
  constructor(code: string, detail: string, installId?: string) {
    super(detail.slice(0, 200));
    this.code = code;
    if (installId !== undefined) this.installId = installId;
  }
}

function bareOrigin(v: string | undefined): string | null {
  if (!v) return null;
  try {
    const u = new URL(v);
    if (
      u.protocol !== "https:" ||
      u.pathname !== "/" ||
      u.search ||
      u.hash ||
      u.username ||
      u.password
    )
      return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** A GitHub Actions OIDC JWT for `audience`; the request token goes in a header. */
async function mintJwt(
  env: Record<string, string | undefined>,
  audience: string,
  f: typeof fetch,
): Promise<string> {
  const base = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const token = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!base || !token)
    throw new Fail("oidc_unavailable", "no id-token request env");
  try {
    const u = new URL(base);
    u.searchParams.set("audience", audience);
    const res = await f(u, {
      redirect: "manual",
      headers: { authorization: `bearer ${token}` },
    });
    if (res.status !== 200) throw new Error(`status ${res.status}`);
    const v = ((await res.json()) as { value?: unknown }).value;
    if (typeof v !== "string" || v.split(".").length !== 3)
      throw new Error("no JWT in the response");
    return v;
  } catch (e) {
    if (e instanceof Fail) throw e;
    throw new Fail("oidc_unavailable", "id-token request failed");
  }
}

async function checkScheduler(
  url: string,
  jwt: string,
  d: Deps,
): Promise<void> {
  let tick: number | null;
  try {
    const res = await d.fetch(`${url}/health`, {
      redirect: "manual",
      headers: { authorization: `Bearer ${jwt}` },
    });
    if (res.status !== 200) throw new Error(`status ${res.status}`);
    tick = InventoryHealthSchema.parse(await res.json()).schedulerTickAt;
  } catch (e) {
    throw new Fail(
      "inventory_bad",
      `inventory /health: ${e instanceof Error ? e.message : "unreadable"}`,
    );
  }
  if (tick === null)
    throw new Fail("scheduler_absent", "the scheduler has never ticked");
  const age = d.now() - tick;
  if (age > SCHEDULER_STALE_MS)
    throw new Fail(
      "scheduler_stale",
      `scheduler tick ${Math.round(age / 1000)} s old`,
    );
}

interface TokenVerify {
  result?: { status?: unknown; expires_on?: unknown };
}

/** Cloudflare's token verify, account-scoped first (an account token), then user. */
async function verifyToken(
  token: string,
  accountId: string,
  f: typeof fetch,
): Promise<TokenVerify["result"] | null> {
  for (const path of [
    `/accounts/${accountId}/tokens/verify`,
    "/user/tokens/verify",
  ]) {
    try {
      const res = await f(`${CF_API}${path}`, {
        redirect: "manual",
        headers: { authorization: `Bearer ${token}` },
      });
      if (res.status !== 200) continue;
      const v = (await res.json()) as TokenVerify;
      if (v.result) return v.result;
    } catch {}
  }
  return null;
}

async function checkTokens(p: ProdProbe, d: Deps): Promise<void> {
  const s = prodSecretsOf(p);
  for (const [name, token] of [
    ["REDLINE_PROD_R2_TOKEN", s.r2Token],
    ["REDLINE_PROD_SCRIPTS_TOKEN", s.scriptsToken],
  ] as const) {
    const r = await verifyToken(token, p.accountId, d.fetch);
    if (!r || r.status !== "active")
      throw new Fail("redline_token_invalid", `${name} is not active`);
    if (r.expires_on === undefined || r.expires_on === null) continue;
    const exp = Date.parse(String(r.expires_on));
    if (!Number.isFinite(exp))
      throw new Fail("redline_token_invalid", `${name} expiry unreadable`);
    if (exp - d.now() < REDLINE_TOKEN_WARN_MS)
      throw new Fail(
        "redline_token_expiring",
        `${name} expires ${new Date(exp).toISOString()}`,
      );
  }
}

async function report(
  url: string,
  jwt: string,
  r: ProdcleanReport,
  f: typeof fetch,
): Promise<boolean> {
  try {
    const res = await f(`${url}/prodclean`, {
      method: "POST",
      redirect: "manual",
      headers: {
        authorization: `Bearer ${jwt}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(r),
    });
    await res.body?.cancel();
    return res.status === 204;
  } catch {
    return false;
  }
}

const asFail = (e: unknown): Fail =>
  e instanceof Fail
    ? e
    : e instanceof ProdDirty
      ? new Fail(e.code, e.message, e.installId)
      : new Fail("error", e instanceof Error ? e.name : "unknown");

/** Runs every check and reports; returns the exit code after the one line. */
export async function run(
  env: Record<string, string | undefined>,
  io: Io,
  d: Deps,
): Promise<0 | 1> {
  const url = bareOrigin(env.INVENTORY_URL);
  const audience = env.INVENTORY_OIDC_AUDIENCE;
  let p: ProdProbe | undefined;
  try {
    p = env.REDLINE_PROD_SECRETS_DIR
      ? parseProd(undefined, env.REDLINE_PROD_SECRETS_DIR, env)
      : undefined;
  } catch {
    p = undefined;
  }
  if (!url || !audience || !p) {
    // Nothing to report to: the failed run is the alert.
    io.out(prodCleanLine("not_configured"));
    return 1;
  }
  p.inventoryUrl = url;

  let jwt: string;
  try {
    jwt = await mintJwt(env, audience, d.fetch);
  } catch (e) {
    io.out(prodCleanLine(asFail(e).code));
    return 1;
  }

  // Every check runs; the first failure in this order is the one reported.
  const opts: ProdCleanOpts = {
    fetch: d.fetch,
    inventoryBearer: jwt,
    ...(d.pubkey ? { pubkey: d.pubkey } : {}),
  };
  const probe = p;
  const results = await Promise.all(
    [
      () => prodClean(probe, opts),
      () => checkScheduler(url, jwt, d),
      () => checkTokens(probe, d),
    ].map((c) =>
      c().then(
        () => null,
        (e: unknown) => asFail(e),
      ),
    ),
  );
  const fail = results.find((r) => r !== null) ?? null;
  const body: ProdcleanReport = fail
    ? {
        ok: false,
        code: fail.code,
        ...(fail.installId ? { installId: fail.installId } : {}),
        detail: fail.message,
      }
    : { ok: true, code: "pass" };
  const sent = await report(url, jwt, body, d.fetch);
  const code = fail ? fail.code : sent ? undefined : "report_failed";
  io.out(prodCleanLine(code));
  return code === undefined ? 0 : 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const io: Io = { out: (l) => process.stdout.write(`${l}\n`) };
  try {
    process.exitCode = await run(process.env, io, {
      fetch: globalThis.fetch,
      now: Date.now,
    });
  } catch {
    io.out(prodCleanLine("error"));
    process.exitCode = 1;
  }
}
