import {
  createHash,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  sign,
} from "node:crypto";
import { createServer, type Server } from "node:http";

// A fake Google for the no-human rehearsal (test/rehearsal.test.ts), on
// 127.0.0.1 only. Local fake-IdP builds reach it through
// src/fake-idp/auth-core-shim.ts; nothing else trusts its key, which is made
// fresh per run and never written to disk. It behaves like Google where the
// capture depends on it:
// - authorize: the account chooser honours `hd` (an account outside it can't
//   sign in, which is why the foreign flow drops the hint); `as=<email>` is
//   the simulated browser picking an account. Redirects with code and state.
// - token: codes are single use, bound to client, redirect_uri and PKCE, and
//   expire after `codeTtlMs` (invalid_grant), measured on a clock tests can
//   move forward (advance). Returns an RS256 ID token with Google's claims.
// - certs: the JWKS (public key only).

export const FAKE_AUTHORIZE = "/o/oauth2/v2/auth";
export const FAKE_TOKEN = "/token";
export const FAKE_CERTS = "/oauth2/v3/certs";

export interface FakeClient {
  secret: string;
  redirectUris: string[];
}

export interface FakeIdpOpts {
  clients: Record<string, FakeClient>;
  /** Accounts that exist (Workspace users: hd is the email's domain). */
  users: string[];
  /** How long a code can be redeemed (default 60 s). */
  codeTtlMs?: number;
}

export interface FakeIdpEvent {
  at: "authorize" | "token";
  ok: boolean;
  /** Why it was refused (never a code or token). */
  why?: string;
}

export interface FakeIdp {
  origin: string;
  /** The verification key (public JWK), for the shim's define. */
  publicJwk: JsonWebKey;
  codeTtlMs: number;
  /** Moves the IdP's clock forward (code expiry only; tokens use real time). */
  advance(ms: number): void;
  events: FakeIdpEvent[];
  stop(): Promise<void>;
}

interface Issued {
  client: string;
  redirectUri: string;
  nonce: string;
  challenge: string;
  user: string;
  at: number;
  used: boolean;
}

type Reply = { status: number; headers: Record<string, string>; body: string };

const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");

function idToken(key: KeyObject, kid: string, claims: object): string {
  const h = b64u(JSON.stringify({ alg: "RS256", kid, typ: "JWT" }));
  const p = b64u(JSON.stringify(claims));
  const s = sign("sha256", Buffer.from(`${h}.${p}`), key);
  return `${h}.${p}.${b64u(s)}`;
}

const domainOf = (email: string) => email.split("@")[1] ?? "";

