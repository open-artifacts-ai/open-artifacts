// Sign-in negative cases for P5's cross-tenant suite (P2 T13). Each case
// takes two installs, A and B, gets real credentials from A (through the
// /__test/* hooks, T14) and asserts B refuses them. No cloudflare:workers
// import: the same catalog runs locally (xt.local.test.ts, two envs in one
// worker) and live against two staging installs (xt:live, plain fetch).
// Broker, tenant and server host-404 cases: #423 (P5).
import {
  AUTH,
  R,
  SIGN_IN_PAGE,
  TEST_HOOKS,
  TEST_OTP_OUTCOMES,
} from "@oa/shared";
import { EMAIL_TIMEOUT_MS } from "../../src/email/timeout.js";

export type Install = {
  /** App origin, e.g. https://stg-a.example.com. */
  origin: string;
  /** Content origin (untrusted artifact files), e.g. https://stg-a-content.example.com. */
  contentOrigin: string;
  /** TEST_HOOK_KEY of this install. */
  hookKey: string;
  /** Session cookie name (__Host-oa_session in production). */
  sessionCookie: string;
  /** Pending-code cookie name (__Host-oa_code in production). */
  codeCookie: string;
  /** A Turnstile token the install accepts (its test secret), when it has Turnstile. */
  turnstileToken?: string;
  /**
   * A Google authorization code that redeems to an ID token signed by an
   * attacker key (local fake Google). Live installs can't be handed one, so
   * they get an unknown code instead: Google refuses it, also `error=failed`.
   */
  forgeGoogleCode?(p: { nonce: string; challenge: string }): Promise<string>;
  /** Sends a request (to this install, or to any URL for host cases). */
  fetch(req: Request): Promise<Response>;
};

export type NegativeCase = {
  name: string;
  /** Needs separate D1/KV per install or real hostnames (live installs only). */
  liveOnly?: boolean;
  run(a: Install, b: Install): Promise<void>;
};

class Refusal extends Error {}

/** A short, non-reversible fingerprint of a body. */
async function hashText(text: string): Promise<string> {
  const d = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(d)]
    .slice(0, 6)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const bodyHash = async (r: Response) =>
  hashText(
    await r
      .clone()
      .text()
      .catch(() => ""),
  );

/**
 * Failure messages carry the status and a body hash only (P5 rule): never a
 * key, code, cookie or body, so a failing release run can't leak them.
 */
async function expectStatus(
  r: Response,
  ok: number[],
  what: string,
): Promise<void> {
  if (!ok.includes(r.status))
    throw new Refusal(
      `${what}: expected ${ok.join("/")}, got ${r.status} (body sha256 ${await bodyHash(r)})`,
    );
}

/** The body as a JSON object; a non-JSON body fails with its hash only. */
async function readJson(
  r: Response,
  what: string,
): Promise<Record<string, unknown>> {
  const text = await r.text().catch(() => "");
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new Refusal(
      `${what}: body is not JSON (sha256 ${await hashText(text)})`,
    );
  }
  if (typeof v !== "object" || v === null || Array.isArray(v))
    throw new Refusal(
      `${what}: body is not a JSON object (sha256 ${await hashText(text)})`,
    );
  return v as Record<string, unknown>;
}

async function readString(
  r: Response,
  key: string,
  what: string,
): Promise<string> {
  const v = (await readJson(r, what))[key];
  if (typeof v !== "string" || !v)
    throw new Refusal(`${what}: no ${key} in the body`);
  return v;
}

/** Every catalog address is under this domain: both installs run with TEST_DOMAIN set to it (#393). */
export const XT_DOMAIN = "xt-guest.example";

const unique = (local: string) =>
  `${local}-${crypto.randomUUID().slice(0, 8)}@${XT_DOMAIN}`;

const hostOf = (origin: string) => new URL(origin).host;

