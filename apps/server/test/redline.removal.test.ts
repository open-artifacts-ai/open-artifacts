// Parity 1 red-line (in-server: the cross-install suite's installs have no
// Access and no domain join). Each case first proves the path admits someone
// who isn't removed, so a server that refuses everything can't pass.
// - A removed person is refused on every sign-in path (Access, a guest code,
//   a domain code, Google with join=member) while shares to their address
//   remain, with spaces off and on.
// - A restored member's old PAT and OAuth grant stay refused (even when the
//   KV grant revocation missed the grant).
// - Directory sync revives only the same directory id: a revived member's
//   old PAT and grant stay refused; a new account reusing the address gets
//   a fresh row and nothing of the old one's.
// - Transfer all moves only that person's personal artifacts.
import { env } from "cloudflare:workers";
import { AUTH, newId, PAGES, R } from "@oa/shared";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { createPat } from "../src/auth/pat.js";
import { sessionCookieName, signSession } from "../src/auth/session.js";
import { getDb } from "../src/db/client.js";
import { applyUsers } from "../src/directory/apply.js";
import { bindPage } from "../src/directory/binding.js";
import type { GoogleUser } from "../src/directory/google.js";
import { artifacts } from "../src/db/schema.js";
import type { Env } from "../src/env.js";
import * as oauthApiModule from "../src/mcp/oauth-api.js";
import { direct, mailer, trial, uniq } from "./auth-helpers.js";
import { accessSignIn } from "./fake-access.js";
import { type FakeGoogle, fakeGoogle } from "./fixtures/fake-google.js";
import { errOf, fetchAndWait, login } from "./helpers.js";
import { callWorker, MCP_URL, oauthToken } from "./mcp-helpers.js";

const app = createApp();
const SESSION = sessionCookieName(env);
/** A passing siteverify answer (domain codes need Turnstile). */
const TURNSTILE_OK = {
  success: true,
  hostname: "app.localhost",
  action: "code_request",
};
afterEach(() => vi.restoreAllMocks());

type U = { cookie: string; userId: string };
let owner: U;
let admin: U;

beforeAll(async () => {
  owner = await login(uniq("rl-owner"), "owner");
  admin = await login(uniq("rl-admin"), "admin");
});

