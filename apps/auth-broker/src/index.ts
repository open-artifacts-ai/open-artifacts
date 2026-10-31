// Hosted auth broker (P2 T11): Sign in with Google for every hosted install
// through ONE multi-tenant Google client. Stateless. It holds the Google client
// secret and nothing that can sign for an install:
// - GET  /google/authorize  install → Google, with the install's own nonce and
//   PKCE challenge, and a signed broker state naming the install.
// - GET  /google/callback   Google → the install's registered origin only.
// - POST /google/redeem     the install (Ed25519-signed, within 60 s) trades
//   the code for Google's raw ID token, returned unmodified. It sends back the
//   broker state with H(client nonce || challenge), which must match. The install
//   verifies it itself (signature, aud, its nonce, hd); the broker never
//   vouches for anyone.
import {
  brokerNonce,
  flowHash,
  GOOGLE_AUTHORIZE_URL,
  GOOGLE_TOKEN_URL,
  isPlatformPrincipalId,
  verifyBrokerTicket,
} from "@oa/auth-core";
import {
  ASSERTION_SKEW_MS,
  type BrokerState,
  badFlow,
  json,
  installLimited as limitInstall,
  ipLimited as limitIp,
  logger,
  MAX_BODY,
  notFound,
  fixedOrigin as originOf,
  rateKeyOf,
  readState as readSigned,
  refused,
  same,
  signState as signSigned,
  staleAssertion,
  verifyAssertion,
  verifyState as verifySigned,
} from "@oa/broker-core";
import { lookupInstall } from "./registry.js";

export interface Env {
  BROKER_REGISTRY: KVNamespace;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  /**
   * The broker's fixed public origin (https://auth.<hosted>). redirect_uri is
   * always built from this var, never from the request Host: the one URI
   * registered with Google must not move with a forged or proxied Host header.
   */
  BROKER_ORIGIN: string;
  /** HMAC key for the broker's own state parameter (32+ chars). */
  BROKER_STATE_KEY: string;
  /** Per-IP and per-install rate limits; unbound means fail closed (503). */
  RL_BROKER_IP?: RateLimit;
  RL_BROKER_INSTALL?: RateLimit;
}

// Responses, logging, the signed state, rate limits and the install
// assertion are @oa/broker-core's, shared with the directory broker.
const STATE_TTL_MS = 10 * 60_000;
const REDEEM_PATH = "/google/redeem";
/** S256 of 32 bytes, base64url: exactly what the installs generate. */
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
const enc = new TextEncoder();
const log = logger("broker");

/**
 * The broker state binds the exact flow: install, the install's client state,
 * H(client nonce || code challenge), and a short expiry. A state minted for
 * one nonce/challenge pair can't be replayed for another. Sign-in states are
 * MACed over the payload alone (no domain), as in P2.
 */
const signState = (env: Env, st: BrokerState) =>
  signSigned(env.BROKER_STATE_KEY, st);
const readState = (env: Env, v: string, now: number) =>
  readSigned(env.BROKER_STATE_KEY, v, now);

/** The fixed public origin, or null when BROKER_ORIGIN is missing/invalid. */
const fixedOrigin = (env: Env) => originOf(env.BROKER_ORIGIN);

const callbackUrl = (origin: string) => `${origin}/google/callback`;

const limits = (env: Env) => ({
  ip: env.RL_BROKER_IP,
  install: env.RL_BROKER_INSTALL,
});
const ipLimited = (env: Env, req: Request) => limitIp(limits(env), req, log);
/**
 * Per-install buckets, one per route (review item 24): the unauthenticated
 * authorize can't drain the signed redeem's bucket, so a few IPs naming an
 * install (its id is public in /healthz) can't block its sign-ins. The
 * directory broker scopes its routes the same way.
 */
const installLimited = (env: Env, install: string, scope: string) =>
  limitInstall(limits(env), install, log, scope);