function send(
  to: Install,
  path: string,
  init: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
    origin?: string;
  } = {},
): Promise<Response> {
  return to.fetch(
    new Request(`${init.origin ?? to.origin}${path}`, {
      method: init.method ?? "GET",
      headers: {
        ...(init.body !== undefined
          ? { "content-type": "application/json" }
          : {}),
        ...init.headers,
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      redirect: "manual",
    }),
  );
}

const hook = (to: Install, path: string, body: unknown = {}) =>
  send(to, path, {
    method: "POST",
    body,
    headers: { authorization: `Bearer ${to.hookKey}` },
  });

/**
 * Clears this runner's own per-IP code buckets on `to` (code:ip, code:fail),
 * so repeated runs from one IP never hit the 50-a-day cap (flake server #6).
 * Returns how many buckets went; throws unless the hook answered 200.
 */
export async function resetCodeCaps(to: Install): Promise<number> {
  const r = await hook(to, TEST_HOOKS.codeCapsReset, {});
  await expectStatus(r, [200], `code-caps reset on ${to.origin}`);
  const n = ((await r.json()) as { reset?: unknown }).reset;
  if (typeof n !== "number") throw new Refusal("code-caps reset: no count");
  return n;
}

const setsSession = (r: Response, to: Install) =>
  r.headers
    .getSetCookie()
    .some((c) => c.startsWith(`${to.sessionCookie}=`) && !/^[^=]+=;/.test(c));

async function sessionOn(
  to: Install,
  role: "member" | "guest",
  email = unique(role),
) {
  const r = await hook(to, TEST_HOOKS.session, { email, role });
  await expectStatus(r, [200], `session hook on ${to.origin}`);
  const value = await readString(r, "cookie", "session hook");
  return { email, value, cookie: `${to.sessionCookie}=${value}` };
}

const json = { "x-oa-request": "1", "sec-fetch-site": "same-origin" };

/** Requests a code at `to` for `email`; returns the pending cookie pair. */
async function requestCode(to: Install, email: string): Promise<string> {
  const r = await send(to, AUTH.codeRequest, {
    method: "POST",
    body: {
      email,
      ...(to.turnstileToken ? { turnstileToken: to.turnstileToken } : {}),
    },
    headers: json,
  });
  await expectStatus(r, [202], `code request on ${to.origin}`);
  const set = r.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${to.codeCookie}=`));
  if (!set) throw new Refusal("no pending cookie");
  return set.split(";")[0] as string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * How long the OTP hook may answer "pending": the send runs after the 202 and
 * gives up after EMAIL_TIMEOUT_MS, so its outcome is final by then (+ slack).
 */
const OTP_DEADLINE_MS = EMAIL_TIMEOUT_MS + 10_000;

/** A no_code 404's error.details.outcome, when it is a known outcome. */
async function otpOutcome(r: Response): Promise<string | null> {
  const body = (await r
    .clone()
    .json()
    .catch(() => null)) as {
    error?: { details?: { outcome?: unknown } };
  } | null;
  const o = body?.error?.details?.outcome;
  return TEST_OTP_OUTCOMES.find((x) => x === o) ?? null;
}

/**
 * The OTP hook's code (it is mailed after the response): asked once a second
 * while the hook's 404 says the send is "pending", up to OTP_DEADLINE_MS. Any
 * other 404 outcome is final and fails with it.
 */
async function latestOtp(to: Install, email: string): Promise<Response> {
  const end = Date.now() + OTP_DEADLINE_MS;
  for (;;) {
    const r = await hook(to, TEST_HOOKS.otpLatest, { email });
    if (r.status !== 404) return r;
    const outcome = await otpOutcome(r);
    if (outcome !== "pending")
      throw new Refusal(
        `otp hook on ${to.origin}: no code (outcome ${outcome ?? "unknown"})`,
      );
    if (Date.now() >= end)
      throw new Refusal(
        `otp hook on ${to.origin}: still pending after ${OTP_DEADLINE_MS} ms`,
      );
    await sleep(1000);
  }
}

async function codeAt(to: Install, email: string): Promise<string> {
  const r = await latestOtp(to, email);
  await expectStatus(r, [200], `otp hook on ${to.origin}`);
  return readString(r, "code", "otp hook");
}

async function verifyAt(to: Install, code: string, pending: string) {
  return send(to, AUTH.codeVerify, {
    method: "POST",
    body: { code },
    headers: { ...json, cookie: pending },
  });
}

async function expectReason(r: Response, reason: string, what: string) {
  await expectStatus(r, [401], what);
  const err = (await readJson(r, what)).error as
    | { details?: { reason?: unknown } }
    | undefined;
  const got = err?.details?.reason;
  if (got !== reason)
    throw new Refusal(`${what}: expected ${reason}, got ${String(got)}`);
}

/** /sign-in?error=<error> with no session cookie. */
function expectSignInError(
  r: Response,
  b: Install,
  error: string,
  what: string,
) {
  if (r.status !== 302)
    throw new Refusal(`${what}: expected 302, got ${r.status}`);
  const loc = new URL(r.headers.get("location") ?? "", b.origin);
  if (loc.pathname !== SIGN_IN_PAGE || loc.searchParams.get("error") !== error)
    throw new Refusal(
      `${what}: expected ${SIGN_IN_PAGE}?error=${error}, got ${loc.pathname} error=${loc.searchParams.get("error")}`,
    );
  if (setsSession(r, b)) throw new Refusal(`${what}: a session was set`);
}

const mcpList = (bearer: string) => ({
  method: "POST",
  body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
  headers: {
    authorization: `Bearer ${bearer}`,
    accept: "application/json, text/event-stream",
  },
});

export const SIGNIN_NEGATIVE_CASES: NegativeCase[] = [
  {
    name: "A's session cookie is refused at B",
    async run(a, b) {
      const { cookie } = await sessionOn(a, "member");
      await expectStatus(
        await send(a, R.me, { headers: { cookie } }),
        [200],
        "A /me",
      );
      await expectStatus(
        await send(b, R.me, { headers: { cookie } }),
        [401],
        "B /me with A's cookie",
      );
    },
  },
  {
    name: "A's code used at B (with B's own pending cookie) is invalid_code",
    async run(a, b) {
      const { email } = await sessionOn(a, "guest");
      await sessionOn(b, "guest", email);
      await requestCode(a, email);
      const pendingB = await requestCode(b, email);
      const codeA = await codeAt(a, email);
      const codeB = await codeAt(b, email);
      if (codeA === codeB) throw new Refusal("A and B issued the same code");
      const r = await verifyAt(b, codeA, pendingB);
      if (setsSession(r, b))
        throw new Refusal("B issued a session for A's code");
      await expectReason(r, "invalid_code", "B verify with A's code");
    },
  },
  {
    name: "A's code with A's pending cookie is refused at B",
    async run(a, b) {
      const { email } = await sessionOn(a, "guest");
      await sessionOn(b, "guest", email);
      const pendingA = await requestCode(a, email);
      const code = await codeAt(a, email);
      const r = await verifyAt(
        b,
        code,
        pendingA.replace(a.codeCookie, b.codeCookie),
      );
      await expectStatus(r, [401], "B verify with A's code and pending cookie");
      if (setsSession(r, b))
        throw new Refusal("B issued a session for A's code");
    },
  },
  {
    name: "A's pending-code cookie is no_pending at B",
    async run(a, b) {
      const { email } = await sessionOn(a, "guest");
      const pendingA = await requestCode(a, email);
      const r = await verifyAt(
        b,
        "00000000",
        pendingA.replace(a.codeCookie, b.codeCookie),
      );
      await expectReason(r, "no_pending", "B verify with A's pending cookie");
    },
  },
  {
    name: "a user known only at A gets no code at B",
    // Locally both envs share one users table, so B knows every A user.
    liveOnly: true,
    async run(a, b) {
      const { email } = await sessionOn(a, "guest");
      await requestCode(a, email);
      const codeA = await codeAt(a, email);
      // Same answer as for a known address: 202 and a pending cookie.
      const pendingB = await requestCode(b, email);
      await sleep(1500);
      await expectStatus(
        await hook(b, TEST_HOOKS.otpLatest, { email }),
        [404],
        "B otp hook for an address B doesn't know",
      );
      const r = await verifyAt(b, codeA, pendingB);
      if (setsSession(r, b)) throw new Refusal("B issued a session");
      await expectStatus(r, [401], "B verify for an unknown user");
    },
  },
  {
    name: "a session cookie means nothing on the content host or under another name",
    async run(a, _b) {
      const { value, cookie } = await sessionOn(a, "member");
      // The content host serves no API and never sets a cookie.
      const c = await send(a, R.me, {
        origin: a.contentOrigin,
        headers: { cookie },
      });
      if (c.status === 200) throw new Refusal("content host answered /me");
      if (c.headers.getSetCookie().length)
        throw new Refusal("content host set a cookie");
      // Names a content-host page could plant (no __Host- prefix): refused.
      const bare = a.sessionCookie.replace(/^__Host-/, "");
      if (bare !== a.sessionCookie)
        for (const name of [bare, `__Secure-${bare}`])
          await expectStatus(
            await send(a, R.me, { headers: { cookie: `${name}=${value}` } }),
            [401],
            `A /me with the session under ${name}`,
          );
    },
  },
  {
    name: "Host and X-Forwarded-Host don't make B accept A's cookie",
    async run(a, b) {
      const { cookie } = await sessionOn(a, "member");
      const ah = hostOf(a.origin);
      const bh = hostOf(b.origin);
      const swap = (h: string) => ({
        host: h,
        "x-forwarded-host": h,
        "x-original-host": h,
        forwarded: `host=${h}`,
      });
      await expectStatus(
        await send(b, R.me, { headers: { cookie, ...swap(ah) } }),
        // 404: a foreign Host is refused before any session read (#415);
        // 401: the request reached B and B refused A's cookie. Never 200.
        [401, 404],
        "B /me with A's cookie and A's host headers",
      );
      // A ignores forwarded hosts: still A, still its own session.
      await expectStatus(
        await send(a, R.me, {
          headers: { cookie, "x-forwarded-host": bh, forwarded: `host=${bh}` },
        }),
        [200],
        "A /me with B's forwarded host",
      );
    },
  },
  {
    name: "an unmapped host on the install's zone is 404",
    // Needs real DNS and the platform's host map.
    liveOnly: true,
    async run(a, _b) {
      const u = new URL(a.origin);
      const parent = u.hostname.split(".").slice(1).join(".");
      const origin = `${u.protocol}//xt-unmapped-${crypto.randomUUID().slice(0, 8)}.${parent}`;
      let r: Response;
      try {
        r = await a.fetch(
          new Request(`${origin}/healthz`, { redirect: "manual" }),
        );
      } catch {
        return; // not even resolvable: nothing serves it
      }
      await expectStatus(r, [404], "unmapped host");
      if (r.headers.getSetCookie().length)
        throw new Refusal("unmapped host set a cookie");
    },
  },
  {
    name: "a Google callback with a forged ID token signature is error=failed at B",
    async run(_a, b) {
      const start = await send(b, `${AUTH.loginGoogle}?next=%2F`);
      if (start.status !== 302)
        throw new Refusal(`B Google login: expected 302, got ${start.status}`);
      const loc = new URL(start.headers.get("location") ?? "");
      const state = loc.searchParams.get("state") ?? "";
      const nonce = loc.searchParams.get("nonce") ?? "";
      const challenge = loc.searchParams.get("code_challenge") ?? "";
      const cookie = start.headers
        .getSetCookie()
        .map((c) => c.split(";")[0] as string)
        .filter((c) => !c.endsWith("="))
        .join("; ");
      if (!state || !cookie) throw new Refusal("B Google login: no state");
      const code = b.forgeGoogleCode
        ? await b.forgeGoogleCode({ nonce, challenge })
        : `xt-forged-${crypto.randomUUID()}`;
      const r = await send(
        b,
        `${AUTH.callbackGoogle}?state=${encodeURIComponent(state)}&code=${encodeURIComponent(code)}`,
        { headers: { cookie } },
      );
      expectSignInError(r, b, "failed", "B callback with a forged token");
    },
  },
  {
    name: "an unsolicited Google callback creates no session at B",
    async run(_a, b) {
      const r = await send(
        b,
        `${AUTH.callbackGoogle}?state=forged&code=forged`,
      );
      if (setsSession(r, b))
        throw new Refusal("session set by a forged callback");
    },
  },
  {
    name: "A's PAT is refused at B (REST and /mcp)",
    liveOnly: true,
    async run(a, b) {
      const { cookie } = await sessionOn(a, "member");
      const t = await send(a, R.tokens, {
        method: "POST",
        body: { label: "xt" },
        headers: { ...json, cookie },
      });
      await expectStatus(t, [201], "A creates a PAT");
      const token = await readString(t, "token", "A creates a PAT");
      await expectStatus(
        await send(b, R.me, { headers: { authorization: `Bearer ${token}` } }),
        [401],
        "B /me with A's PAT",
      );
      await expectStatus(
        await send(b, "/mcp", mcpList(token)),
        [401],
        "B /mcp with A's PAT",
      );
    },
  },
  {
    name: "A's OAuth access token is refused at B",
    liveOnly: true,
    async run(a, b) {
      const r = await hook(a, TEST_HOOKS.oauthClient);
      await expectStatus(r, [200], "A oauth-client hook");
      const accessToken = await readString(r, "accessToken", "oauth hook");
      await expectStatus(
        await send(b, "/mcp", mcpList(accessToken)),
        [401],
        "B /mcp with A's OAuth token",
      );
    },
  },
];
