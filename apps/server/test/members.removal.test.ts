// Review item 7: a removed member or guest stays removed. Without spaces the
// removal drops the shares addressed to their email in the same batch, so no
// leftover share re-admits the address at the next code or Access sign-in; a
// share made after the removal is a fresh grant. With spaces the removed row
// refuses every sign-in and keeps its shares.
import { env } from "cloudflare:workers";
import { AUTH, type Member, PAGES, R } from "@oa/shared";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { withCap } from "../src/auth/authz.js";
import { authConfig } from "../src/auth/config.js";
import type { Env } from "../src/env.js";
import { publish } from "../src/services/artifacts.js";
import { codeEligibility } from "../src/services/identity.js";
import { removeMember } from "../src/services/members.js";
import { getUser } from "../src/services/users.js";
import { direct, mailer, uniq } from "./auth-helpers.js";
import { accessSignIn } from "./fake-access.js";
import { fetchAndWait, login } from "./helpers.js";

const app = createApp();
afterEach(() => vi.restoreAllMocks());
// The spaces-off removal reassigns to the instance owner: one must exist.
beforeAll(async () => {
  await login(uniq("owner", "a.com"), "owner");
});
const SPACES = { ...(env as object), FEATURES: "spaces" } as Env;
/** A member actor as getUser loads it (uncapped). */
const actorOf = (id: string, role: Member["role"]) =>
  withCap({ id, role } as Member, null);

