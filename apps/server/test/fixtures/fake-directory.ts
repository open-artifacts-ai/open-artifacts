import {
  GOOGLE_DIRECTORY_SCOPES,
  GOOGLE_REVOKE_URL,
  GOOGLE_TOKEN_URL,
} from "@oa/auth-core";
import { vi } from "vitest";
import { ADMIN_API } from "../../src/directory/google.js";
import { b64urlEncode } from "../../src/util/crypto.js";

// A fake Google for directory connect (P3 T12) behind a global fetch spy: the
// token endpoint (authorization_code with PKCE, single-use codes;
// refresh_token) and the Admin SDK users.get, domains.list and users.list.
// ID tokens are unsigned: the install reads claims from the token response
// itself (directory/transport.ts idClaims).

export type FakeDirUser = {
  id: string;
  primaryEmail: string;
  suspended?: boolean;
  isAdmin?: boolean;
  customerId?: string;
};

type Code = {
  challenge: string;
  sub: string;
  hd: string | undefined;
  scope: string;
  aud: string;
};

const enc = new TextEncoder();
const jwt = (claims: Record<string, unknown>) =>
  [
    b64urlEncode(enc.encode(JSON.stringify({ alg: "none" }))),
    b64urlEncode(enc.encode(JSON.stringify(claims))),
    "sig",
  ].join(".");

export const ALL_SCOPES = GOOGLE_DIRECTORY_SCOPES.map((s) =>
  // Google reports `email` under its long name.
  s === "email" ? "https://www.googleapis.com/auth/userinfo.email" : s,
).join(" ");

const routes = new Map<string, (req: Request) => Promise<Response>>();
/** Requests to `origin` go to `handler` (an in-process Worker) under every fake. */
export const routeOrigin = (
  origin: string,
  handler: (req: Request) => Promise<Response>,
) => routes.set(origin, handler);

export function fakeDirectory(o: { customerId?: string } = {}) {
  const customerId = o.customerId ?? "C0123";
  const users = new Map<string, FakeDirUser>();
  const domains = new Map<string, { domainName: string; verified: boolean }[]>([
    [customerId, [{ domainName: "a.com", verified: true }]],
  ]);
  const codes = new Map<string, Code>();
  const tokenCalls: URLSearchParams[] = [];
  const adminCalls: string[] = [];
  let pageSize = 500;
  let refreshStatus = 200;
  let revokeStatus = 200;
  /** Raw refresh tokens Google was asked to revoke. */
  const revoked: string[] = [];
  const realFetch = globalThis.fetch;

  const spy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const req = new Request(input, init);
      const routed = routes.get(new URL(req.url).origin);
      if (routed) return routed(req);
      if (req.url === GOOGLE_REVOKE_URL && req.method === "POST") {
        if (revokeStatus !== 200)
          return Response.json(
            { error: "server_error" },
            { status: revokeStatus },
          );
        revoked.push(new URLSearchParams(await req.text()).get("token") ?? "");
        return new Response(null, { status: 200 });
      }
      if (req.url === GOOGLE_TOKEN_URL && req.method === "POST") {
        const body = new URLSearchParams(await req.text());
        tokenCalls.push(body);
        if (body.get("grant_type") === "refresh_token") {
          if (refreshStatus !== 200)
            return Response.json(
              { error: "invalid_grant" },
              { status: refreshStatus },
            );
          return Response.json({
            access_token: "at-refreshed",
            expires_in: 3599,
          });
        }
        const code = body.get("code") ?? "";
        const c = codes.get(code);
        codes.delete(code);
        const d = await crypto.subtle.digest(
          "SHA-256",
          enc.encode(body.get("code_verifier") ?? ""),
        );
        if (!c || b64urlEncode(new Uint8Array(d)) !== c.challenge)
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        const now = Math.floor(Date.now() / 1000);
        return Response.json({
          access_token: `at-${c.sub}`,
          refresh_token: `rt-${c.sub}`,
          scope: c.scope,
          token_type: "Bearer",
          id_token: jwt({
            iss: "https://accounts.google.com",
            aud: c.aud,
            sub: c.sub,
            iat: now,
            exp: now + 3600,
            ...(c.hd ? { hd: c.hd } : {}),
          }),
        });
      }
      if (req.url.startsWith(ADMIN_API)) {
        const u = new URL(req.url);
        const path = u.pathname.replace("/admin/directory/v1", "");
        adminCalls.push(path);
        const dm = /^\/customer\/([^/]+)\/domains$/.exec(path);
        if (dm)
          return Response.json({
            domains: domains.get(decodeURIComponent(dm[1] as string)) ?? [],
          });
        const um = /^\/users\/([^/]+)$/.exec(path);
        if (um) {
          const x = users.get(decodeURIComponent(um[1] as string));
          return x
            ? Response.json({ customerId, ...x })
            : Response.json({ error: { code: 404 } }, { status: 404 });
        }
        if (path === "/users") {
          const all = [...users.values()].filter(
            (x) =>
              (x.customerId ?? customerId) === u.searchParams.get("customer"),
          );
          const from = Number(u.searchParams.get("pageToken") ?? "0");
          const page = all.slice(from, from + pageSize);
          const next =
            from + pageSize < all.length ? String(from + pageSize) : undefined;
          return Response.json({
            users: page.map((x) => ({ customerId, ...x })),
            ...(next ? { nextPageToken: next } : {}),
          });
        }
        return Response.json({}, { status: 404 });
      }
      return realFetch(input, init);
    });

  return {
    customerId,
    users,
    domains,
    tokenCalls,
    adminCalls,
    addUser(u: FakeDirUser) {
      users.set(u.id, u);
      return u;
    },
    /** Registers a code that exchanges (with the matching verifier) to this grant. */
    issueCode(
      challenge: string,
      g: { sub: string; hd?: string | null; scope?: string; aud: string },
    ): string {
      const code = `code-${crypto.randomUUID()}`;
      codes.set(code, {
        challenge,
        sub: g.sub,
        hd: g.hd === null ? undefined : (g.hd ?? "a.com"),
        scope: g.scope ?? ALL_SCOPES,
        aud: g.aud,
      });
      return code;
    },
    setPageSize(n: number) {
      pageSize = n;
    },
    setRefreshStatus(s: number) {
      refreshStatus = s;
    },
    revoked,
    setRevokeStatus(s: number) {
      revokeStatus = s;
    },
    restore: () => spy.mockRestore(),
  };
}
export type FakeDirectory = ReturnType<typeof fakeDirectory>;
