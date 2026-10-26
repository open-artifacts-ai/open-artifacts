import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  describeRes,
  HttpError,
  hook,
  parseJson,
  readBody,
  send,
} from "./http.ts";
import { allMarkers, NotRefused } from "./refused.ts";
import { label, type TaskLike } from "./report.ts";
import { readSecretFile, secretsOf, type Target } from "./targets.ts";

// Sign-in helpers for live/signin.test.ts (P5 R6). Only real values are ever
// replayed: state, cookies and codes the installs (or Google, through a real
// sign-in) issued. Nothing here mints or signs a token.

export const LOGIN_GOOGLE = "/auth/login/google";
export const CALLBACK_GOOGLE = "/auth/callback/google";
export const CODE_REQUEST = "/auth/code/request";
export const CODE_VERIFY = "/auth/code/verify";
export const OTP_LATEST = "/__test/otp/latest";
const SIGN_IN = "/sign-in";
const SESSION_COOKIES = ["__Host-oa_session", "oa_session"];

export interface CookiePair {
  name: string;
  value: string;
}
export const cookieHeader = (c: CookiePair) => `${c.name}=${c.value}`;

/** First name=value of each Set-Cookie line. */
const pairs = (res: Response): CookiePair[] =>
  res.headers.getSetCookie().map((l) => {
    const [p = ""] = l.split(";");
    const i = p.indexOf("=");
    return { name: p.slice(0, i).trim(), value: p.slice(i + 1).trim() };
  });

/** True when the response sets a non-empty session cookie. */
export const setsSession = (res: Response): boolean =>
  pairs(res).some((c) => SESSION_COOKIES.includes(c.name) && c.value !== "");

export interface GoogleStart {
  /** Where the install sent the browser: Google, or the auth broker. */
  location: URL;
  state: string;
  cookie: CookiePair;
}

/** A real sign-in start at `t`; null when Google sign-in is off (404). */
export async function startGoogle(t: Target): Promise<GoogleStart | null> {
  const res = await fetch(`${t.app}${LOGIN_GOOGLE}?next=%2F`, {
    redirect: "manual",
  });
  const body = await readBody(res);
  if (res.status === 404) return null;
  if (res.status !== 302)
    throw new HttpError(`${t.name} Google start`, res, body);
  const location = new URL(res.headers.get("location") ?? "");
  const state = location.searchParams.get("state") ?? "";
  const cookie = pairs(res).find((c) => /oa_oidc_/.test(c.name));
  if (!state || !cookie?.value)
    throw new Error(`${t.name} Google start: no state or state cookie`);
  return { location, state, cookie };
}

/** GET B's (or A's) Google callback with these query params and cookie. */
export function callbackReq(
  t: Target,
  q: Record<string, string>,
  cookie?: CookiePair,
): Request {
  const u = new URL(`${t.app}${CALLBACK_GOOGLE}`);
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
  return new Request(u, {
    redirect: "manual",
    headers: cookie ? { cookie: cookieHeader(cookie) } : {},
  });
}

const locationOf = (res: Response, t: Target): URL | null => {
  try {
    const l = res.headers.get("location");
    return l ? new URL(l, t.app) : null;
  } catch {
    return null;
  }
};

/**
 * The state checked out and was consumed: the IdP-error path, a 302 to the
 * install's own /sign-in?error=failed and no session. (A callback with
 * `error=access_denied` and a valid state lands here; Google isn't called.)
 */
export function stateAccepted(res: Response, t: Target): boolean {
  const to = locationOf(res, t);
  return (
    res.status === 302 &&
    !setsSession(res) &&
    to?.origin === t.app &&
    to.pathname === SIGN_IN &&
    to.searchParams.get("error") === "failed"
  );
}

/**
 * Refused at the state check: a 302 to the install's own Google login
 * (retry=1) or /sign-in?error=expired, no session, no seeded marker. Never
 * error=failed (that would mean B accepted A's state).
 */
