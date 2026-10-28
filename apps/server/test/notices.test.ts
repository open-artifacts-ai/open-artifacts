// Parity 2: the org owner's one-time notice of guest shares above viewer
// (Me.notices.guestShares) and its install-wide dismissal (R.noticeDismiss).
import { env } from "cloudflare:workers";
import { GUEST_SHARES_NOTICE_LIMIT, type Me, MeSchema, R } from "@oa/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createPat } from "../src/auth/pat.js";
import type { Env } from "../src/env.js";
import { publish } from "../src/services/artifacts.js";
import { getUser } from "../src/services/users.js";
import { direct, uniq } from "./auth-helpers.js";
import { login } from "./helpers.js";

const app = createApp();
const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
const ACCESS_ONLY = { ...env, AUTH_PROVIDERS: "access" } as Env;

const call = (
  e: Env,
  path: string,
  cookie: string,
  method = "GET",
  headers: Record<string, string> = {},
) =>
  app.fetch(
    new Request(`http://app.localhost${path}`, {
      method,
      headers: { cookie, "x-oa-request": "1", ...headers },
    }),
    e,
    ctx,
  );

const me = async (e: Env, cookie: string): Promise<Me> => {
  const r = await call(e, R.me, cookie);
  expect(r.status).toBe(200);
  return MeSchema.parse(await r.json());
};

const dismiss = (e: Env, cookie: string) =>
  call(e, R.noticeDismiss("guest_shares"), cookie, "POST");

let at = 1_000;
/** A live (or soft-deleted) artifact owned by the org owner. */
async function artifact(_ownerId: string, title: string, deleted = false) {
  const u = await getUser(env, owner.userId);
  const { id } = await publish(
    env,
    u as never,
    { title, format: "markdown", content: "x" } as never,
    null,
    undefined,
    "create",
  );
  if (deleted)
    await env.DB.prepare("update artifacts set deleted_at = ? where id = ?")
      .bind(Date.now(), id)
      .run();
  return id;
}
async function share(
  artifactId: string,
  email: string,
  role: string,
  by: string,
) {
  at += 1;
  await env.DB.prepare(
    "insert into shares (artifact_id, email, role, created_by, created_at) values (?, ?, ?, ?, ?)",
  )
    .bind(artifactId, email, role, by, at)
    .run();
}

let owner: { cookie: string; userId: string };
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("delete from shares"),
    env.DB.prepare("delete from settings where key like 'notice_dismissed:%'"),
  ]);
  owner ??= await login(uniq("owner"), "owner");
});