async function authorize(
  req: Request,
  env: Env,
  now: number,
): Promise<Response> {
  const q = new URL(req.url).searchParams;
  const install = q.get("install") ?? "";
  const state = q.get("state") ?? "";
  const nonce = q.get("nonce") ?? "";
  const challenge = q.get("code_challenge") ?? "";
  if (
    !state ||
    !nonce ||
    !CHALLENGE_RE.test(challenge) ||
    state.length > 512 ||
    nonce.length > 512
  )
    return notFound();
  const origin = fixedOrigin(env);
  if (!origin)
    return (
      log("authorize", "misconfigured"), json({ error: "server_error" }, 500)
    );
  const limited = await ipLimited(env, req);
  if (limited) return limited;
  const entry = await lookupInstall(env.BROKER_REGISTRY, install, now);
  if (!entry) return log("authorize", "unknown_install"), notFound();
  // Platform principals (the Provisioning API's admin sign-in, design v7
  // 4.3): a ticket signed by the entry's key over this flow, checked before
  // the install bucket, so nobody can drain it and lock the admin out.
  const platform = isPlatformPrincipalId(install);
  if (
    platform &&
    !(await verifyBrokerTicket(
      entry.keys,
      q.get("ticket") ?? "",
      { install, state, challenge },
      now,
    ))
  )
    return log("authorize", "bad_ticket"), notFound();
  // A ticket is still anonymous (anyone may start a sign-in) and replayable
  // until exp, so a platform principal's authorize bucket is per client
  // (rateKeyOf, IPv6 by /64), never one shared bucket: replays drain only
  // the replayer's own key and the admin's sign-in stays open.
  const busy = await installLimited(
    env,
    install,
    platform ? `authorize:${rateKeyOf(req)}` : "authorize",
  );
  if (busy) return busy;
  const u = new URL(GOOGLE_AUTHORIZE_URL);
  u.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: callbackUrl(origin),
    response_type: "code",
    scope: "openid email profile",
    state: await signState(env, {
      i: install,
      s: state,
      h: await flowHash(nonce, challenge),
      exp: now + STATE_TTL_MS,
    }),
    // One Google client, one redirect URI: bind the nonce to this install so
    // a token minted through another install can never redeem here. The
    // install keeps `nonce` itself and recomputes this for verification.
    nonce: await brokerNonce(install, nonce),
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "select_account",
    ...(entry.domains?.[0] ? { hd: entry.domains[0] } : {}),
    // The install's break-glass sign-in (P3 T18): Google must
    // re-authenticate; the install checks auth_time.
    ...(q.get("reauth") === "1" ? { max_age: "0" } : {}),
  }).toString();
  log("authorize", "ok");
  return Response.redirect(u.toString(), 302);
}

