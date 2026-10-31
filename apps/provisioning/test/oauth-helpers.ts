import { env as testEnv } from "cloudflare:workers";
import { handle } from "../src/app.js";
import { createSession } from "../src/auth/session.js";
import type { Env } from "../src/env.js";
import { platformDb } from "./db.js";
import { ADMIN, API, ctx, fakeEnv } from "./fakes.js";

// The MCP OAuth flow end to end through the HTTP adapter (design v7 9A.3):
// a real admin session in the local D1, the library's store in the local KV.

export const REDIRECT = "http://127.0.0.1:33418/callback";
export const CLAUDE_AI = "https://claude.ai/api/mcp/auth_callback";
export const RESOURCE = `${API}/mcp`;
export const HOUR = 3_600_000;

export const kv = () =>
  (testEnv as unknown as { OAUTH_KV: KVNamespace }).OAUTH_KV;

/** A random IPv4 per case, so the per-IP counters never meet. */
export const randomIp = () =>
  `10.${[0, 0, 0].map(() => Math.floor(Math.random() * 250) + 1).join(".")}`;

/** A fresh admin (own identity) with an env whose ADMIN_IDENTITIES lists it. */
export async function oauthWorld(
  over: Partial<Env> = {},
  sessionMsLeft = 4 * HOUR,
) {
  const db = await platformDb();
  const n = crypto.randomUUID().slice(0, 8);
  const email = `o-${n}@example.com`;
  const sub = `sub-${n}`;
  const f = fakeEnv({
    PLATFORM_DB: db,
    OAUTH_KV: kv(),
    ADMIN_IDENTITIES: `other@example.com:9,${email}:${sub}`,
    ...over,
  });
  const now = Date.now();
  // createSession sets 8 h; move the end to what the case asks for.
  const { sid } = await createSession(f.env, { email, sub, authAt: now }, now);
  await db
    .prepare(
      "UPDATE sessions SET expires_at = ?1 WHERE email = ?2 AND sub = ?3",
    )
    .bind(now + sessionMsLeft, email, sub)
    .run();
  const ip = randomIp();
  const call = (req: Request) => {
    if (!req.headers.has("cf-connecting-ip"))
      req.headers.set("cf-connecting-ip", ip);
    return handle(req, f.env, ctx());
  };
  return { ...f, db, email, sub, sid, ip, call };
}
export type World = Awaited<ReturnType<typeof oauthWorld>>;

const b64url = (b: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(b)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

export async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  return { verifier, challenge };
}

export const registerRaw = (
  w: Pick<World, "call">,
  body: Record<string, unknown>,
  ip?: string,
) =>
  w.call(
    new Request(`${API}/oauth/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(ip ? { "cf-connecting-ip": ip } : {}),
      },
      body: JSON.stringify({ client_name: "Test agent", ...body }),
    }),
  );

export async function register(
  w: Pick<World, "call">,
  authMethod: "none" | "client_secret_basic" = "none",
): Promise<string> {
  const res = await registerRaw(w, {
    redirect_uris: [REDIRECT],
    token_endpoint_auth_method: authMethod,
  });
  if (res.status !== 201)
    throw new Error(`register: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { client_id: string }).client_id;
}

export function authorizeUrl(
  clientId: string,
  challenge: string | null,
  scope = "installs:read audit:read installs:delete installs:pii",
) {
  const u = new URL(`${ADMIN}/oauth/authorize`);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", REDIRECT);
  u.searchParams.set("scope", scope);
  u.searchParams.set("state", "st-1");
  if (challenge !== null) {
    u.searchParams.set("code_challenge", challenge);
    u.searchParams.set("code_challenge_method", "S256");
  }
  u.searchParams.set("resource", RESOURCE);
  return u;
}

export const cookieHeader = (sid: string, extra = "") =>
  `__Host-oa-admin=${sid}${extra ? `; ${extra}` : ""}`;

export const bindingCookies = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

/** The consent page's hidden fields. */
export function formFields(html: string) {
  const field = (name: string) =>
    new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1] ?? "";
  return { request: field("request"), consent: field("consent") };
}

export const getConsent = (
  w: World,
  url: URL,
  headers: Record<string, string> = {},
) =>
  w.call(
    new Request(url, {
      headers: {
        cookie: cookieHeader(w.sid),
        "sec-fetch-site": "none",
        ...headers,
      },
    }),
  );

export async function postConsent(
  w: World,
  page: Response,
  decision: "approve" | "deny",
  scope: string[] = ["installs:read", "audit:read"],
  over: {
    sid?: string;
    headers?: Record<string, string>;
    consent?: string;
  } = {},
) {
  const f = formFields(await page.text());
  const form = new URLSearchParams({
    request: f.request,
    consent: over.consent ?? f.consent,
    decision,
  });
  for (const s of scope) form.append("scope", s);
  return w.call(
    new Request(`${ADMIN}/oauth/authorize`, {
      method: "POST",
      headers: {
        cookie: cookieHeader(over.sid ?? w.sid, bindingCookies(page)),
        "content-type": "application/x-www-form-urlencoded",
        "sec-fetch-site": "same-origin",
        origin: "null",
        ...over.headers,
      },
      body: form,
    }),
  );
}

export const token = (w: Pick<World, "call">, body: Record<string, string>) =>
  w.call(
    new Request(`${API}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body),
    }),
  );

export type Tokens = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
};

/** Register (unless given), consent with Allow: the code, not yet exchanged. */
export async function authorized(
  w: World,
  opts: { clientId?: string; scope?: string[] } = {},
) {
  const clientId = opts.clientId ?? (await register(w));
  const { verifier, challenge } = await pkce();
  const page = await getConsent(w, authorizeUrl(clientId, challenge));
  if (page.status !== 200)
    throw new Error(`consent page: ${page.status} ${await page.text()}`);
  const post = await postConsent(w, page, "approve", opts.scope);
  if (post.status !== 302)
    throw new Error(`consent post: ${post.status} ${await post.text()}`);
  const loc = new URL(post.headers.get("location") ?? "");
  const exchange = () =>
    token(w, {
      grant_type: "authorization_code",
      code: loc.searchParams.get("code") ?? "",
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
      resource: RESOURCE,
    });
  return { clientId, loc, exchange };
}

/** Register, Allow, exchange: a live grant. */
export async function grant(
  w: World,
  opts: { clientId?: string; scope?: string[] } = {},
) {
  const a = await authorized(w, opts);
  const res = await a.exchange();
  if (res.status !== 200)
    throw new Error(`exchange: ${res.status} ${await res.text()}`);
  return { ...a, tokens: (await res.json()) as Tokens };
}

export const refresh = (w: World, clientId: string, t: Tokens) =>
  token(w, {
    grant_type: "refresh_token",
    refresh_token: t.refresh_token ?? "",
    client_id: clientId,
  });

/** The agent_tokens row a grant's access token names (props.tokenId). */
export async function rowOf(w: World, t: Tokens) {
  const grantId = t.access_token.split(":")[1];
  return w.db
    .prepare("SELECT * FROM agent_tokens WHERE grant_id = ?1")
    .bind(grantId)
    .first<{
      id: string;
      kind: string;
      grant_id: string;
      oauth_user: string;
      expires_at: number;
      revoked_at: number | null;
      session_hash: string;
      label: string;
      scopes: string;
    }>();
}
