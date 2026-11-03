// #1137: install A, a second install beside the matrix's own (install B),
// and the credentials A issues: the matrix's foreign callers (expect.ts
// FOREIGN_CALLERS) and its foreign signed URLs. workerd only.
//
// A is what provisioning makes for any install: its own SESSION_SECRET and
// CONTENT_SIGNING_KEY (32 random bytes each, as setup generates them), its
// own D1 (FOREIGN_DB, every migration applied) and its own OAuth store
// (FOREIGN_OAUTH_KV), bound by vitest.authz.config.ts only. It runs the same
// Worker code as B. Every credential below is made by A's real code path
// (signSession, createPat, the OAuth provider's own token endpoint, signContent,
// the upload signature) with A's keys and storage, then shown to work at A
// (fixture.ts checkForeignAtA) before the matrix sends it to B.
//
// Each names B's org owner as its subject, at B's session epoch: the worst
// case, a hostile or compromised install A signing for a user it doesn't
// have (user ids show up in API replies). A credential naming one of A's own
// users would find no one at B even with the install check removed, so it
// couldn't prove that check; this one gets B's owner the moment B accepts
// anything of A's.
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import { LIMITS } from "@oa/shared";
import { createPat } from "../../src/auth/pat.js";
import { sessionCookieName, signSession } from "../../src/auth/session.js";
import { type ContentViewer, signContent } from "../../src/content/signing.js";
import type { Env } from "../../src/env.js";
import worker from "../../src/index.js";
import { oauthApi } from "../../src/mcp/oauth-api.js";
import { mcpResource } from "../../src/mcp/server.js";
import { signUpload } from "../../src/services/uploads.js";
import { b64urlEncode } from "../../src/util/crypto.js";
import { fetchAndWait } from "../helpers.js";
import type { ForeignCaller } from "./expect.ts";
import type { Cred } from "./surfaces.ts";

const bound = env as unknown as {
  FOREIGN_DB: D1Database;
  FOREIGN_OAUTH_KV: KVNamespace;
  TEST_MIGRATIONS: D1Migration[];
};

/** 32 random bytes, base64url: how setup and provisioning make a secret. */
const secret = () => b64urlEncode(crypto.getRandomValues(new Uint8Array(32)));

/**
 * Install A's env: B's settings (same flags, same app host, so neither the
 * host check nor an OAuth audience tells them apart; only keys and storage
 * do) with A's own keys, D1 and OAuth store.
 */
export async function installA(b: Env): Promise<Env> {
  if (!bound.FOREIGN_DB || !bound.FOREIGN_OAUTH_KV)
    throw new Error("install A's storage is unbound (vitest.authz.config.ts)");
  await applyD1Migrations(bound.FOREIGN_DB, bound.TEST_MIGRATIONS);
  const a: Env = {
    ...b,
    DB: bound.FOREIGN_DB,
    OAUTH_KV: bound.FOREIGN_OAUTH_KV,
    SESSION_SECRET: secret(),
    CONTENT_SIGNING_KEY: secret(),
  };
  if (a.SESSION_SECRET === b.SESSION_SECRET) throw new Error("same secret");
  return a;
}

/** A's own user row for `subject` (B's org owner's id, at B's epoch). */
export async function seedSubjectAtA(
  a: Env,
  subject: { id: string; email: string; epoch: number },
) {
  await a.DB.prepare(
    "insert into users (id, email, name, role, created_at, status, session_epoch) values (?, ?, ?, 'owner', ?, 'active', ?)",
  )
    .bind(
      subject.id,
      subject.email,
      "foreign subject",
      Date.now(),
      subject.epoch,
    )
    .run();
}

const REDIRECT = "https://agent.example/cb";

/** An OAuth access token from A's own provider (consent, then /oauth/token at A). */
async function oauthAtA(a: Env, userId: string): Promise<string> {
  const api = oauthApi(a);
  const clientName = "Foreign Agent";
  const client = await api.createClient({
    redirectUris: [REDIRECT],
    tokenEndpointAuthMethod: "none",
    clientName,
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
  });
  const verifier = secret();
  const challenge = b64urlEncode(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    ),
  );
  const resource = mcpResource(a);
  const { redirectTo } = await api.completeAuthorization({
    request: {
      responseType: "code",
      clientId: client.clientId,
      redirectUri: REDIRECT,
      scope: [],
      state: "foreign",
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
      resource,
    },
    userId,
    metadata: { clientName },
    scope: [],
    props: { userId, clientName, issuedAt: Date.now() },
  });
  const code = new URL(redirectTo).searchParams.get("code") ?? "";
  const r = await fetchAndWait(
    worker as never,
    new Request(`https://${a.APP_HOST}/oauth/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "cf-connecting-ip": "2001:db8:a::1",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT,
        client_id: client.clientId,
        code_verifier: verifier,
        resource,
      }).toString(),
    }),
    a,
  );
  if (r.status !== 200)
    throw new Error(`install A's token endpoint: ${r.status}`);
  return ((await r.json()) as { access_token: string }).access_token;
}

/** The foreign callers' credentials, each issued by A for `subject`. */
export async function foreignCreds(
  a: Env,
  subject: { id: string; email: string; epoch: number },
): Promise<Record<ForeignCaller, Cred>> {
  const cookie = `${sessionCookieName(a)}=${await signSession(
    a,
    subject.id,
    Date.now(),
    { provider: "access", epoch: subject.epoch },
  )}`;
  const { email } = subject;
  // The token callers send even the cookie write probes, by bearer (a PAT
  // or grant also reaches those routes): every one must refuse.
  return {
    foreignSession: { cookie, email },
    foreignPat: {
      token: (await createPat(a, subject.id, "mx-foreign")).token,
      email,
      bearerWrites: true,
    },
    foreignOAuth: {
      token: await oauthAtA(a, subject.id),
      email,
      bearerWrites: true,
    },
  };
}

/** A /c/ content URL path for `id` v1, signed by `e`'s CONTENT_SIGNING_KEY. */
export async function contentPath(
  e: Env,
  id: string,
  mode: "frame" | "dl",
  viewer: ContentViewer | null,
): Promise<string> {
  const { prefix } = await signContent(
    e,
    id,
    1,
    Date.now(),
    undefined,
    mode,
    viewer,
  );
  return `${prefix}index.html${mode === "dl" ? "?dl=1" : ""}`;
}

/** An upload URL's query for `uploadId`, signed by `e`'s own upload signer. */
export async function uploadQuery(e: Env, uploadId: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + LIMITS.uploadUrlTtlSec;
  return `exp=${exp}&sig=${await signUpload(e, uploadId, exp)}`;
}
