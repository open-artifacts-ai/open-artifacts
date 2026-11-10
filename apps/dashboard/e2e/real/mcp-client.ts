/// <reference types="node" />
// A real MCP client over Streamable HTTP for the e2e journey, wrapping
// @modelcontextprotocol/client. Two auth modes: a PAT bearer, and OAuth
// (register → dev-login session drives the consent page → code exchange).
import { createHash, randomBytes } from "node:crypto";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import type { Page } from "@playwright/test";
import { APP, loginAs } from "./fixtures";

export const MCP_URL = `${APP}/mcp`;
const REDIRECT = "http://localhost:8977/callback";

const b64url = (b: Buffer) =>
  b
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

export type Agent = {
  client: Client;
  call: (name: string, args?: Record<string, unknown>) => Promise<CallResult>;
  close: () => Promise<void>;
};

export type CallResult = {
  ok: boolean;
  /** The one-line text the server sends in content[0]. */
  text: string;
  /** structuredContent when present. */
  data: Record<string, unknown> | null;
};

/** A connected MCP client with a bearer token (a PAT or an OAuth access token). */
export async function mcpWithToken(
  token: string,
  name = "e2e-agent",
  mcpUrl = MCP_URL,
): Promise<Agent> {
  const client = new Client({ name, version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: {
      redirect: "error",
      headers: { authorization: `Bearer ${token}` },
    },
  });
  await client.connect(transport);
  return {
    client,
    call: (tool, args = {}) => {
      // The server sends one-line text content plus structuredContent.
      return client.callTool({ name: tool, arguments: args }).then((r) => {
        const isError = (r as { isError?: boolean }).isError === true;
        const content = r.content as { type: string; text?: string }[];
        const text = (content?.[0]?.text ?? "").trim();
        const data =
          (r as { structuredContent?: Record<string, unknown> })
            .structuredContent ?? null;
        return { ok: !isError, text, data } satisfies CallResult;
      });
    },
    close: () => client.close(),
  };
}

/** Registers an OAuth client (RFC 7591). */
export async function registerClient(
  client_name: string,
): Promise<{ client_id: string }> {
  const res = await fetch(`${APP}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name,
      redirect_uris: [REDIRECT],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`register: ${res.status} ${text}`);
  return JSON.parse(text);
}

/**
 * The OAuth resource (RFC 8707) the token's audience must name. Discovered from
 * the AS metadata's `protected_resources` (the protected-resource well-known
 * 404s in dev: the configured resource is https:// while dev serves http://).
 */
async function mcpResource(): Promise<string> {
  const res = await fetch(`${APP}/.well-known/oauth-authorization-server`);
  if (!res.ok) throw new Error(`AS metadata: ${res.status}`);
  const json = (await res.json()) as { protected_resources?: string[] };
  const resource = json.protected_resources?.[0];
  if (!resource) throw new Error("AS metadata: no protected_resources");
  return resource;
}

/**
 * A full OAuth connect for `email` (role member): register, dev-login on
 * `page`, drive the consent page, exchange the code (PKCE S256). The code is
 * captured from the consent POST's 302 Location (the redirect target port is
 * intentionally dead). Returns the access token + the registered client name.
 */
export async function oauthSession(
  page: Page,
  email: string,
  clientName: string,
): Promise<{ token: string; clientName: string; clientId: string }> {
  const { client_id } = await registerClient(clientName);
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(8));
  const resource = await mcpResource();
  await loginAs(page, email, "member");

  const authorize = `${APP}/oauth/authorize?${new URLSearchParams({
    client_id,
    redirect_uri: REDIRECT,
    response_type: "code",
    state,
    scope: "mcp",
    // RFC 8707 resource indicator: the token's audience must be /mcp.
    resource,
    code_challenge: challenge,
    code_challenge_method: "S256",
  })}`;
  await page.goto(authorize);
  // The consent form must be up (also covers the login redirect edge cases).
  const approve = page.getByRole("button", { name: "Approve", exact: true });
  await approve.waitFor();
  const posted = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" && r.url().endsWith("/oauth/authorize"),
  );
  await approve.click();
  const res = await posted;
  const loc = new URL(res.headers().location ?? "");
  const code = loc.searchParams.get("code");
  if (res.status() !== 302 || !code) {
    throw new Error(`consent: ${res.status} ${loc.href || "no location"}`);
  }

  const tokenRes = await fetch(`${APP}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      client_id,
      code_verifier: verifier,
    }),
  });
  const tokenJson = (await tokenRes.json()) as {
    access_token?: string;
    error?: string;
  };
  if (!tokenRes.ok || !tokenJson.access_token) {
    throw new Error(
      `token: ${tokenRes.status} ${JSON.stringify(tokenJson).slice(0, 200)}`,
    );
  }
  return { token: tokenJson.access_token, clientName, clientId: client_id };
}
