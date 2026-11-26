// Red-line ports (OA Platform L, the red-line split): install A's OAuth
// client, refresh token and unused grant code, each tried at install B. They
// replace the live credentials.test.ts cases "One install's OAuth app id at
// another's approval page gets no automatic grant", "One install's OAuth
// refresh token gets no new token at another" and "One install's unused OAuth
// grant code gets no token at another". Install A is foreign.ts's: its own
// D1, OAuth store and secrets, the same Worker code. B is the pool's install.
import { env } from "cloudflare:workers";
import { newId } from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { sessionCookieName, signSession } from "../../src/auth/session.js";
import type { Env } from "../../src/env.js";
import worker from "../../src/index.js";
import { mcpResource } from "../../src/mcp/server.js";
import { fetchAndWait, login } from "../helpers.js";
import { pkce, register } from "../mcp-helpers.js";
import {
  codeExchange,
  type GrantAtA,
  grantAtA,
  installA,
  REDIRECT,
  seedSubjectAtA,
  tokenAt,
} from "./foreign.ts";

const B = env as unknown as Env;
const tag = newId().slice(0, 6).toLowerCase();
let a: Env;
/** A's own member: the user every A grant below is for. */
const userA = { id: newId(), email: `oauth-a-${tag}@x.com`, epoch: 0 };
let cookieA = "";
let cookieB = "";

beforeAll(async () => {
  a = await installA(B);
  await seedSubjectAtA(a, userA);
  cookieA = `${sessionCookieName(a)}=${await signSession(a, userA.id, Date.now(), { provider: "access", epoch: userA.epoch })}`;
  cookieB = (await login(`oauth-b-${tag}@x.com`)).cookie;
});

/** GET `e`'s /oauth/authorize for `clientId` as the session `cookie`. */
async function authorize(e: Env, clientId: string, cookie: string) {
  const { challenge } = await pkce();
  const url = `https://${e.APP_HOST}/oauth/authorize?${new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "st4te",
    resource: mcpResource(e),
  })}`;
  const r = await fetchAndWait(
    worker as never,
    new Request(url, { headers: { cookie } }),
    e,
  );
  return { r, body: await r.text() };
}

const CONSENT_FORM = /name="csrf" value="[^"]+"/;

/** A refusal at the token endpoint: no token, an OAuth client or grant error. */
async function refused(r: Response) {
  expect(r.status).toBeGreaterThanOrEqual(400);
  expect(r.status).toBeLessThan(500);
  const body = (await r.json()) as { error?: string; access_token?: string };
  expect(body.access_token).toBeUndefined();
  expect(["invalid_grant", "invalid_client"]).toContain(body.error);
}

describe("install A's OAuth client at install B's approval page", () => {
  it("A's client id gets no consent screen and no grant code at B; at A it gets consent", async () => {
    const { clientId } = await grantAtA(a, userA.id);
    // Control: the client is real, and A shows its consent screen.
    const atA = await authorize(a, clientId, cookieA);
    expect(atA.r.status).toBe(200);
    expect(atA.body).toMatch(CONSENT_FORM);
    // At B the id is unknown: no consent form, no redirect carrying a code.
    for (const id of [clientId, `${clientId}x`, newId()]) {
      const atB = await authorize(B, id, cookieB);
      expect(atB.r.status, id).toBeGreaterThanOrEqual(400);
      expect(atB.r.status, id).toBeLessThan(500);
      expect(atB.body).not.toMatch(CONSENT_FORM);
      expect(atB.r.headers.get("location") ?? "").not.toContain("code=");
    }
  });
});

describe("install A's OAuth grants at install B's token endpoint", () => {
  let clientB = "";
  beforeAll(async () => {
    clientB = await register("Install B Agent");
  });

  it("A's refresh token is refused at B with either client id, and still works at A", async () => {
    const g = await grantAtA(a, userA.id);
    const first = await tokenAt(a, codeExchange(g));
    expect(first.status).toBe(200);
    const { refresh_token } = (await first.json()) as {
      refresh_token: string;
    };
    expect(refresh_token).toBeTruthy();
    const refresh = (clientId: string) => ({
      grant_type: "refresh_token",
      refresh_token,
      client_id: clientId,
      resource: g.resource,
    });
    for (const clientId of [g.clientId, clientB])
      await refused(await tokenAt(B, refresh(clientId)));
    const atA = await tokenAt(a, refresh(g.clientId));
    expect(atA.status).toBe(200);
    expect(
      ((await atA.json()) as { access_token?: string }).access_token,
    ).toBeTruthy();
  });

  it("A's unused grant code is refused at B with either client id, and A can still redeem it", async () => {
    const g: GrantAtA = await grantAtA(a, userA.id);
    for (const clientId of [g.clientId, clientB])
      await refused(await tokenAt(B, codeExchange(g, clientId)));
    const atA = await tokenAt(a, codeExchange(g));
    expect(atA.status).toBe(200);
    expect(
      ((await atA.json()) as { access_token?: string }).access_token,
    ).toBeTruthy();
  });
});
