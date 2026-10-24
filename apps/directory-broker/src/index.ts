// Hosted directory broker (P3 T12): Google directory-sync consent for every
// hosted install through ONE Directory client, on its own host
// (directory.<app domain>), separate from the sign-in broker so that a
// compromise of either never yields both Google client secrets. Stateless.
// It holds the Directory client secret and nothing that can sign for an
// install; its registry (DIRECTORY_REGISTRY, written by Platform) is read
// only: `get`, never `put` or `delete`.
// - GET  /google/directory/start     install → Google (read-only Admin SDK
//   scopes, offline, consent, hd), with a signed directory state naming the
//   install and binding its PKCE challenge.
// - GET  /google/directory/callback  Google → the install's registered origin
//   only (/api/v1/directory/callback?code&state&bstate).
// - POST /google/directory/token     the install (Ed25519-signed install
//   assertion over a path-bound transcript, within 60 s) trades the code
//   (proving the PKCE verifier against the state) or refreshes. Every token
//   comes back sealed to the X25519 key the install put in that signed
//   request (auth-core box.ts), never raw. The install re-seals the refresh
//   token at rest with its DIRECTORY_TOKEN_KEY.
import {
  GOOGLE_AUTHORIZE_URL,
  GOOGLE_DIRECTORY_SCOPES,
  GOOGLE_TOKEN_URL,
  sealToInstall,
} from "@oa/auth-core";
import {
  ASSERTION_SKEW_MS,
  fixedOrigin,
  installLimited,
  ipLimited,
  json,
  logger,
  lookupInstall,
  MAX_BODY,
  notFound,
  readState,
  refused,
  s256,
  same,
  signState,
  verifyAssertion,
} from "@oa/broker-core";

export interface Env {
  /** Install registry (Platform writes it; read only here). Never BROKER_REGISTRY. */
  DIRECTORY_REGISTRY: KVNamespace;
  GOOGLE_DIRECTORY_CLIENT_ID: string;
  GOOGLE_DIRECTORY_CLIENT_SECRET: string;
  /**
   * The fixed public origin (https://directory.<app domain>). redirect_uri is
   * always built from it, never from the request Host.
   */
  DIRECTORY_ORIGIN: string;
  /** HMAC key for the directory state (32+ chars). */
  DIRECTORY_STATE_KEY: string;
  /** Per-IP and per-install rate limits; unbound means fail closed (503). */
  RL_DIRECTORY_IP?: RateLimit;
  RL_DIRECTORY_INSTALL?: RateLimit;
}

const STATE_TTL_MS = 10 * 60_000;
/** MACed in front of every directory state (broker-core signState domain). */
const STATE_DOMAIN = "oa-dir-v1";
export const START_PATH = "/google/directory/start";
export const CALLBACK_PATH = "/google/directory/callback";
export const TOKEN_PATH = "/google/directory/token";
/** Where the user goes back to on the install (R.directoryCallback). */
const INSTALL_CALLBACK = "/api/v1/directory/callback";
/** S256 of 32 bytes, base64url: exactly what the installs generate. */
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
/** A raw X25519 public key, base64url. */
const EPK_RE = /^[A-Za-z0-9_-]{43}$/;
const enc = new TextEncoder();
const log = logger("directory_broker");

const limits = (env: Env) => ({
  ip: env.RL_DIRECTORY_IP,
  install: env.RL_DIRECTORY_INSTALL,
});
const callbackUrl = (origin: string) => `${origin}${CALLBACK_PATH}`;

/** The client, or null when either half is unset (every route 404s). */
function client(env: Env): { id: string; secret: string } | null {
  const id = env.GOOGLE_DIRECTORY_CLIENT_ID?.trim();
  const secret = env.GOOGLE_DIRECTORY_CLIENT_SECRET;
  return id && !id.startsWith("{{") && secret ? { id, secret } : null;
}