const call = (
  e: Env,
  path: string,
  cookie: string | null,
  init: { method?: string; body?: unknown } = {},
) =>
  fetchAndWait(
    app,
    new Request(`http://app.localhost${path}`, {
      method: init.method ?? "GET",
      headers: {
        "x-oa-request": "1",
        "sec-fetch-site": "same-origin",
        "cf-connecting-ip": `198.51.100.${Math.floor(Math.random() * 250)}`,
        ...(cookie ? { cookie } : {}),
        ...(init.body === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
    e,
  );
const cookieOf = (r: Response, name: string) => {
  const c = r.headers.getSetCookie().find((s) => s.startsWith(`${name}=`));
  return c ? `${name}=${c.slice(name.length + 1).split(";")[0]}` : undefined;
};

/** A code request; the code (when one was sent) and the pending cookie. */
async function requestCode(e: Env, email: string) {
  const m = mailer();
  const em = { ...e, ...m.env } as Env;
  const r = await call(em, AUTH.codeRequest, null, {
    method: "POST",
    body: { email, next: "/" },
  });
  expect(r.status).toBe(202);
  return {
    e: em,
    pending: cookieOf(r, "oa_code"),
    sent: m.sent.some((x) => x.to === email),
    code: () => m.codeFor(email),
  };
}
const verifyCode = (e: Env, code: string, pending: string | undefined) =>
  call(e, AUTH.codeVerify, pending ?? null, {
    method: "POST",
    body: { code },
  });

/** A sharer (member) with one published artifact per title. */
async function sharer() {
  const l = await login(uniq("sharer", "a.com"), "member");
  const m = await getUser(env, l.userId);
  if (!m) throw new Error("no sharer");
  const pub = async () =>
    (
      await publish(
        env,
        m,
        { title: "t", format: "markdown", content: "hi" } as never,
        null,
        undefined,
        "create",
      )
    ).id;
  const share = (id: string, email: string) =>
    call(env, R.shares(id), l.cookie, {
      method: "PUT",
      body: { email, role: "viewer" },
    });
  return { ...l, pub, share };
}

const sharesTo = async (email: string) =>
  (
    await env.DB.prepare("select count(*) as n from shares where email = ?")
      .bind(email)
      .first<{ n: number }>()
  )?.n;
const userRow = (email: string) =>
  env.DB.prepare("select id, status from users where email = ?")
    .bind(email)
    .first<{ id: string; status: string }>();
const removalAudit = async (id: string) => {
  const row = await env.DB.prepare(
    "select detail from audit_events where target_id = ? and action = 'user.status' order by at desc, id desc limit 1",
  )
    .bind(id)
    .first<{ detail: string }>();
  return JSON.parse(row?.detail ?? "{}") as Record<string, unknown>;
};

/** Code and Access sign-in are both refused, and no row comes back. */
async function expectRefused(e: Env, email: string) {
  expect((await codeEligibility(e, authConfig(e), email)).kind).toBe("none");
  const req = await requestCode(e, email);
  expect(req.sent).toBe(false);
  const a = await accessSignIn(email);
  expect(a.status).toBe(302);
  expect(a.headers.get("location")).toBe(PAGES.noAccess);
  vi.restoreAllMocks();
}

describe("removal sticks without spaces (row deleted)", () => {
  it("a removed guest: code (pending and new) and Access refused, no access to what was shared", async () => {
    const s = await sharer();
    const [a, b] = [await s.pub(), await s.pub()];
    const email = uniq("g", "x.com");
    expect((await s.share(a, email)).status).toBe(200);
    expect((await s.share(b, email)).status).toBe(200);
    const e = direct();
    // A signed-in guest, holding a code they asked for before the removal.
    const { cookie: session } = await login(email, "guest");
    expect((await call(e, R.artifact(a), session)).status).toBe(200);
    const pending = await requestCode(e, email);
    expect(pending.sent).toBe(true);
    const guest = await userRow(email);
    const admin = await login(uniq("adm", "a.com"), "admin");

    const r = await call(env, R.member(guest?.id ?? ""), admin.cookie, {
      method: "DELETE",
    });
    expect(r.status).toBe(204);
    expect(await sharesTo(email)).toBe(0);
    expect(await removalAudit(guest?.id ?? "")).toEqual({
      status: "removed",
      reason: "admin_remove",
      sharesDropped: 2,
    });
    // The code sent before the removal no longer verifies.
    const late = await verifyCode(pending.e, pending.code(), pending.pending);
    expect(late.status).toBe(401);
    expect(cookieOf(late, "oa_session")).toBeUndefined();
    await expectRefused(e, email);
    expect(await userRow(email)).toBeNull();
    for (const id of [a, b])
      expect((await call(e, R.artifact(id), session)).status).toBe(404);
  });

  it("a removed member: code and Access refused (a share to them re-admitted them as a guest)", async () => {
    const s = await sharer();
    const art = await s.pub();
    const email = uniq("m", "x.com");
    const m = await login(email, "member");
    expect((await s.share(art, email)).status).toBe(200);
    const admin = await login(uniq("adm", "a.com"), "admin");
    const r = await call(env, R.member(m.userId), admin.cookie, {
      method: "DELETE",
    });
    expect(r.status).toBe(204);
    expect(await sharesTo(email)).toBe(0);
    expect(await removalAudit(m.userId)).toMatchObject({ sharesDropped: 1 });
    await expectRefused(direct(), email);
    expect(await userRow(email)).toBeNull();
    expect((await call(env, R.artifact(art), m.cookie)).status).toBe(404);
  });

  it("an owner's re-share after the removal is a fresh grant: that artifact only", async () => {
    const s = await sharer();
    const [old, fresh] = [await s.pub(), await s.pub()];
    const email = uniq("g", "x.com");
    const g = await login(email, "guest");
    expect((await s.share(old, email)).status).toBe(200);
    await removeMember(env, g.userId, actorOf(s.userId, "admin"));
    expect((await s.share(fresh, email)).status).toBe(200);
    // Code sign-in admits them again, as a new guest.
    const e = direct();
    const req = await requestCode(e, email);
    const ok = await verifyCode(req.e, req.code(), req.pending);
    expect(ok.status).toBe(200);
    const session = cookieOf(ok, "oa_session") ?? "";
    const again = await userRow(email);
    expect(again?.id).not.toBe(g.userId);
    expect((await call(e, R.artifact(fresh), session)).status).toBe(200);
    expect((await call(e, R.artifact(old), session)).status).toBe(404);
    // Access sign-in too.
    expect((await accessSignIn(email)).headers.get("location")).toBe("/");
  });
});

describe("removal with spaces on (hosted): unchanged", () => {
  it("the removed row is refused at every sign-in, its shares are kept, and a re-share never revives it", async () => {
    const s = await sharer();
    const [old, fresh] = [await s.pub(), await s.pub()];
    const email = uniq("g", "x.com");
    const g = await login(email, "guest");
    expect((await s.share(old, email)).status).toBe(200);
    await removeMember(SPACES, g.userId, actorOf(s.userId, "admin"));
    expect((await userRow(email))?.status).toBe("removed");
    // Kept with the row: the removed row is what refuses them.
    expect(await sharesTo(email)).toBe(1);
    expect(await removalAudit(g.userId)).toEqual({
      status: "removed",
      reason: "admin_remove",
    });
    const e = direct({ FEATURES: "spaces" });
    await expectRefused(e, email);
    expect((await call(e, R.artifact(old), g.cookie)).status).toBe(404);
    // A re-share adds a share, but the removed row stays removed.
    expect((await s.share(fresh, email)).status).toBe(200);
    expect(await sharesTo(email)).toBe(2);
    await expectRefused(e, email);
    expect((await userRow(email))?.status).toBe("removed");
    expect((await call(e, R.artifact(fresh), g.cookie)).status).toBe(404);
  });
});
