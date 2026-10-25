import {
  GOOGLE_DIRECTORY_SCOPES,
  GOOGLE_REVOKE_URL,
  GOOGLE_TOKEN_URL,
} from "@oa/auth-core";
import { vi } from "vitest";
import { ADMIN_API, REPORTS_API } from "../../src/directory/google.js";
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
  /** Listed only with showDeleted (users.get answers 404). */
  deleted?: boolean;
  isAdmin?: boolean;
  customerId?: string;
  /** Other addresses of this user (a former primary stays as an alias). */
  aliases?: string[];
};

export type FakeGroup = {
  id: string;
  email: string;
  name: string;
  /** Direct member ids: users, or groups (type GROUP). */
  members: string[];
};
type FakeActivity = {
  name: string;
  params: Record<string, string>;
  at: number;
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
  /** Groups by id; members are direct (USER or GROUP). */
  const groups = new Map<string, FakeGroup>();
  const groupBy = (key: string) =>
    groups.get(key) ??
    [...groups.values()].find((g) => g.email === key.toLowerCase());
  /** Reports events per application ("admin", "groups"). */
  const activityLog = new Map<string, FakeActivity[]>();
  /** Injected failures: the first matching rule answers, `times` times. */
  const failures: {
    match: RegExp;
    status: number;
    reason?: string;
    times: number;
  }[] = [];
  const gates: {
    match: RegExp;
    used: boolean;
    arrive: () => void;
    wait: Promise<void>;
  }[] = [];
  const failure = (key: string): Response | null => {
    const f = failures.find((x) => x.times > 0 && x.match.test(key));
    if (!f) return null;
    f.times--;
    return Response.json(
      {
        error: {
          code: f.status,
          ...(f.reason ? { errors: [{ reason: f.reason }] } : {}),
        },
      },
      { status: f.status },
    );
  };
  const member = (id: string) =>
    groups.has(id)
      ? { id, type: "GROUP", email: groups.get(id)?.email }
      : { id, type: "USER", email: users.get(id)?.primaryEmail };
  let memberPageSize = 200;
  /** The active listing (isSuspended=false) answers empty: a Google glitch. */
  let emptyActive = false;
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
      // A gated request waits until the test releases it (interleaves).
      const gu = new URL(req.url);
      const gkey = `${gu.pathname.replace("/admin/directory/v1", "")}?${gu.searchParams}`;
      const gate = gates.find((x) => !x.used && x.match.test(gkey));
      if (gate) {
        gate.used = true;
        gate.arrive();
        await gate.wait;
      }
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
      if (req.url.startsWith(REPORTS_API)) {
        const u = new URL(req.url);
        const app = /\/applications\/([^/]+)$/.exec(u.pathname)?.[1] ?? "";
        adminCalls.push(`/reports/${app}`);
        const f = failure(`/reports/${app}`);
        if (f) return f;
        const since = Date.parse(u.searchParams.get("startTime") ?? "");
        const items = (activityLog.get(app) ?? [])
          .filter((a) => !(a.at < since))
          .map((a) => ({
            id: { time: new Date(a.at).toISOString() },
            events: [
              {
                name: a.name,
                parameters: Object.entries(a.params).map(([name, value]) => ({
                  name,
                  value,
                })),
              },
            ],
          }));
        return Response.json({ items });
      }
      if (req.url.startsWith(ADMIN_API)) {
        const u = new URL(req.url);
        const path = u.pathname.replace("/admin/directory/v1", "");
        adminCalls.push(path);
        const f = failure(`${path}?${u.searchParams}`);
        if (f) return f;
        const hm = /^\/groups\/([^/]+)\/hasMember\/([^/]+)$/.exec(path);
        if (hm) {
          const g = groupBy(decodeURIComponent(hm[1] as string));
          if (!g)
            return Response.json({ error: { code: 404 } }, { status: 404 });
          const who = decodeURIComponent(hm[2] as string);
          // Nested membership counts (as Google's hasMember).
          const seen = new Set<string>();
          const has = (x: FakeGroup): boolean =>
            x.members.some((m) => {
              if (m === who) return true;
              const c = groups.get(m);
              if (!c || seen.has(c.id)) return false;
              seen.add(c.id);
              return has(c);
            });
          return Response.json({ isMember: has(g) });
        }
        const gm = /^\/groups\/([^/]+)\/members$/.exec(path);
        if (gm) {
          const g = groupBy(decodeURIComponent(gm[1] as string));
          if (!g)
            return Response.json({ error: { code: 404 } }, { status: 404 });
          const from = Number(u.searchParams.get("pageToken") ?? "0");
          const page = g.members.slice(from, from + memberPageSize);
          const next =
            from + memberPageSize < g.members.length
              ? String(from + memberPageSize)
              : undefined;
          return Response.json({
            members: page.map(member),
            ...(next ? { nextPageToken: next } : {}),
          });
        }
        const gg = /^\/groups\/([^/]+)$/.exec(path);
        if (gg) {
          const g = groupBy(decodeURIComponent(gg[1] as string));
          return g
            ? Response.json({
                id: g.id,
                email: g.email,
                name: g.name,
                directMembersCount: String(g.members.length),
              })
            : Response.json({ error: { code: 404 } }, { status: 404 });
        }
        if (path === "/groups") {
          const key = u.searchParams.get("userKey");
          const q = u.searchParams.get("query") ?? "";
          const all = [...groups.values()].filter((g) =>
            key
              ? g.members.some(
                  (m) =>
                    m === key ||
                    users.get(m)?.primaryEmail.toLowerCase() ===
                      key.toLowerCase(),
                )
              : !q ||
                `${g.email} ${g.name}`.toLowerCase().includes(
                  q
                    .replace(/^(email|name):/, "")
                    .replace(/\*$/, "")
                    .toLowerCase(),
                ),
          );
          return Response.json({
            groups: all.map((g) => ({
              id: g.id,
              email: g.email,
              name: g.name,
              directMembersCount: String(g.members.length),
            })),
          });
        }
        const dm = /^\/customer\/([^/]+)\/domains$/.exec(path);
        if (dm)
          return Response.json({
            domains: domains.get(decodeURIComponent(dm[1] as string)) ?? [],
          });
        const um = /^\/users\/([^/]+)$/.exec(path);
        if (um) {
          const k = decodeURIComponent(um[1] as string).toLowerCase();
          const x =
            users.get(decodeURIComponent(um[1] as string)) ??
            [...users.values()].find((v) => v.primaryEmail.toLowerCase() === k);
          return x && !x.deleted
            ? Response.json({ customerId, ...x })
            : Response.json({ error: { code: 404 } }, { status: 404 });
        }
        if (path === "/users") {
          const deleted = u.searchParams.get("showDeleted") === "true";
          const q = u.searchParams.get("query");
          const all = [...users.values()].filter(
            (x) =>
              !(emptyActive && q === "isSuspended=false") &&
              (x.customerId || customerId) === u.searchParams.get("customer") &&
              !!x.deleted === deleted &&
              (q !== "isSuspended=true" || x.suspended === true) &&
              (q !== "isSuspended=false" || x.suspended !== true),
          );
          const from = Number(u.searchParams.get("pageToken") ?? "0");
          const page = all.slice(from, from + pageSize);
          const next =
            from + pageSize < all.length ? String(from + pageSize) : undefined;
          return Response.json({
            users: page.map(({ deleted: _d, ...x }) => ({ customerId, ...x })),
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
    groups,
    /** Adds (or replaces) a group; `members` are user or group ids. */
    addGroup(g: {
      id: string;
      email: string;
      name?: string;
      members?: string[];
    }) {
      groups.set(g.id, {
        id: g.id,
        email: g.email.toLowerCase(),
        name: g.name ?? g.email,
        members: [...(g.members ?? [])],
      });
      return groups.get(g.id) as FakeGroup;
    },
    addMember(groupId: string, id: string) {
      const g = groups.get(groupId);
      if (g && !g.members.includes(id)) g.members.push(id);
    },
    removeMember(groupId: string, id: string) {
      const g = groups.get(groupId);
      if (g) g.members = g.members.filter((m) => m !== id);
    },
    deleteGroup(groupId: string) {
      groups.delete(groupId);
    },
    /** Records a Reports event (time defaults to now). */
    activity(
      app: "admin" | "groups",
      name: string,
      params: Record<string, string>,
      at = Date.now(),
    ) {
      const l = activityLog.get(app) ?? [];
      l.push({ name, params, at });
      activityLog.set(app, l);
    },
    /** The next `times` requests whose key matches answer `status`. */
    fail(
      match: RegExp,
      status: number,
      o: { times?: number; reason?: string } = {},
    ) {
      failures.push({ match, status, reason: o.reason, times: o.times ?? 1 });
    },
    /**
     * The next request whose path?query matches waits: `hit` resolves when it
     * arrives, `release()` lets it through.
     */
    gate(match: RegExp) {
      let arrive = () => {};
      let release = () => {};
      const hit = new Promise<void>((r) => {
        arrive = r;
      });
      const wait = new Promise<void>((r) => {
        release = r;
      });
      gates.push({ match, used: false, arrive, wait });
      return { hit, release };
    },
    clearFailures() {
      failures.length = 0;
    },
    setEmptyActive(b: boolean) {
      emptyActive = b;
    },
    setMemberPageSize(n: number) {
      memberPageSize = n;
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