export async function expectStateRefused(
  res: Response,
  t: Target,
): Promise<void> {
  const body = await readBody(res);
  const what = `${t.name} did not refuse the state (${describeRes(res, body)})`;
  const to = locationOf(res, t);
  const retry =
    to?.pathname === LOGIN_GOOGLE && to.searchParams.get("retry") === "1";
  const expired =
    to?.pathname === SIGN_IN && to.searchParams.get("error") === "expired";
  if (res.status !== 302 || to?.origin !== t.app || !(retry || expired))
    throw new NotRefused(what);
  if (setsSession(res)) throw new NotRefused(`${what}: sets a session`);
  for (const m of allMarkers())
    if (body.includes(m)) throw new NotRefused(`${what}: holds a marker`);
}

/** A redirect sign-in refused after the state check: /sign-in?error=<one of>, no session. */
export function signInRefused(...errors: string[]) {
  return async (res: Response, t: Target): Promise<void> => {
    const body = await readBody(res);
    const what = `${t.name} did not refuse the sign-in (${describeRes(res, body)})`;
    const to = locationOf(res, t);
    if (
      res.status !== 302 ||
      to?.origin !== t.app ||
      to.pathname !== SIGN_IN ||
      !errors.includes(to.searchParams.get("error") ?? "")
    )
      throw new NotRefused(what);
    if (setsSession(res)) throw new NotRefused(`${what}: sets a session`);
    for (const m of allMarkers())
      if (body.includes(m)) throw new NotRefused(`${what}: holds a marker`);
  };
}

/** A completed redirect sign-in: 302 with a session cookie. */
export const signedIn = (res: Response) =>
  res.status === 302 && setsSession(res);

// --- one-time codes -------------------------------------------------------

const sameOrigin = (t: Target) => ({
  "content-type": "application/json",
  "x-oa-request": "1",
  "sec-fetch-site": "same-origin",
  origin: t.app,
});

export interface CodeRequested {
  status: number;
  /** The JSON body's keys and value types: what "generic" compares. */
  shape: string;
  pending: CookiePair | null;
}

/** A POST /auth/code/request at `t` for `email`, with `turnstileToken` only when given. */
export function codeRequestReq(
  t: Target,
  email: string,
  turnstileToken?: string,
): Request {
  return new Request(`${t.app}${CODE_REQUEST}`, {
    method: "POST",
    headers: sameOrigin(t),
    body: JSON.stringify({
      email,
      ...(turnstileToken ? { turnstileToken } : {}),
    }),
  });
}

/** codeRequestReq with the target's Turnstile token, if it has one. */
export const ownCodeRequestReq = (t: Target, email: string) =>
  codeRequestReq(t, email, secretsOf(t).turnstile);

/** POST /auth/code/request at `t` for `email` (with the target's Turnstile token, if any). */
export async function requestCode(
  t: Target,
  email: string,
): Promise<CodeRequested> {
  const res = await send(ownCodeRequestReq(t, email));
  const text = await readBody(res);
  let shape = "";
  if (res.status === 202) {
    const v = parseJson(res, text, `${t.name} code request`) as Record<
      string,
      unknown
    >;
    shape = Object.keys(v)
      .sort()
      .map((k) => `${k}:${typeof v[k]}`)
      .join(",");
  }
  const pending =
    pairs(res).find((c) => /oa_code$/.test(c.name) && c.value) ?? null;
  return { status: res.status, shape, pending };
}

/** POST /auth/code/verify at `t` with `code` and a pending-code cookie. */
export function verifyReq(t: Target, code: string, pending: CookiePair) {
  return new Request(`${t.app}${CODE_VERIFY}`, {
    method: "POST",
    headers: { ...sameOrigin(t), cookie: cookieHeader(pending) },
    body: JSON.stringify({ code }),
  });
}

/** A verified code: 200 and a session cookie. */
export const codeAccepted = (res: Response) =>
  res.status === 200 && setsSession(res);

/**
 * The token Cloudflare's always-pass Turnstile test secret accepts. A target
 * sending it proves the code flow, not real bot protection.
 */
