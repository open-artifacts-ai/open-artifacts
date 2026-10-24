import { hasDirectoryScopes } from "@oa/auth-core";
import type {
  DirectoryBinding,
  DirectoryConnectError,
  Member,
  SyncStatus,
} from "@oa/shared";
import { authConfig } from "../auth/config.js";
import { deriveKey } from "../auth/keys.js";
import { stmt } from "../db/stmt.js";
import type { Env } from "../env.js";
import { appOrigin } from "../http/errors.js";
import { logInfo, logWarn } from "../log.js";
import { audit, userActor } from "../services/audit.js";
import { afterDirectoryConnect } from "../services/directory.js";
import { directoryMode } from "../services/spaces.js";
import {
  b64urlDecode,
  b64urlEncode,
  hmacSign,
  hmacVerify,
  sha256Hex,
} from "../util/crypto.js";
import { initialBinding } from "./binding.js";
import { directoryClient } from "./client.js";
import { seal } from "./crypto.js";
import { GoogleApiError, getUser, verifiedDomains } from "./google.js";
import { K, putState, readBinding } from "./store.js";
import {
  type DirectoryClient,
  directoryTransport,
  TransportError,
} from "./transport.js";

// Directory connect (P3 T12): GET R.directoryConnect starts consent for the
// org owner; GET R.directoryCallback runs every check in order and fails
// closed. Each refusal redirects to /settings/directory?error=<code> and
// writes a directory.connect audit row (ids and enums only). Success records
// the binding and the sealed refresh token, runs the initial binding pass,
// then hands off to T13 (afterDirectoryConnect).

export const SETTINGS_DIRECTORY = "/settings/directory";
const STATE_TTL_MS = 10 * 60_000;
const COOKIE_BASE = "oa_dir";
const enc = new TextEncoder();

const hostPrefixed = (env: Env) => env.ENVIRONMENT !== "dev";
export const dirCookieName = (env: Env) =>
  hostPrefixed(env) ? `__Host-${COOKIE_BASE}` : COOKIE_BASE;
const cookieAttrs = (env: Env) =>
  hostPrefixed(env)
    ? "HttpOnly; Secure; SameSite=Lax; Path=/"
    : "HttpOnly; SameSite=Lax; Path=/api/v1/directory";
const setCookie = (env: Env, value: string, maxAge: number) =>
  `${dirCookieName(env)}=${value}; ${cookieAttrs(env)}; Max-Age=${maxAge}`;
export const clearDirCookie = (env: Env) => setCookie(env, "", 0);

/** Connect is offered only with a transport and directory sync running. */
export function connectClient(env: Env): DirectoryClient | null {
  if (directoryMode(env) !== "google") return null;
  return directoryClient(env);
}

const random = (n: number) =>
  b64urlEncode(crypto.getRandomValues(new Uint8Array(n)));
const s256 = async (v: string) =>
  b64urlEncode(
    new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(v))),
  );

/** The signed state cookie: this browser, this user, this flow. */
type DirState = { s: string; v: string; u: string; exp: number };

async function signCookie(env: Env, st: DirState): Promise<string> {
  const p = b64urlEncode(enc.encode(JSON.stringify(st)));
  return `${p}.${await hmacSign(await deriveKey(env, "oa:directory-state"), p)}`;
}

async function readCookie(env: Env, v: string): Promise<DirState | null> {
  const [p, sig, extra] = v.split(".");
  if (!p || !sig || extra !== undefined) return null;
  if (!(await hmacVerify(await deriveKey(env, "oa:directory-state"), p, sig)))
    return null;
  try {
    const raw = b64urlDecode(p);
    const st = raw
      ? (JSON.parse(new TextDecoder().decode(raw)) as DirState)
      : null;
    if (
      !st ||
      typeof st.s !== "string" ||
      typeof st.v !== "string" ||
      typeof st.u !== "string" ||
      typeof st.exp !== "number"
    )
      return null;
    return st;
  } catch {
    return null;
  }
}