async function start(req: Request, env: Env, now: number): Promise<Response> {
  const q = new URL(req.url).searchParams;
  const install = q.get("install") ?? "";
  const state = q.get("state") ?? "";
  const challenge = q.get("code_challenge") ?? "";
  if (!state || state.length > 512 || !CHALLENGE_RE.test(challenge))
    return notFound();
  const c = client(env);
  if (!c) return log("start", "unconfigured"), notFound();
  const origin = fixedOrigin(env.DIRECTORY_ORIGIN);
  if (!origin)
    return log("start", "misconfigured"), json({ error: "server_error" }, 500);
  const limited = await ipLimited(limits(env), req, log);
  if (limited) return limited;
  const entry = await lookupInstall(env.DIRECTORY_REGISTRY, install, now);
  if (!entry) return log("start", "unknown_install"), notFound();
  const busy = await installLimited(limits(env), install, log);
  if (busy) return busy;
  const u = new URL(GOOGLE_AUTHORIZE_URL);
  u.search = new URLSearchParams({
    client_id: c.id,
    redirect_uri: callbackUrl(origin),
    response_type: "code",
    scope: GOOGLE_DIRECTORY_SCOPES.join(" "),
    access_type: "offline",
    // A refresh token on every consent, and the scopes shown every time.
    prompt: "consent",
    include_granted_scopes: "false",
    // h is the PKCE challenge: only the holder of its verifier can trade the
    // code at the token route.
    state: await signState(
      env.DIRECTORY_STATE_KEY,
      { i: install, s: state, h: challenge, exp: now + STATE_TTL_MS },
      STATE_DOMAIN,
    ),
    code_challenge: challenge,
    code_challenge_method: "S256",
    ...(entry.domains?.[0] ? { hd: entry.domains[0] } : {}),
  }).toString();
  log("start", "ok");
  return Response.redirect(u.toString(), 302);
}