export const TURNSTILE_DUMMY_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";
/** The report label of a code sign-in case run on the dummy token. */
export const TURNSTILE_TEST_KEY = "Turnstile test key";

export const usesTurnstileTestKey = (t: Target) =>
  secretsOf(t).turnstile === TURNSTILE_DUMMY_TOKEN;

/** Labels a code sign-in case "Turnstile test key" when any target sends the dummy token. */
export function labelTurnstileTestKey(
  ctx: TaskLike,
  targets: readonly Target[],
): void {
  if (targets.some(usesTurnstileTestKey)) label(ctx, TURNSTILE_TEST_KEY);
}

/** Throws (status and body hash only) unless `res` is 400 turnstile_required. */
export async function expectTurnstileRequired(
  t: Target,
  res: Response,
): Promise<void> {
  const text = await readBody(res);
  let code: unknown;
  try {
    code = (JSON.parse(text) as { error?: { code?: unknown } }).error?.code;
  } catch {
    code = undefined;
  }
  if (res.status !== 400 || code !== "turnstile_required")
    throw new Error(
      `${t.name} code request without a Turnstile token: ${describeRes(res, text)}`,
    );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The last code sent to `email` at `t` (the otp/latest hook), polled for up
 * to `waitMs` (the code is mailed after the response); null when none.
 */
export async function latestOtp(
  t: Target,
  email: string,
  waitMs = 3000,
): Promise<string | null> {
  const end = Date.now() + waitMs;
  for (;;) {
    try {
      const out = (await hook(t, OTP_LATEST, { email })) as { code?: unknown };
      if (typeof out.code === "string" && out.code) return out.code;
      throw new Error(`${t.name} otp hook: no code in the body`);
    } catch (e) {
      if (!(e instanceof HttpError) || e.status !== 404) throw e;
    }
    if (Date.now() >= end) return null;
    await sleep(500);
  }
}

// --- the auth broker (staging) ---------------------------------------------

/**
 * The broker's signed state for a real sign-in start at `t`: follows the
 * install's redirect to the broker's /google/authorize, whose 302 to Google
 * carries it. Null when `t` sends the browser straight to Google (no broker).
 */
export async function brokerState(
  t: Target,
): Promise<{ broker: string; bstate: string } | null> {
  const s = await startGoogle(t);
  if (!s) return null;
  if (s.location.pathname !== "/google/authorize") return null;
  const res = await fetch(s.location, { redirect: "manual" });
  const body = await readBody(res);
  if (res.status !== 302)
    throw new HttpError(`${t.name} broker authorize`, res, body);
  const bstate =
    new URL(res.headers.get("location") ?? "").searchParams.get("state") ?? "";
  if (!bstate) throw new Error(`${t.name} broker authorize: no state`);
  return { broker: s.location.origin, bstate };
}

/**
 * A real broker state with its install id changed and its signature kept:
 * a tamper test, not a new state (the broker's HMAC no longer matches).
 */
export function tamperInstall(bstate: string, installId: string): string {
  const [p = "", sig = ""] = bstate.split(".");
  const st = JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as {
    i?: unknown;
  };
  if (typeof st.i !== "string") throw new Error("broker state: no install");
  st.i = installId;
  return `${Buffer.from(JSON.stringify(st)).toString("base64url")}.${sig}`;
}

/** GET the broker's /google/callback with `bstate` and no code (an IdP error). */
export const brokerCallbackReq = (broker: string, bstate: string) =>
  new Request(
    `${broker}/google/callback?error=access_denied&state=${encodeURIComponent(bstate)}`,
    { redirect: "manual" },
  );

/** The broker relayed the flow to `t`'s own callback. */
export const relayedTo = (res: Response, t: Target) => {
  const to = locationOf(res, t);
  return (
    res.status === 302 &&
    to?.origin === t.app &&
    to.pathname === CALLBACK_GOOGLE
  );
};

// --- real-tenant captures (staging) ----------------------------------------

/**
 * The flows the real-tenant cases need. Each is started by
 * scripts/signin-capture.ts at `at`, then completed in a browser by a REAL
 * user of the named test tenant (P5 plan, Task 3).
 */
export const CAPTURE_FLOWS = {
  /** "hd of A at B", A's success leg. */
  "a-alice": { at: "a", user: "alice@oa-redline-a.fyi" },
  /** "hd of A at B", the refused leg: tenant A's alice through B's flow. */
  "b-alice": { at: "b", user: "alice@oa-redline-a.fyi" },
  /** "A's aud at B": A's code and broker state refused at B, then valid at A. */
  "a-alice-replay": { at: "a", user: "alice@oa-redline-a.fyi" },
  /** "hd of A at B", B's success leg. */
  "b-dave": { at: "b", user: "dave@oa-redline-c.fyi" },
  /** "A's aud at B", B's success leg (Google codes are single use). */
  "b-dave-2": { at: "b", user: "dave@oa-redline-c.fyi" },
} as const;
export type FlowName = keyof typeof CAPTURE_FLOWS;

/** Google codes and broker states live about 10 minutes; the suite allows 9. */
export const CAPTURE_MAX_AGE_MS = 9 * 60_000;

export interface Capture {
  flow: FlowName;
  at: "a" | "b";
  /** The install's own state cookie from the start (the browser never had it). */
  cookie: CookiePair;
  /** The callback query Google (through the broker) sent the browser to. */
  query: { state: string; code: string; bstate?: string };
}

export interface StartedFlow {
  flow: FlowName;
  at: "a" | "b";
  state: string;
  cookie: CookiePair;
  startedAt: number;
}

/**
 * Reads REDLINE_SIGNIN_CAPTURES: `flows.json` (from signin-capture.ts start)
 * and one `<flow>.url` per flow (the callback URL the browser was sent to).
 * Every file is 0600. A missing, stale or mismatched capture throws; the
 * caller turns an absent directory into unproven-live.
 */
export function parseCaptures(
  dir: string,
  t: { a: Target; b: Target },
  now = Date.now(),
): Map<FlowName, Capture> {
  const st = lstatSync(dir);
  if (!st.isDirectory() || (st.mode & 0o077) !== 0)
    throw new Error("captures: the directory must be mode 0700");
  const started = JSON.parse(
    readSecretFile(join(dir, "flows.json"), "captures flows.json"),
  ) as StartedFlow[];
  if (!Array.isArray(started))
    throw new Error("captures: flows.json is not a list");
  const out = new Map<FlowName, Capture>();
  const files = new Set(readdirSync(dir));
  for (const f of started) {
    const spec = CAPTURE_FLOWS[f.flow as FlowName];
    if (!spec || spec.at !== f.at)
      throw new Error(`captures: unknown flow ${String(f.flow)}`);
    if (!(now - f.startedAt <= CAPTURE_MAX_AGE_MS))
      throw new Error(`captures: ${f.flow} is older than 9 minutes`);
    if (!files.has(`${f.flow}.url`))
      throw new Error(`captures: ${f.flow}.url is missing`);
    const u = new URL(
      readSecretFile(join(dir, `${f.flow}.url`), `captures ${f.flow}.url`),
    );
    const target = t[f.at];
    if (u.origin !== target.app || u.pathname !== CALLBACK_GOOGLE)
      throw new Error(
        `captures: ${f.flow}.url is not ${target.name}'s callback`,
      );
    const q = u.searchParams;
    const code = q.get("code") ?? "";
    if (!code) throw new Error(`captures: ${f.flow}.url has no code`);
    if (q.get("state") !== f.state)
      throw new Error(`captures: ${f.flow}.url is from another start`);
    const bstate = q.get("bstate");
    out.set(f.flow as FlowName, {
      flow: f.flow as FlowName,
      at: f.at,
      cookie: f.cookie,
      query: { state: f.state, code, ...(bstate ? { bstate } : {}) },
    });
  }
  for (const k of Object.keys(CAPTURE_FLOWS))
    if (!out.has(k as FlowName))
      throw new Error(`captures: ${k} was not started`);
  return out;
}