async function callback(
  req: Request,
  env: Env,
  now: number,
): Promise<Response> {
  const q = new URL(req.url).searchParams;
  const raw = q.get("state") ?? "";
  const st = await readState(env, raw, now);
  // A late return (Google sat open past STATE_TTL_MS) carries a state this
  // broker signed: send the user back to their install's sign-in, not a raw
  // 404. Forgeries still 404, and an expired state never carries a code on.
  const late = st ? null : await verifySigned(env.BROKER_STATE_KEY, raw);
  const flow = st ?? late;
  if (!flow) return log("callback", "bad_state"), notFound();
  const entry = await lookupInstall(env.BROKER_REGISTRY, flow.i, now);
  if (!entry) return log("callback", "unknown_install"), notFound();
  // Only the registry decides where the user goes next.
  const to = new URL("/auth/callback/google", entry.origin);
  const code = late ? null : q.get("code");
  const error = q.get("error");
  if (late) to.searchParams.set("error", "expired");
  else if (code) to.searchParams.set("code", code);
  else
    to.searchParams.set(
      "error",
      error && /^[a-z_]{1,64}$/.test(error) ? error : "access_denied",
    );
  to.searchParams.set("state", flow.s);
  // Back at redeem, with the install's H(nonce || challenge) to match.
  if (!late) to.searchParams.set("bstate", raw);
  log("callback", late ? "expired" : code ? "ok" : "idp_error");
  return new Response(null, {
    status: 302,
    headers: {
      location: to.toString(),
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

type Redeem = {
  install: string;
  code: string;
  verifier: string;
  ts: number;
  /** The broker state this flow's callback carried. */
  bstate: string;
  /** H(client nonce || challenge), recomputed by the install. */
  h: string;
};

async function redeem(req: Request, env: Env, now: number): Promise<Response> {
  const kid = req.headers.get("x-oa-kid") ?? "";
  const sig = req.headers.get("x-oa-sig") ?? "";
  const text = await req.text();
  if (text.length > MAX_BODY) return refused();
  let body: Redeem;
  try {
    body = JSON.parse(text) as Redeem;
  } catch {
    return refused();
  }
  if (
    typeof body?.install !== "string" ||
    typeof body.code !== "string" ||
    typeof body.verifier !== "string" ||
    typeof body.ts !== "number" ||
    typeof body.bstate !== "string" ||
    typeof body.h !== "string"
  )
    return refused();
  const origin = fixedOrigin(env);
  if (!origin)
    return log("redeem", "misconfigured"), json({ error: "server_error" }, 500);
  // A platform principal's redeem arrives over the gate (no
  // cf-connecting-ip), so its IP key is the one shared `gate:<id>` bucket,
  // and the Provisioning API signs anyone's callback (4.3): charging it
  // before the flow check would let junk bstates lock the admin out. That
  // redeem is charged per flow below instead; every other caller (a public
  // one naming a platform id included) pays its IP bucket first.
  const platform = isPlatformPrincipalId(body.install);
  const gated = platform && rateKeyOf(req).startsWith("gate:");
  if (gated) {
    if (!env.RL_BROKER_IP || !env.RL_BROKER_INSTALL)
      return log("rate_limit", "unbound"), json({ error: "unavailable" }, 503);
  } else {
    const limited = await ipLimited(env, req);
    if (limited) return limited;
  }
  const entry = await lookupInstall(env.BROKER_REGISTRY, body.install, now);
  if (!entry) return log("redeem", "unknown_install"), refused();
  // The kid must be one of this install's keys AND derive from its x. The
  // signature covers method, path, kid and body: a valid redeem can't be
  // transplanted to another route or replayed under another key id.
  if (!(await verifyAssertion(entry, REDEEM_PATH, kid, text, sig)))
    return log("redeem", "bad_signature"), refused();
  if (Math.abs(now - body.ts) > ASSERTION_SKEW_MS)
    return log("redeem", "stale"), staleAssertion();
  // The broker state must be this install's, unexpired, and bind the flow
  // the install holds: H(client nonce || challenge), compared in constant time.
  // Checked before the install bucket, so a bad flow charges nothing.
  const st = await readState(env, body.bstate, now);
  if (
    !st ||
    st.i !== body.install ||
    !same(enc.encode(st.h), enc.encode(body.h))
  )
    return log("redeem", "bad_flow"), badFlow();
  // A platform principal's redeem is signed by the Provisioning API for
  // anyone's callback (design v7 4.3), so its bucket is per flow: replaying
  // one flow (anyone may start one) never drains the admin's. The flow is
  // its state, which the ticket binds (authorize).
  const busy = await installLimited(
    env,
    body.install,
    platform ? `redeem:${st.s}` : "redeem",
  );
  if (busy) return busy;

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: body.code,
      redirect_uri: callbackUrl(origin),
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      code_verifier: body.verifier,
    }),
    redirect: "manual",
  }).catch(() => null);
  if (!res?.ok) {
    await res?.body?.cancel();
    return (
      log("redeem", "exchange_failed"), json({ error: "exchange_failed" }, 400)
    );
  }
  const out = (await res.json().catch(() => null)) as {
    id_token?: unknown;
  } | null;
  if (typeof out?.id_token !== "string")
    return (
      log("redeem", "no_id_token"), json({ error: "exchange_failed" }, 400)
    );
  log("redeem", "ok");
  return json({ id_token: out.id_token });
}

export default {
  async fetch(req, env): Promise<Response> {
    const { pathname } = new URL(req.url);
    const now = Date.now();
    if (req.method === "GET" && pathname === "/google/authorize")
      return authorize(req, env, now);
    if (req.method === "GET" && pathname === "/google/callback")
      return callback(req, env, now);
    if (req.method === "POST" && pathname === REDEEM_PATH)
      return redeem(req, env, now);
    return notFound();
  },
} satisfies ExportedHandler<Env>;