describe("Me.notices.guestShares (parity 2)", () => {
  it("lists guest shares above viewer, newest first, with title and email; skips viewers, members, inactive guests and deleted artifacts", async () => {
    const a = await artifact(owner.userId, "Plan");
    const gone = await artifact(owner.userId, "Old", true);
    const g1 = await login(uniq("g1", "x.com"), "guest");
    const g2 = await login(uniq("g2", "x.com"), "guest");
    const gv = await login(uniq("gv", "x.com"), "guest");
    const gr = await login(uniq("gr", "x.com"), "guest");
    const m = await login(uniq("m"));
    const email = async (id: string) =>
      (
        await env.DB.prepare("select email from users where id = ?")
          .bind(id)
          .first<{ email: string }>()
      )?.email as string;
    const [e1, e2, ev, er, em] = await Promise.all(
      [g1, g2, gv, gr, m].map((u) => email(u.userId)),
    );
    await env.DB.prepare("update users set status = 'removed' where id = ?")
      .bind(gr.userId)
      .run();
    await share(a, e1, "editor", owner.userId);
    await share(a, ev, "viewer", owner.userId);
    await share(a, em, "editor", owner.userId);
    await share(a, er, "editor", owner.userId);
    await share(gone, e2, "editor", owner.userId);
    await share(a, e2, "editor", owner.userId);
    for (const e of [ACCESS_ONLY, direct()]) {
      const n = (await me(e, owner.cookie)).notices;
      expect(n).toEqual({
        guestShares: {
          items: [
            { artifactId: a, title: "Plan", guestEmail: e2, role: "editor" },
            { artifactId: a, title: "Plan", guestEmail: e1, role: "editor" },
          ],
          more: false,
        },
      });
    }
    // Share rows are untouched by the cap.
    const roles = await env.DB.prepare(
      "select role from shares where artifact_id = ? and email in (?, ?)",
    )
      .bind(a, e1, e2)
      .all<{ role: string }>();
    expect(roles.results.map((r) => r.role)).toEqual(["editor", "editor"]);
  });

  it(`caps at ${GUEST_SHARES_NOTICE_LIMIT} items with more: true`, async () => {
    const a = await artifact(owner.userId, "Many");
    for (let i = 0; i <= GUEST_SHARES_NOTICE_LIMIT; i++) {
      const email = uniq(`cap${i}`, "x.com").toLowerCase();
      await login(email, "guest");
      await share(a, email, "editor", owner.userId);
    }
    const n = (await me(ACCESS_ONLY, owner.cookie)).notices?.guestShares;
    expect(n?.items).toHaveLength(GUEST_SHARES_NOTICE_LIMIT);
    expect(n?.more).toBe(true);
    // Exactly the limit: more is false.
    await env.DB.prepare(
      "delete from shares where rowid = (select rowid from shares order by created_at limit 1)",
    ).run();
    const m = (await me(ACCESS_ONLY, owner.cookie)).notices?.guestShares;
    expect(m?.items).toHaveLength(GUEST_SHARES_NOTICE_LIMIT);
    expect(m?.more).toBe(false);
  });

  it("is absent when no guest holds a share above viewer", async () => {
    const a = await artifact(owner.userId, "Quiet");
    const g = uniq("q", "x.com").toLowerCase();
    await login(g, "guest");
    await share(a, g, "viewer", owner.userId);
    expect((await me(ACCESS_ONLY, owner.cookie)).notices).toBeUndefined();
  });

  it("only the uncapped org owner sees it; others get 404 on dismiss", async () => {
    const a = await artifact(owner.userId, "Plan");
    const g = await login(uniq("g", "x.com"), "guest");
    const ge = (
      await env.DB.prepare("select email from users where id = ?")
        .bind(g.userId)
        .first<{ email: string }>()
    )?.email as string;
    await share(a, ge, "editor", owner.userId);
    const admin = await login(uniq("ad"), "admin");
    const member = await login(uniq("mb"));
    for (const u of [admin, member, g]) {
      expect((await me(ACCESS_ONLY, u.cookie)).notices).toBeUndefined();
      expect((await dismiss(ACCESS_ONLY, u.cookie)).status).toBe(404);
    }
    // An unknown notice is 404, even for the owner.
    expect(
      (
        await call(
          ACCESS_ONLY,
          "/api/v1/notices/nope/dismiss",
          owner.cookie,
          "POST",
        )
      ).status,
    ).toBe(404);
    // Still there: nobody else's dismiss counted.
    expect((await me(ACCESS_ONLY, owner.cookie)).notices).toBeDefined();
  });

  it("never shows on hosted", async () => {
    const a = await artifact(owner.userId, "Plan");
    const g = uniq("h", "x.com").toLowerCase();
    await login(g, "guest");
    await share(a, g, "editor", owner.userId);
    const hosted = direct({ HOSTED: "1" } as Partial<Env>);
    expect((await me(hosted, owner.cookie)).notices).toBeUndefined();
  });

  it("dismissal is 204, idempotent, durable for the install, and hides later shares too", async () => {
    const a = await artifact(owner.userId, "Plan");
    const g = uniq("d", "x.com").toLowerCase();
    await login(g, "guest");
    await share(a, g, "editor", owner.userId);
    expect((await me(ACCESS_ONLY, owner.cookie)).notices).toBeDefined();
    const r = await dismiss(ACCESS_ONLY, owner.cookie);
    expect(r.status).toBe(204);
    expect(await r.text()).toBe("");
    const row = await env.DB.prepare(
      "select value from settings where key = 'notice_dismissed:guest_shares'",
    ).first<{ value: string }>();
    expect(row).not.toBeNull();
    // Again: still 204, the first dismissal kept.
    expect((await dismiss(ACCESS_ONLY, owner.cookie)).status).toBe(204);
    expect(
      (
        await env.DB.prepare(
          "select value from settings where key = 'notice_dismissed:guest_shares'",
        ).first<{ value: string }>()
      )?.value,
    ).toBe(row?.value);
    // A later guest share never brings it back, on any sign-in mode.
    const g2 = uniq("d2", "x.com").toLowerCase();
    await login(g2, "guest");
    await share(a, g2, "editor", owner.userId);
    for (const e of [ACCESS_ONLY, direct()])
      expect((await me(e, owner.cookie)).notices).toBeUndefined();
  });

  it("the owner can dismiss with a PAT too", async () => {
    const { token } = await createPat(env, owner.userId, "n");
    const r = await app.fetch(
      new Request(`http://app.localhost${R.noticeDismiss("guest_shares")}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      }),
      ACCESS_ONLY,
      ctx,
    );
    expect(r.status).toBe(204);
  });
});
