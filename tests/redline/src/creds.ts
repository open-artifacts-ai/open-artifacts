import { createHash, randomBytes } from "node:crypto";
import {
  type Cred,
  describeRes,
  HttpError,
  parseJson,
  readBody,
  withCred,
} from "./http.ts";
import { allMarkers, NotRefused } from "./refused.ts";
import type { Target } from "./targets.ts";

// Helpers for the credential cases (P5 Task 4): the OAuth flow over HTTP,
// per-host credential
// slots and the refusals that aren't a 401/403/404.

// ------------------------------------------------------------------ slots

/**
 * A placeholder Cred whose real value depends on the host it is sent to.
 * crossCheck calls req(credA, a) and req(credA, b); a slot lets a single-use
 * value (an upload URL, a code, a refresh token) be fresh at each host, or a
 * non-credential (an artifact id, a link) stand in for the credential.
 */
const SLOTS = new WeakMap<object, (h: Target) => unknown>();

export function slot<V>(f: (h: Target) => V): Cred {
  const c: Cred = { kind: "none" };
  SLOTS.set(c, f);
  return c;
}

export function slotValue<V>(c: Cred, h: Target): V {
  const f = SLOTS.get(c);
  if (!f) throw new Error("not a slot");
  return f(h) as V;
}

/** Hands out one value per call, in order; throws when used up. */
export function once<V>(...vs: V[]): () => V {
  let i = 0;
  return () => {
    if (i >= vs.length) throw new Error("single-use value already used");
    return vs[i++] as V;
  };
}

// ---------------------------------------------------------------- OAuth

export const REDIRECT_URI = "http://127.0.0.1/p5-redline-callback";

/** POST /oauth/register: a public client for REDIRECT_URI. */
export async function registerClient(t: Target): Promise<string> {
  const res = await fetch(`${t.app}/oauth/register`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: "P5 redline",
    }),
  });
  const text = await readBody(res);
  if (res.status !== 201 && res.status !== 200)
    throw new HttpError(`${t.name} register`, res, text);
  const id = (
    parseJson(res, text, `${t.name} register`) as {
      client_id?: unknown;
    }
  ).client_id;
  if (typeof id !== "string" || !id)
    throw new Error(`${t.name} register: no client_id`);
  return id;
}

/**
 * The install's /mcp resource (server mcpResource): https://<APP_HOST>/mcp.
 * Local installs serve http, but the server still names an https resource
 * for a non-loopback APP_HOST such as rl-a.app.localhost.
 */
export const mcpResource = (t: Target): string =>
  `https://${new URL(t.app).hostname}/mcp`;

export interface Pkce {
  verifier: string;
  challenge: string;
}

export function pkce(): Pkce {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function authorizeUrl(
  t: Target,
  clientId: string,
  challenge: string,
  resource: string,
): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: randomBytes(8).toString("hex"),
    resource,
  });
  return `${t.app}/oauth/authorize?${q}`;
}

const cookiePairs = (res: Response): string[] =>
  res.headers
    .getSetCookie()
    .map((l) => l.split(";")[0]?.trim() ?? "")
    .filter((p) => p.includes("=") && !p.endsWith("="));

const hidden = (html: string, name: string): string | null =>
  new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1] ?? null;

/**
 * The browser consent flow with `cookie` (a session): GET /oauth/authorize,
 * then POST approve. Returns an unredeemed authorization code.
 */