const call = (
  e: Env,
  path: string,
  cookie: string | null,
  init: { method?: string; body?: unknown; bearer?: string } = {},
) =>
  fetchAndWait(
    app,
    new Request(`http://app.localhost${path}`, {
      method: init.method ?? "GET",
      redirect: "manual",
      headers: {
        "x-oa-request": "1",
        "sec-fetch-site": "same-origin",
        "cf-connecting-ip": `198.51.100.${Math.floor(Math.random() * 250)}`,
        ...(cookie ? { cookie } : {}),
        ...(init.bearer ? { authorization: `Bearer ${init.bearer}` } : {}),
        ...(init.body === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
    e,
  );
const sessionOf = (r: Response) =>
  r.headers
    .getSetCookie()
    .find((s) => s.startsWith(`${SESSION}=`) && !/Max-Age=0/i.test(s));
const pendingOf = (r: Response) => {
  const c = r.headers.getSetCookie().find((s) => s.startsWith("oa_code="));
  return c?.split(";")[0];
};

/**
 * An emailed-code sign-in: the request, then (when a code was sent) the
 * verify. `sent` false: no code went out; `session`: the verify signed in.
 */
async function codeSignIn(e: Env, email: string, token?: string) {
  const m = mailer();
  const em = { ...e, ...m.env } as Env;
  const r = await call(em, AUTH.codeRequest, null, {
    method: "POST",
    body: { email, next: "/", ...(token ? { turnstileToken: token } : {}) },
  });
  expect(r.status).toBe(202);
  if (!m.sent.some((x) => x.to === email))
    return { sent: false, session: false };
  const v = await call(em, AUTH.codeVerify, pendingOf(r) ?? null, {
    method: "POST",
    body: { code: m.codeFor(email) },
  });
  return { sent: true, session: v.status === 200 && !!sessionOf(v) };
}

/** A full Google sign-in (direct transport, the fake Google). */
async function googleSignIn(g: FakeGoogle, e: Env, email: string) {
  const start = await call(e, `${AUTH.loginGoogle}?next=/a/x`, null);
  expect(start.status).toBe(302);
  const u = new URL(start.headers.get("location") ?? "");
  const state =
    start.headers
      .getSetCookie()
      .find((c) => /oa_oidc_/.test(c))
      ?.split(";")[0] ?? "";
  const code = g.issueCode(
    { nonce: u.searchParams.get("nonce"), email, sub: `sub-${email}` },
    u.searchParams.get("code_challenge") as string,
  );
  const r = await call(
    e,
    `${AUTH.callbackGoogle}?state=${u.searchParams.get("state")}&code=${code}`,
    state,
  );
  return { admitted: r.headers.get("location") === "/a/x" && !!sessionOf(r) };
}

/** Access sign-in: admitted lands on "/", refused on the no-access page. */
async function accessAdmits(email: string): Promise<boolean> {
  const r = await accessSignIn(email);
  vi.restoreAllMocks();
  const to = r.headers.get("location");
  if (to === "/") return true;
  expect(to).toBe(PAGES.noAccess);
  return false;
}

const idOf = async (email: string) =>
  (
    await env.DB.prepare("select id from users where email = ?")
      .bind(email)
      .first<{ id: string }>()
  )?.id ?? "";

/** An artifact `owner` owns in `space`, live or trashed. */
async function art(ownerId: string, spaceId: string, deleted = false) {
  const id = newId();
  const now = Date.now();
  await getDb(env)
    .insert(artifacts)
    .values({
      id,
      ownerId,
      spaceId,
      title: "rl",
      format: "html",
      createdAt: now,
      updatedAt: now,
      deletedAt: deleted ? now : null,
    });
  return id;
}

/** A share of a fresh artifact of the owner's to `email`. */
async function shareTo(email: string) {
  const id = await art(owner.userId, owner.userId);
  const r = await call(env as Env, R.shares(id), owner.cookie, {
    method: "PUT",
    body: { email, role: "viewer" },
  });
  expect(r.status).toBe(200);
}

describe.each([
  ["spaces off", {}],
  ["spaces on", { FEATURES: "spaces" }],
] as const)(
  "red-line: a removed person is refused on every sign-in path (%s)",
  (_, over) => {
    const E = { ...(env as object), ...over } as Env;
    const removeVia = async (email: string) => {
      const r = await call(E, R.member(await idOf(email)), admin.cookie, {
        method: "DELETE",
      });
      expect(r.status).toBe(204);
    };

    it("Google with join=member: admits a domain address, refuses it once removed (a share remaining)", async () => {
      const g = await fakeGoogle();
      const e = direct(over);
      const email = uniq("rl-google", "a.com");
      expect((await googleSignIn(g, e, email)).admitted).toBe(true);
      await shareTo(email);
      await removeVia(email);
      expect((await googleSignIn(g, e, email)).admitted).toBe(false);
      expect(
        await env.DB.prepare("select status from users where email = ?")
          .bind(email)
          .first(),
      ).toEqual({ status: "removed" });
    });

    it("domain code: admits a domain address, refuses it once removed (a share remaining)", async () => {
      vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
        Response.json(TURNSTILE_OK),
      );
      const e = trial(over);
      const email = uniq("rl-dcode", "a.com");
      expect(await codeSignIn(e, email, "ok")).toEqual({
        sent: true,
        session: true,
      });
      await shareTo(email);
      await removeVia(email);
      expect((await codeSignIn(e, email, "ok")).sent).toBe(false);
    });

    it("guest code and Access: admit a shared guest, refuse them once removed (shares remaining)", async () => {
      const e = direct(over);
      const email = uniq("rl-guest", "x.com");
      await shareTo(email);
      expect(await codeSignIn(e, email)).toEqual({ sent: true, session: true });
      expect(await accessAdmits(email)).toBe(true);
      await removeVia(email);
      await shareTo(email);
      expect((await codeSignIn(e, email)).sent).toBe(false);
      expect(await accessAdmits(email)).toBe(false);
    });

    it("Access: a removed member with a share to their address gets no access and no new row", async () => {
      const email = uniq("rl-access", "x.com");
      const m = await login(email, "member");
      await shareTo(email);
      await removeVia(email);
      expect(await accessAdmits(email)).toBe(false);
      expect(await idOf(email)).toBe(m.userId);
      const n = await env.DB.prepare(
        "select count(*) as n from users where email = ?",
      )
        .bind(email)
        .first<{ n: number }>();
      expect(n?.n).toBe(1);
    });
  },
);

describe("red-line: a restored member's old credentials stay refused", () => {
  const listTools = (token: string) =>
    callWorker(
      new Request(MCP_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );

  it("PAT and OAuth grant from before the removal: refused after restore (KV revocation missed too); fresh ones work", async () => {
    const email = uniq("rl-restore", "a.com");
    const m = await login(email, "member");
    const { token: pat } = await createPat(env, m.userId, "old");
    const { accessToken } = await oauthToken(email, "Old Agent", m);
    expect((await call(env as Env, R.me, null, { bearer: pat })).status).toBe(
      200,
    );
    expect((await listTools(accessToken)).status).toBe(200);
    // The KV grant revocation misses: only D1 (status_changed_at) refuses it.
    vi.spyOn(oauthApiModule, "revokeAllGrants").mockResolvedValue(undefined);
    expect(
      (
        await call(env as Env, R.member(m.userId), admin.cookie, {
          method: "DELETE",
        })
      ).status,
    ).toBe(204);
    expect((await listTools(accessToken)).status).toBe(401);
    const r = await call(env as Env, R.memberRestore(m.userId), admin.cookie, {
      method: "POST",
    });
    expect(r.status).toBe(200);
    vi.restoreAllMocks();
    expect((await call(env as Env, R.me, null, { bearer: pat })).status).toBe(
      401,
    );
    expect((await listTools(accessToken)).status).toBe(401);
    // The old session too.
    expect((await call(env as Env, R.me, m.cookie)).status).toBe(401);
    // Signed in again (the current epoch), a new PAT and grant work.
    const e = (
      await env.DB.prepare("select session_epoch e from users where id = ?")
        .bind(m.userId)
        .first<{ e: number }>()
    )?.e;
    const cookie = `${SESSION}=${await signSession(env, m.userId, Date.now(), {
      provider: "access",
      epoch: e ?? -1,
    })}`;
    expect((await call(env as Env, R.me, cookie)).status).toBe(200);
    const { token: fresh } = await createPat(env, m.userId, "new");
    expect((await call(env as Env, R.me, null, { bearer: fresh })).status).toBe(
      200,
    );
    const again = await oauthToken(email, "New Agent", {
      cookie,
      userId: m.userId,
    });
    expect((await listTools(again.accessToken)).status).toBe(200);
  });
});

describe("red-line: transfer all moves only that person's personal artifacts (spaces off)", () => {
  it("their personal live and trashed artifacts move to the admin; their shared-space work and others' stay", async () => {
    const OFF = env as Env;
    const x = await login(uniq("rl-x", "a.com"), "member");
    const y = await login(uniq("rl-y", "a.com"), "member");
    const space = newId();
    await env.DB.prepare(
      "insert into spaces (id, kind, name, public_links, created_at) values (?, 'shared', ?, 1, 1)",
    )
      .bind(space, `rl ${space}`)
      .run();
    const mine = [await art(x.userId, x.userId), await art(x.userId, x.userId)];
    const trashed = await art(x.userId, x.userId, true);
    const inSpace = await art(x.userId, space);
    const ys = await art(y.userId, y.userId);
    expect(
      (
        await call(OFF, R.memberTransfer(x.userId), admin.cookie, {
          method: "POST",
          body: { to: { kind: "user", userId: admin.userId } },
        })
      ).status,
    ).toBe(409);
    expect(
      (await call(OFF, R.member(x.userId), admin.cookie, { method: "DELETE" }))
        .status,
    ).toBe(204);
    // Removal moved nothing: they wait for the transfer.
    const placed = async (id: string) =>
      env.DB.prepare(
        "select owner_id o, space_id s from artifacts where id = ?",
      )
        .bind(id)
        .first<{ o: string; s: string }>();
    expect(await placed(mine[0] ?? "")).toEqual({ o: x.userId, s: x.userId });
    expect(
      await (await call(OFF, R.memberTransfer(x.userId), admin.cookie)).json(),
    ).toEqual({ live: 2, deleted: 1 });
    let cursor: string | undefined;
    let calls = 0;
    do {
      const r = await call(OFF, R.memberTransfer(x.userId), admin.cookie, {
        method: "POST",
        body: {
          to: { kind: "user", userId: admin.userId },
          ...(cursor ? { cursor } : {}),
        },
      });
      expect(r.status, JSON.stringify(await r.clone().json())).toBe(200);
      cursor =
        ((await r.json()) as { nextCursor: string | null }).nextCursor ??
        undefined;
      calls++;
    } while (cursor && calls < 5);
    expect(cursor).toBeUndefined();
    for (const id of [...mine, trashed])
      expect(await placed(id)).toEqual({ o: admin.userId, s: admin.userId });
    expect(await placed(inSpace)).toEqual({ o: x.userId, s: space });
    expect(await placed(ys)).toEqual({ o: y.userId, s: y.userId });
    expect(
      await (await call(OFF, R.memberTransfer(x.userId), admin.cookie)).json(),
    ).toEqual({ live: 0, deleted: 0 });
    // A guest or a removed person is never a target.
    const r = await call(OFF, R.memberTransfer(y.userId), admin.cookie, {
      method: "POST",
      body: { to: { kind: "user", userId: x.userId } },
    });
    expect(r.status).toBe(409);
    expect((await errOf(r)).code).toBe("member_active");
  });
});

describe("red-line: directory sync revive (parity 1 round 2)", () => {
  /** Directory sync's listing of one page (bindPage, then applyUsers). */
  const D = direct();
  const gu = (
    id: string,
    primaryEmail: string,
    o: Partial<GoogleUser> = {},
  ): GoogleUser => ({
    id,
    primaryEmail,
    suspended: false,
    deleted: false,
    isAdmin: false,
    customerId: "C0123",
    ...o,
  });
  const list = async (u: GoogleUser) => {
    if (!u.deleted)
      await bindPage(D, [u], { tenant: "a.com", allowEmail: false });
    await applyUsers(D, [u], { tenant: "a.com" });
  };
  const link = (sub: string, uid: string) =>
    env.DB.prepare(
      "insert into identities (provider, subject, tenant, user_id, created_at, directory_bound) values ('google', ?, 'a.com', ?, ?, 1)",
    )
      .bind(sub, uid, Date.now())
      .run();
  /** A session at the row's current epoch (a fresh sign-in). */
  const freshCookie = async (uid: string) => {
    const e = (
      await env.DB.prepare("select session_epoch e from users where id = ?")
        .bind(uid)
        .first<{ e: number }>()
    )?.e;
    return `${SESSION}=${await signSession(env, uid, Date.now(), {
      provider: "access",
      epoch: e ?? -1,
    })}`;
  };
  const listTools = (token: string) =>
    callWorker(
      new Request(MCP_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );

  it("a revived member's PAT and OAuth grant from before the directory removal stay refused (KV revocation missed too); a fresh sign-in works", async () => {
    const email = uniq("rl-revive", "a.com");
    const sub = `g-rl-rv-${crypto.randomUUID()}`;
    const m = await login(email, "member");
    await link(sub, m.userId);
    const { token: pat } = await createPat(env, m.userId, "old");
    const { accessToken } = await oauthToken(email, "Old Agent", m);
    expect((await call(env as Env, R.me, null, { bearer: pat })).status).toBe(
      200,
    );
    expect((await listTools(accessToken)).status).toBe(200);
    vi.spyOn(oauthApiModule, "revokeAllGrants").mockResolvedValue(undefined);
    await list(gu(sub, email, { deleted: true }));
    expect((await listTools(accessToken)).status).toBe(401);
    vi.restoreAllMocks();
    await list(gu(sub, email));
    const now = await env.DB.prepare(
      "select status, email from users where id = ?",
    )
      .bind(m.userId)
      .first<{ status: string; email: string }>();
    expect(now).toEqual({ status: "active", email });
    expect((await call(env as Env, R.me, null, { bearer: pat })).status).toBe(
      401,
    );
    expect((await listTools(accessToken)).status).toBe(401);
    expect((await call(env as Env, R.me, m.cookie)).status).toBe(401);
    // The path admits: a fresh sign-in and a new PAT work.
    const cookie = await freshCookie(m.userId);
    expect((await call(env as Env, R.me, cookie)).status).toBe(200);
    const { token: fresh } = await createPat(env, m.userId, "new");
    expect((await call(env as Env, R.me, null, { bearer: fresh })).status).toBe(
      200,
    );
  });

  it("a new Workspace account reusing a removed member's address gets a fresh row: none of the old row's artifacts, shares or credentials", async () => {
    const email = uniq("rl-reuse", "a.com");
    const [oldSub, newSub] = [
      `g-rl-old-${crypto.randomUUID()}`,
      `g-rl-new-${crypto.randomUUID()}`,
    ];
    const old = await login(email, "member");
    await link(oldSub, old.userId);
    const mine = await art(old.userId, old.userId);
    const { token: pat } = await createPat(env, old.userId, "old");
    await shareTo(email);
    expect((await call(env as Env, R.artifact(mine), old.cookie)).status).toBe(
      200,
    );
    await list(gu(oldSub, email, { deleted: true }));
    await list(gu(newSub, email));
    const fresh = await idOf(email);
    expect(fresh).not.toBe("");
    expect(fresh).not.toBe(old.userId);
    // The old row stays removed under its placeholder.
    expect(
      await env.DB.prepare(
        "select status, email, removed_by_sync bySync from users where id = ?",
      )
        .bind(old.userId)
        .first(),
    ).toEqual({
      status: "removed",
      email: `removed+${old.userId}@invalid`,
      bySync: 1,
    });
    // The fresh row is admitted (the path works) as itself, and gets
    // nothing of the old row's.
    const cookie = await freshCookie(fresh);
    const me = await call(env as Env, R.me, cookie);
    expect(me.status).toBe(200);
    expect(((await me.json()) as { user: { id: string } }).user.id).toBe(fresh);
    expect((await call(env as Env, R.artifact(mine), cookie)).status).toBe(404);
    expect(
      await env.DB.prepare("select count(*) n from shares where email = ?")
        .bind(email)
        .first(),
    ).toEqual({ n: 0 });
    expect((await call(env as Env, R.me, null, { bearer: pat })).status).toBe(
      401,
    );
    // The old id listed active again never takes the row or the address.
    await list(gu(oldSub, email));
    expect(await idOf(email)).toBe(fresh);
    expect(
      (
        await env.DB.prepare("select status from users where id = ?")
          .bind(old.userId)
          .first<{ status: string }>()
      )?.status,
    ).toBe("removed");
  });
});
