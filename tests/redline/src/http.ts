import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupFetch } from "./fetch-timeout.ts";
import { secretsOf, setPat, type Target } from "./targets.ts";

// Fetch helpers. Every request uses redirect: "manual" (a 3xx is judged, never
// followed). Failure text is status plus a body hash, never the body: bodies
// can carry tokens, cookies or B's data.

export type Cred =
  | { kind: "pat"; token: string }
  | { kind: "oauth"; token: string }
  | { kind: "cookie"; name: string; value: string }
  | { kind: "none" };

/** Status, body hash and length: what a failure message may show. */
export function describeRes(res: Response, body: string): string {
  const h = createHash("sha256").update(body).digest("hex").slice(0, 16);
  return `status ${res.status}, body sha256:${h} (${Buffer.byteLength(body)} bytes)`;
}

/** Reads the body as text, at most once; "" when there is none. */
export async function readBody(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

/** fetch init carrying `cred`, always with redirect: "manual". */
export function withCred(cred: Cred, init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  if (cred.kind === "pat" || cred.kind === "oauth")
    headers.set("authorization", `Bearer ${cred.token}`);
  else if (cred.kind === "cookie")
    headers.set("cookie", `${cred.name}=${cred.value}`);
  return { ...init, headers, redirect: "manual" };
}

/** asA/asB: init builders bound to one side's credential. */
export function asPair(credA: Cred, credB: Cred) {
  return {
    asA: (init?: RequestInit) => withCred(credA, init),
    asB: (init?: RequestInit) => withCred(credB, init),
  };
}

/** fetch with redirect: "manual", whatever the Request says. */
export const send = (req: Request): Promise<Response> =>
  fetch(req, { redirect: "manual" });

/** JSON.parse that never puts body text in an error: status and hash only. */
export function parseJson(res: Response, text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(`${what}: not JSON`, res, text);
  }
}

export class HttpError extends Error {
  readonly status: number;
  constructor(what: string, res: Response, body: string) {
    super(`${what}: ${describeRes(res, body)}`);
    this.status = res.status;
  }
}

// RL_ANON allows 30 hook calls a minute per install and IP, and its refusal is
// the same 404 as every other. Stay under it: at most HOOK_LIMIT calls in any
// HOOK_WINDOW_MS per install. Each live file runs in its own process, so the
// call times live in a file shared across the run's files.
const HOOK_LIMIT = 25;
const HOOK_WINDOW_MS = 60_000;

const hookLedger = (t: Target) =>
  join(
    tmpdir(),
    `oa-redline-hooks-${createHash("sha256").update(t.app).digest("hex").slice(0, 16)}.json`,
  );

function readLedger(path: string): number[] {
  try {
    const v: unknown = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(v) ? v.filter((n) => typeof n === "number") : [];
  } catch {
    return [];
  }
}

/** Waits until a hook call to `t` stays under the limit, then records it. */
async function paceHook(t: Target): Promise<void> {
  const path = hookLedger(t);
  for (;;) {
    const now = Date.now();
    const calls = readLedger(path).filter((at) => now - at < HOOK_WINDOW_MS);
    if (calls.length < HOOK_LIMIT) {
      calls.push(now);
      writeFileSync(path, JSON.stringify(calls), { mode: 0o600 });
      return;
    }
    const wait = HOOK_WINDOW_MS - (now - Math.min(...calls)) + 100;
    await new Promise((r) => setTimeout(r, wait));
  }
}

/** POST a /__test/* hook with the target's key. Throws HttpError unless 2xx. */
export async function hook(
  t: Target,
  path: string,
  body?: unknown,
): Promise<unknown> {
  if (!path.startsWith("/__test/"))
    throw new Error("hook paths start with /__test/");
  await paceHook(t);
  const res = await fetch(`${t.app}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: {
      authorization: `Bearer ${secretsOf(t).hookKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body ?? {}),
  });
  const text = await readBody(res);
  if (res.status < 200 || res.status > 299)
    throw new HttpError(`${t.name} hook ${path}`, res, text);
  return parseJson(res, text, `${t.name} hook ${path}`);
}