export async function startFakeIdp(o: FakeIdpOpts): Promise<FakeIdp> {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const kid = randomBytes(8).toString("hex");
  const publicJwk = {
    ...(publicKey.export({ format: "jwk" }) as JsonWebKey),
    kid,
    alg: "RS256",
    use: "sig",
  };
  const codes = new Map<string, Issued>();
  const events: FakeIdpEvent[] = [];
  let offset = 0;
  const now = () => Date.now() + offset;
  const idp = {
    origin: "",
    publicJwk,
    codeTtlMs: o.codeTtlMs ?? 60_000,
    advance: (ms: number) => {
      offset += ms;
    },
    events,
    stop: async () => {},
  };
  const json = (status: number, v: unknown): Reply => ({
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
    body: JSON.stringify(v),
  });
  const refuse = (at: FakeIdpEvent["at"], why: string, status = 400) => {
    events.push({ at, ok: false, why });
    return json(status, { error: at === "token" ? "invalid_grant" : why });
  };

  function authorize(q: URLSearchParams): Reply {
    const client = o.clients[q.get("client_id") ?? ""];
    const redirectUri = q.get("redirect_uri") ?? "";
    if (!client?.redirectUris.includes(redirectUri))
      return refuse("authorize", "redirect_uri_mismatch");
    if (
      q.get("response_type") !== "code" ||
      q.get("code_challenge_method") !== "S256" ||
      !q.get("code_challenge") ||
      !q.get("nonce") ||
      !q.get("state")
    )
      return refuse("authorize", "invalid_request");
    const as = (q.get("as") ?? "").toLowerCase();
    // No account picked yet: Google's chooser (a page, no redirect).
    if (!as)
      return {
        status: 200,
        headers: { "content-type": "text/html" },
        body: "<p>Choose an account</p>",
      };
    if (!o.users.includes(as)) return refuse("authorize", "no_such_account");
    const hd = q.get("hd");
    if (hd && domainOf(as) !== hd)
      return refuse("authorize", "account_outside_hd", 403);
    const code = `4/0fake-${randomBytes(24).toString("base64url")}`;
    codes.set(code, {
      client: q.get("client_id") as string,
      redirectUri,
      nonce: q.get("nonce") as string,
      challenge: q.get("code_challenge") as string,
      user: as,
      at: now(),
      used: false,
    });
    const to = new URL(redirectUri);
    to.searchParams.set("state", q.get("state") as string);
    to.searchParams.set("code", code);
    to.searchParams.set("scope", "email profile openid");
    to.searchParams.set("authuser", "0");
    to.searchParams.set("hd", domainOf(as));
    to.searchParams.set("prompt", "consent");
    events.push({ at: "authorize", ok: true });
    return { status: 302, headers: { location: to.toString() }, body: "" };
  }

  function token(form: URLSearchParams): Reply {
    const code = form.get("code") ?? "";
    const c = codes.get(code);
    if (form.get("grant_type") !== "authorization_code" || !c)
      return refuse("token", "unknown_code");
    if (c.used) return refuse("token", "code_reused");
    if (now() - c.at > idp.codeTtlMs) return refuse("token", "code_expired");
    const client = o.clients[form.get("client_id") ?? ""];
    if (
      form.get("client_id") !== c.client ||
      !client ||
      form.get("client_secret") !== client.secret
    )
      return refuse("token", "invalid_client");
    if (form.get("redirect_uri") !== c.redirectUri)
      return refuse("token", "redirect_uri_mismatch");
    const verifier = form.get("code_verifier") ?? "";
    if (
      createHash("sha256").update(verifier).digest("base64url") !== c.challenge
    )
      return refuse("token", "pkce_mismatch");
    c.used = true;
    const iat = Math.floor(Date.now() / 1000);
    events.push({ at: "token", ok: true });
    return json(200, {
      access_token: `fake-${randomBytes(16).toString("hex")}`,
      expires_in: 3599,
      token_type: "Bearer",
      scope: "openid email profile",
      id_token: idToken(privateKey, kid, {
        iss: "https://accounts.google.com",
        azp: c.client,
        aud: c.client,
        sub: createHash("sha256").update(c.user).digest("hex").slice(0, 21),
        hd: domainOf(c.user),
        email: c.user,
        email_verified: true,
        nonce: c.nonce,
        name: c.user.split("@")[0],
        iat,
        exp: iat + 3600,
        auth_time: iat,
      }),
    });
  }

  const server: Server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    const done = (r: Reply) => {
      res.writeHead(r.status, r.headers);
      res.end(r.body);
    };
    if (req.method === "GET" && u.pathname === FAKE_AUTHORIZE)
      return done(authorize(u.searchParams));
    if (req.method === "GET" && u.pathname === FAKE_CERTS)
      return done(json(200, { keys: [publicJwk] }));
    if (req.method === "POST" && u.pathname === FAKE_TOKEN) {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (d: string) => {
        body += d;
        if (body.length > 16_384) req.destroy();
      });
      req.on("end", () => done(token(new URLSearchParams(body))));
      return;
    }
    done(json(404, { error: "not_found" }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const a = server.address();
  idp.origin = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
  idp.stop = () =>
    new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    });
  return idp;
}
