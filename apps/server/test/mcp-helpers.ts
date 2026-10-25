import { env } from "cloudflare:workers";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { expect } from "vitest";
import worker from "../src/index.js";
import { fetchAndWait, login } from "./helpers.js";

export const APP = "https://app.localhost";
export const MCP_URL = `${APP}/mcp`;

export const E = (over: Record<string, unknown> = {}) =>
  ({ ...(env as object), ...over }) as never;

/**
 * RL_ANON stub: `max` per key (the binding's 30/min) with no clock, so a test
 * never straddles the real fixed window. `counts` records every key charged.
 */
export const limiter = (max = 30) => {
  const counts = new Map<string, number>();
  return {
    counts,
    RL_ANON: {
      async limit({ key }: { key: string }) {
        const n = (counts.get(key) ?? 0) + 1;
        counts.set(key, n);
        return { success: n <= max };
      },
    },
  };
};

/** Calls the Worker (default export), awaiting its waitUntil work. */
export const callWorker = (req: Request, e: unknown = E()) =>
  fetchAndWait(worker as never, req, e);

/** An MCP client connected to the Worker's /mcp with `Authorization: Bearer <token>`. */
export async function connect(
  token: string,
  opts: {
    env?: unknown;
    clientInfo?: { name: string; version: string };
    /** Negotiate the 2026-07-28 per-request era instead of 2025 (the default). */
    modern?: boolean;
  } = {},
): Promise<Client> {
  const client = new Client(
    opts.clientInfo ?? { name: "test-client", version: "9.9.9" },
    opts.modern ? { versionNegotiation: { mode: "auto" } } : {},
  );
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    fetch: (url, init) =>
      callWorker(new Request(String(url), init as RequestInit), opts.env),
  });
  await client.connect(transport);
  return client;
}

export type ToolResult = {
  isError?: boolean;
  content: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
};

export async function tool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  return (await client.callTool({
    name,
    arguments: args,
  })) as unknown as ToolResult;
}

export const textOf = (r: ToolResult) =>
  r.content.map((c) => c.text ?? "").join("\n");

/** A fresh client IP per registration, so tests never share one RL_ANON key. */
let ipSeq = 0;
export const nextIp = () => {
  ipSeq++;
  return `10.${Math.floor(Math.random() * 250)}.${(ipSeq >> 8) & 255}.${ipSeq & 255}`;
};

// ------------------------------------------------- OAuth (shared flow)

export const REDIRECT = "http://localhost:3333/cb";
export const b64url = (b: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(b)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

export async function register(name = "Test Agent"): Promise<string> {
  const r = await callWorker(
    new Request(`${APP}/oauth/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": nextIp(),
      },
      body: JSON.stringify({
        client_name: name,
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    }),
  );
  expect(r.status).toBe(201);
  expect(r.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  return ((await r.json()) as { client_id: string }).client_id;
}

export async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  return { verifier, challenge };
}

export const authorizeUrl = (clientId: string, challenge: string) =>
  `${APP}/oauth/authorize?${new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "st4te",
    resource: `${APP}/mcp`,
  })}`;

export const cookiePairs = (r: Response) =>
  r.headers.getSetCookie().map((c) => c.split(";")[0] ?? "");

/** GET the consent page as `cookie`; returns its form fields and binding cookies. */
export async function consentPage(url: string, cookie: string) {
  const r = await callWorker(new Request(url, { headers: { cookie } }));
  const body = await r.text();
  const field = (n: string) =>
    new RegExp(`name="${n}" value="([^"]*)"`).exec(body)?.[1] ?? "";
  return {
    r,
    body,
    csrf: field("csrf"),
    request: field("request"),
    cookies: cookiePairs(r),
  };
}

export const decide = (
  cookie: string,
  fields: Record<string, string>,
  headers: Record<string, string> = {},
) => {
  const body = new URLSearchParams(fields).toString();
  return callWorker(
    new Request(`${APP}/oauth/authorize`, {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
        "content-length": String(body.length),
        ...headers,
      },
      body,
    }),
  );
};

/** Full flow for `email` (member): register → consent approve → token. */
export async function oauthToken(
  email: string,
  clientName = "Test Agent",
  existing?: { cookie: string; userId: string },
) {
  const member = existing ?? (await login(email));
  const clientId = await register(clientName);
  const { verifier, challenge } = await pkce();
  const page = await consentPage(
    authorizeUrl(clientId, challenge),
    member.cookie,
  );
  expect(page.r.status).toBe(200);
  expect(page.body).toContain(clientName);
  expect(page.body).toContain(email);
  const r = await decide([member.cookie, ...page.cookies].join("; "), {
    csrf: page.csrf,
    request: page.request,
    decision: "approve",
  });
  expect(r.status).toBe(302);
  const loc = new URL(r.headers.get("location") ?? "");
  expect(`${loc.origin}${loc.pathname}`).toBe(REDIRECT);
  expect(loc.searchParams.get("state")).toBe("st4te");
  const code = loc.searchParams.get("code") ?? "";
  const t = await callWorker(
    new Request(`${APP}/oauth/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "cf-connecting-ip": nextIp(),
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT,
        client_id: clientId,
        code_verifier: verifier,
        resource: `${APP}/mcp`,
      }).toString(),
    }),
  );
  expect(t.status).toBe(200);
  expect(t.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  const { access_token } = (await t.json()) as { access_token: string };
  return { member, accessToken: access_token, clientId };
}