/** The suite's admin test user: hooks never act on the owner. */
export const adminEmail = (t: Target) => `redline-admin@${t.testDomain}`;

/** A session cookie for a TEST_DOMAIN user via POST /__test/session. */
export async function sessionCred(
  t: Target,
  email: string = adminEmail(t),
  role: "admin" | "member" | "guest" = "admin",
): Promise<Cred> {
  const out = (await hook(t, "/__test/session", { email, role })) as {
    cookie?: unknown;
  };
  if (typeof out.cookie !== "string" || !out.cookie)
    throw new Error(`${t.name} session hook: no cookie`);
  return { kind: "cookie", name: t.cookieName, value: out.cookie };
}

/** POST /api/v1/tokens with a session cookie: 201 { token }. */
export async function mintPat(t: Target, cookie: Cred): Promise<Cred> {
  const res = await fetch(
    `${t.app}/api/v1/tokens`,
    withCred(cookie, {
      method: "POST",
      headers: { "content-type": "application/json", "x-oa-request": "1" },
      body: JSON.stringify({ label: "redline" }),
    }),
  );
  const text = await readBody(res);
  if (res.status !== 201) throw new HttpError(`${t.name} mint PAT`, res, text);
  const token = (
    parseJson(res, text, `${t.name} mint PAT`) as { token?: unknown }
  ).token;
  if (typeof token !== "string" || !token)
    throw new Error(`${t.name} mint PAT: no token`);
  return { kind: "pat", token };
}

export interface AdminCreds {
  cookie: Cred;
  pat: Cred;
}

/**
 * The per-install credential: the admin test user's cookie, and its PAT (the
 * CI secret when given, else minted). The PAT must belong to that user.
 */
export async function adminCreds(t: Target): Promise<AdminCreds> {
  const cookie = await sessionCred(t);
  const s = secretsOf(t);
  let pat: Cred;
  if (s.pat) pat = { kind: "pat", token: s.pat };
  else {
    pat = await mintPat(t, cookie);
    if (pat.kind === "pat") setPat(t, pat.token);
  }
  const res = await fetch(`${t.app}/api/v1/me`, withCred(pat));
  const text = await readBody(res);
  if (res.status !== 200)
    throw new HttpError(`${t.name} PAT /api/v1/me`, res, text);
  const email = (
    parseJson(res, text, `${t.name} /api/v1/me`) as {
      user?: { email?: unknown };
    }
  ).user?.email;
  if (email !== adminEmail(t))
    throw new Error(`${t.name}: the PAT is not the admin test user's`);
  return { cookie, pat };
}

/** A fresh marker: REDLINE-<install>-<random>. */
export const newMarker = (t: Target) =>
  `REDLINE-${t.name}-${randomBytes(9).toString("base64url")}`;

/** Publishes a private markdown artifact whose title and content carry the marker. */
export async function publishMarker(
  t: Target,
  pat: Cred,
  marker: string,
): Promise<string> {
  // A setup publish: SETUP_PUBLISH_MS, a timeout is infra (never retried).
  const { res, text } = await setupFetch(
    t.name,
    new Request(
      `${t.app}/api/v1/artifacts`,
      withCred(pat, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: marker,
          format: "markdown",
          content: `# ${marker}\n\nRed-line marker. Never visible outside ${t.name}.\n`,
        }),
      }),
    ),
  );
  if (res.status < 200 || res.status > 299)
    throw new HttpError(`${t.name} seed marker`, res, text);
  const id = (parseJson(res, text, `${t.name} seed marker`) as { id?: unknown })
    .id;
  if (typeof id !== "string") throw new Error(`${t.name} seed marker: no id`);
  return id;
}

/**
 * True when a response came from the content app: it alone sets
 * Cross-Origin-Resource-Policy: cross-origin with Access-Control-Allow-Origin: *
 * on every response (apps/server/src/content/app.ts).
 */
export const fromContentApp = (res: Response): boolean =>
  res.headers.get("cross-origin-resource-policy") === "cross-origin" &&
  res.headers.get("access-control-allow-origin") === "*";