async function callback(
  req: Request,
  env: Env,
  now: number,
): Promise<Response> {
  const q = new URL(req.url).searchParams;
  const raw = q.get("state") ?? "";
  const st = await readState(env.DIRECTORY_STATE_KEY, raw, now, STATE_DOMAIN);
  if (!st) return log("callback", "bad_state"), notFound();
  const entry = await lookupInstall(env.DIRECTORY_REGISTRY, st.i, now);
  if (!entry) return log("callback", "unknown_install"), notFound();
  // Only the registry decides where the user goes next.
  const to = new URL(INSTALL_CALLBACK, entry.origin);
  const code = q.get("code");
  const error = q.get("error");
  if (code) to.searchParams.set("code", code);
  else
    to.searchParams.set(
      "error",
      error && /^[a-z_]{1,64}$/.test(error) ? error : "access_denied",
    );
  to.searchParams.set("state", st.s);
  to.searchParams.set("bstate", raw);
  log("callback", code ? "ok" : "idp_error");
  return new Response(null, {
    status: 302,
    headers: {
      location: to.toString(),
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

type TokenBody =
  | {
      install: string;
      ts: number;
      epk: string;
      grant: "code";
      code: string;
      verifier: string;
      bstate: string;
    }
  | {
      install: string;
      ts: number;
      epk: string;
      grant: "refresh";
      refresh_token: string;
    };

function parse(text: string): TokenBody | null {
  let b: Record<string, unknown>;
  try {
    b = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (
    !b ||
    typeof b.install !== "string" ||
    typeof b.ts !== "number" ||
    typeof b.epk !== "string" ||
    !EPK_RE.test(b.epk)
  )
    return null;
  if (
    b.grant === "code" &&
    typeof b.code === "string" &&
    typeof b.verifier === "string" &&
    typeof b.bstate === "string"
  )
    return b as TokenBody;
  if (b.grant === "refresh" && typeof b.refresh_token === "string")
    return b as TokenBody;
  return null;
}

/**
 * The token exchange for one authenticated install. Code grant:
 * `{ box, scope }`, the box holding Google's refresh_token, access_token and
 * id_token (the install checks scopes, hd, super admin and customer itself).
 * Refresh grant: `{ box }` holding access_token and expires_in. Google's
 * invalid_grant comes back as 400 invalid_grant (the install marks its sync
 * auth_failed).
 */
async function token(req: Request, env: Env, now: number): Promise<Response> {
  const kid = req.headers.get("x-oa-kid") ?? "";
  const sig = req.headers.get("x-oa-sig") ?? "";
  const text = await req.text();
  if (text.length > MAX_BODY) return refused();
  const body = parse(text);
  if (!body) return refused();
  const c = client(env);
  if (!c) return log("token", "unconfigured"), notFound();
  const origin = fixedOrigin(env.DIRECTORY_ORIGIN);
  if (!origin)
    return log("token", "misconfigured"), json({ error: "server_error" }, 500);
  const limited = await ipLimited(limits(env), req, log);
  if (limited) return limited;
  const entry = await lookupInstall(env.DIRECTORY_REGISTRY, body.install, now);
  if (!entry) return log("token", "unknown_install"), refused();
  // Path-bound: a sign-in redeem signature never verifies here.
  if (!(await verifyAssertion(entry, TOKEN_PATH, kid, text, sig)))
    return log("token", "bad_signature"), refused();
  if (Math.abs(now - body.ts) > ASSERTION_SKEW_MS)
    return log("token", "stale"), refused();
  const busy = await installLimited(limits(env), body.install, log);
  if (busy) return busy;

  let form: Record<string, string>;
  if (body.grant === "code") {
    // This install's own directory state, unexpired, whose challenge is the
    // S256 of the verifier presented (constant time).
    const st = await readState(
      env.DIRECTORY_STATE_KEY,
      body.bstate,
      now,
      STATE_DOMAIN,
    );
    if (
      !st ||
      st.i !== body.install ||
      !same(enc.encode(st.h), enc.encode(await s256(body.verifier)))
    )
      return log("token", "bad_flow"), refused();
    form = {
      grant_type: "authorization_code",
      code: body.code,
      redirect_uri: callbackUrl(origin),
      code_verifier: body.verifier,
    };
  } else
    form = { grant_type: "refresh_token", refresh_token: body.refresh_token };

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams({
      ...form,
      client_id: c.id,
      client_secret: c.secret,
    }),
    redirect: "manual",
  }).catch(() => null);
  const out = (await res?.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!res?.ok) {
    if (out?.error === "invalid_grant")
      return (
        log("token", "invalid_grant"), json({ error: "invalid_grant" }, 400)
      );
    return (
      log("token", "exchange_failed"), json({ error: "exchange_failed" }, 400)
    );
  }
  if (typeof out?.access_token !== "string")
    return (
      log("token", "no_access_token"), json({ error: "exchange_failed" }, 400)
    );
  const sealed = (payload: Record<string, unknown>) =>
    sealToInstall(body.epk, body.install, kid, JSON.stringify(payload));
  if (body.grant === "refresh") {
    log("token", "refresh_ok");
    return json({
      box: await sealed({
        access_token: out.access_token,
        expires_in: typeof out.expires_in === "number" ? out.expires_in : 3600,
      }),
    });
  }
  if (
    typeof out.refresh_token !== "string" ||
    typeof out.id_token !== "string" ||
    typeof out.scope !== "string"
  )
    return (
      log("token", "incomplete_grant"), json({ error: "exchange_failed" }, 400)
    );
  log("token", "code_ok");
  return json({
    scope: out.scope,
    box: await sealed({
      refresh_token: out.refresh_token,
      access_token: out.access_token,
      id_token: out.id_token,
    }),
  });
}

export default {
  async fetch(req, env): Promise<Response> {
    const { pathname } = new URL(req.url);
    const now = Date.now();
    if (req.method === "GET" && pathname === START_PATH)
      return start(req, env, now);
    if (req.method === "GET" && pathname === CALLBACK_PATH)
      return callback(req, env, now);
    if (req.method === "POST" && pathname === TOKEN_PATH)
      return token(req, env, now);
    return notFound();
  },
} satisfies ExportedHandler<Env>;