export async function authorizeCode(
  t: Target,
  cookie: Cred,
  clientId: string,
  p: Pkce,
  resource: string,
): Promise<string> {
  if (cookie.kind !== "cookie") throw new Error("consent needs a session");
  const get = await fetch(
    authorizeUrl(t, clientId, p.challenge, resource),
    withCred(cookie),
  );
  const html = await readBody(get);
  if (get.status !== 200) throw new HttpError(`${t.name} authorize`, get, html);
  const csrf = hidden(html, "csrf");
  const request = hidden(html, "request");
  if (!csrf || !request)
    throw new Error(`${t.name} authorize: no consent form`);
  const jar = [`${cookie.name}=${cookie.value}`, ...cookiePairs(get)];
  const post = await fetch(`${t.app}/oauth/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: {
      cookie: jar.join("; "),
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ csrf, request, decision: "approve" }),
  });
  const pb = await readBody(post);
  const loc = post.headers.get("location") ?? "";
  if (post.status !== 302 || !loc.startsWith(REDIRECT_URI))
    throw new HttpError(`${t.name} approve`, post, pb);
  const code = new URL(loc).searchParams.get("code");
  if (!code) throw new Error(`${t.name} approve: no code`);
  return code;
}

export const tokenRequest = (
  t: Target,
  form: Record<string, string>,
): Request =>
  new Request(`${t.app}/oauth/token`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
  });

export const codeForm = (
  clientId: string,
  code: string,
  verifier: string,
  resource: string,
) => ({
  grant_type: "authorization_code",
  code,
  redirect_uri: REDIRECT_URI,
  client_id: clientId,
  code_verifier: verifier,
  resource,
});

export const refreshForm = (
  clientId: string,
  refreshToken: string,
  resource: string,
) => ({
  grant_type: "refresh_token",
  refresh_token: refreshToken,
  client_id: clientId,
  resource,
});

/** Redeems a code: { access_token, refresh_token }. */
export async function redeem(
  t: Target,
  clientId: string,
  code: string,
  verifier: string,
  resource: string,
): Promise<{ accessToken: string; refreshToken: string }> {
  const res = await fetch(
    tokenRequest(t, codeForm(clientId, code, verifier, resource)),
  );
  const text = await readBody(res);
  if (res.status !== 200) throw new HttpError(`${t.name} token`, res, text);
  const j = parseJson(res, text, `${t.name} token`) as {
    access_token?: unknown;
    refresh_token?: unknown;
  };
  if (typeof j.access_token !== "string" || typeof j.refresh_token !== "string")
    throw new Error(`${t.name} token: no access or refresh token`);
  return { accessToken: j.access_token, refreshToken: j.refresh_token };
}

/** A 200 from /oauth/token that issued an access token. */
export async function tokenIssued(r: Response): Promise<boolean> {
  if (r.status !== 200) return false;
  const text = await readBody(r.clone());
  try {
    return typeof JSON.parse(text).access_token === "string";
  } catch {
    return false;
  }
}

// --------------------------------------------------------------- refusals

const noMarker = (body: string, what: string) => {
  for (const m of allMarkers())
    if (body.includes(m))
      throw new NotRefused(`${what}: the body holds a seeded marker`);
};

const noSetCookie = (res: Response, what: string) => {
  if (res.headers.getSetCookie().length > 0)
    throw new NotRefused(`${what}: sets a cookie`);
};

/**
 * /oauth/token refused: a 400 or 401 OAuth error whose `error` is one of
 * `errors`, and no access or refresh token in the body.
 */
export function tokenRefused(errors: readonly string[]) {
  return async (res: Response, b: Target): Promise<void> => {
    const body = await readBody(res);
    const what = `${b.name} /oauth/token did not refuse (${describeRes(res, body)})`;
    if (res.status !== 400 && res.status !== 401) throw new NotRefused(what);
    let j: { error?: unknown; access_token?: unknown; refresh_token?: unknown };
    try {
      j = JSON.parse(body);
    } catch {
      throw new NotRefused(`${what}: not an OAuth error`);
    }
    if (j.access_token !== undefined || j.refresh_token !== undefined)
      throw new NotRefused(`${what}: a token was issued`);
    if (typeof j.error !== "string" || !errors.includes(j.error))
      throw new NotRefused(`${what}: error is not ${errors.join(" or ")}`);
    noSetCookie(res, what);
    noMarker(body, what);
  };
}

/**
 * /oauth/authorize with an unknown client: a 400 (401/403/404 also ok) with
 * no consent form, and never a redirect carrying a code. B can show consent
 * for A's opaque client_id only if it resolves A's client, so a consent page
 * fails too.
 */
export async function authorizeRefused(
  res: Response,
  b: Target,
): Promise<void> {
  const body = await readBody(res);
  const what = `${b.name} /oauth/authorize did not refuse (${describeRes(res, body)})`;
  const loc = res.headers.get("location");
  if (loc && /[?&#]code=/.test(loc))
    throw new NotRefused(`${what}: redirected with a code`);
  if (![400, 401, 403, 404].includes(res.status)) throw new NotRefused(what);
  if (hidden(body, "request") !== null || hidden(body, "csrf") !== null)
    throw new NotRefused(`${what}: a consent form`);
  noSetCookie(res, what);
  noMarker(body, what);
}