/** Constant-time string equality (SHA-256 digests compared). */
async function same(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([s256(a), s256(b)]);
  let d = x.length ^ y.length;
  for (let i = 0; i < x.length; i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return d === 0;
}

/**
 * Starts consent for `user` (the route checked directory.manage): records
 * the one pending flow (single use) and returns the redirect and cookie.
 */
export async function startConnect(
  env: Env,
  client: DirectoryClient,
  user: Member,
): Promise<{ location: string; cookie: string }> {
  const state = random(32);
  const verifier = random(32);
  const exp = Date.now() + STATE_TTL_MS;
  await putState(
    env,
    K.pending,
    JSON.stringify({ h: await sha256Hex(state), u: user.id, exp }),
  ).run();
  return {
    location: client.beginConsent({
      state,
      challenge: await s256(verifier),
      hd: authConfig(env).domains[0] as string,
    }),
    cookie: setCookie(
      env,
      await signCookie(env, { s: state, v: verifier, u: user.id, exp }),
      STATE_TTL_MS / 1000,
    ),
  };
}

/** Consumes the pending flow when it is this state's and this user's, unexpired. */
const CONSUME = `delete from directory_state
  where key = ? and json_extract(value, '$.h') = ?
    and json_extract(value, '$.u') = ? and json_extract(value, '$.exp') > ?
  returning key`;

export type CallbackQuery = {
  code?: string;
  state?: string;
  error?: string;
  bstate?: string;
};

const target = (env: Env, q: Record<string, string>) =>
  `${appOrigin(env)}${SETTINGS_DIRECTORY}?${new URLSearchParams(q)}`;

class Refuse extends Error {
  constructor(
    public code: DirectoryConnectError,
    public stage: string,
  ) {
    super(stage);
  }
}

const AUDIT_TARGET = { type: "directory", id: "google" } as const;

/**
 * The callback. Every check runs in this order and any failure refuses:
 * 1. the state cookie (signature, this user, unexpired, state equal) and the
 *    single-use pending flow: `expired`;
 * 2. Google's own error (consent declined): `denied`;
 * 3. the exchange (broker: its signed state for this install and the PKCE
 *    verifier; direct: Google's token endpoint): `failed`;
 * 4. every scope granted: `scopes`;
 * 5. hd is one of this install's domains: `domain_mismatch`;
 * 6. users.get(sub) is a super admin with a customer id: `not_super_admin`;
 * 7. a reconnect keeps the bound customer: `customer_mismatch`;
 * 8. domains.list(customerId) has hd verified: `domain_mismatch`.
 * Returns the redirect location (never carries a code or token).
 */
export async function finishConnect(
  env: Env,
  client: DirectoryClient,
  user: Member,
  q: CallbackQuery,
  cookie: string | undefined,
  ctx?: Pick<ExecutionContext, "waitUntil">,
): Promise<string> {
  const actor = userActor(user.id);
  try {
    const now = Date.now();
    const st = cookie ? await readCookie(env, cookie) : null;
    if (
      !st ||
      st.exp <= now ||
      st.u !== user.id ||
      !q.state ||
      !(await same(st.s, q.state))
    )
      throw new Refuse("expired", "state");
    const consumed = await stmt(env.DB, CONSUME)
      .bind(K.pending, await sha256Hex(st.s), user.id, now)
      .first();
    if (!consumed) throw new Refuse("expired", "pending");
    if (q.error || !q.code) throw new Refuse("denied", "idp_error");

    let grant: Awaited<ReturnType<DirectoryClient["completeConsent"]>>;
    try {
      grant = await client.completeConsent({
        code: q.code,
        verifier: st.v,
        bstate: q.bstate,
      });
    } catch (e) {
      const stage = e instanceof TransportError ? e.stage : "exchange";
      throw new Refuse("failed", `transport_${stage}`);
    }
    if (!hasDirectoryScopes(grant.grantedScopes))
      throw new Refuse("scopes", "scopes");
    const domains = authConfig(env).domains;
    const hd = grant.hd?.toLowerCase() ?? "";
    if (!domains.includes(hd)) throw new Refuse("domain_mismatch", "hd");

    const google = async <T>(f: () => Promise<T>): Promise<T> => {
      try {
        return await f();
      } catch (e) {
        if (e instanceof GoogleApiError)
          throw new Refuse("failed", `google_http_${e.status}`);
        throw e;
      }
    };
    const who = await google(() => getUser(grant.accessToken, grant.sub));
    if (!who || who.id !== grant.sub) throw new Refuse("failed", "user_get");
    // Delegated admins read isAdmin false: their listings can be partial
    // and still look complete.
    if (!who.isAdmin) throw new Refuse("not_super_admin", "not_super_admin");
    if (!who.customerId) throw new Refuse("failed", "no_customer");
    const { binding: prior } = await readBinding(env);
    if (prior && prior.customerId !== who.customerId)
      throw new Refuse("customer_mismatch", "customer");
    const verified = await google(() =>
      verifiedDomains(grant.accessToken, who.customerId as string),
    );
    if (!verified.includes(hd)) throw new Refuse("domain_mismatch", "domains");

    const binding: DirectoryBinding = {
      provider: "google",
      customerId: who.customerId,
      domain: hd,
      connectedBy: user.id,
      connectedAt: new Date(now).toISOString(),
    };
    await env.DB.batch([
      putState(env, K.binding, JSON.stringify(binding)),
      putState(env, K.refresh, await seal(env, grant.refreshToken)),
      audit(env, "directory.connect", AUDIT_TARGET, actor, {
        detail: { outcome: "connected", transport: client.kind },
        when: {
          sql: `exists (select 1 from directory_state where key = ?
                  and json_extract(value, '$.customerId') = ?)`,
          args: [K.binding, who.customerId],
        },
      }),
    ]);
    logInfo("directory_connect", { outcome: "connected", kind: client.kind });
    const pass = await initialBinding(
      env,
      grant.accessToken,
      who.customerId,
      hd,
      ctx,
    );
    await afterDirectoryConnect(env, { initialDone: pass.done }).catch((e) =>
      logWarn("directory_after_connect", e),
    );
    return target(env, { connected: "1" });
  } catch (e) {
    const r = e instanceof Refuse ? e : new Refuse("failed", "internal");
    if (!(e instanceof Refuse)) logWarn("directory_connect_internal", e);
    return refuseConnect(env, user, r.code, r.stage);
  }
}

/** One refusal: the log line, the audit row (ids and enums only), the redirect. */
export async function refuseConnect(
  env: Env,
  user: Member,
  code: DirectoryConnectError,
  stage: string,
): Promise<string> {
  logInfo("directory_connect", { outcome: code, stage });
  await audit(env, "directory.connect", AUDIT_TARGET, userActor(user.id), {
    detail: { outcome: "refused", error: code, stage },
  })
    .run()
    .catch((err) => logWarn("directory_connect_audit", err));
  return target(env, { error: code });
}

/**
 * GET R.directory until T13's DirectorySync serves it. With no transport,
 * mode is "off" and, with `showProblem` (the org owner: directory.manage),
 * lastError carries the configuration problem.
 */
export async function directoryStatus(
  env: Env,
  o: { showProblem: boolean },
): Promise<SyncStatus> {
  const t = directoryTransport(env);
  const mode = t.kind === "none" ? "off" : directoryMode(env);
  const { binding } = await readBinding(env);
  return {
    mode,
    binding,
    healthy: mode === "off" ? null : false,
    state: "never",
    unhealthySince: null,
    lastSuccessAt: null,
    lastError:
      t.kind === "none" && o.showProblem
        ? { at: new Date().toISOString(), message: t.problem }
        : null,
    nextRunAt: null,
    staleAt: null,
    alertedAt: null,
    customerMismatch: null,
    held: [],
  };
}
