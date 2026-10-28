// Parity 2: notices of guest shares the guest cap now reads as viewer, on
// Access-only installs only. Me.notices.guestShares: each member, for
// artifacts they own, dismissed per user. Me.notices.guestSummary: the org
// owner, counts only plus guests who own artifacts, dismissed install-wide.
import { env } from "cloudflare:workers";
import {
  GUEST_SHARES_NOTICE_LIMIT,
  type Me,
  MeSchema,
  type NoticeId,
  newId,
  R,
} from "@oa/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createPat } from "../src/auth/pat.js";
import type { Env } from "../src/env.js";
import { getSettingsKv } from "../src/services/members.js";
import { direct, uniq } from "./auth-helpers.js";
import { login } from "./helpers.js";

const app = createApp();
const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
const ACCESS_ONLY = { ...env, AUTH_PROVIDERS: "access" } as Env;

const call = (e: Env, path: string, cookie: string, method = "GET") =>
  app.fetch(
    new Request(`http://app.localhost${path}`, {
      method,
      headers: { cookie, "x-oa-request": "1" },
    }),
    e,
    ctx,
  );

const me = async (e: Env, cookie: string): Promise<Me> => {
  const r = await call(e, R.me, cookie);
  expect(r.status).toBe(200);
  return MeSchema.parse(await r.json());
};
const notices = async (cookie: string, e: Env = ACCESS_ONLY) =>
  (await me(e, cookie)).notices;

const dismiss = (cookie: string, id: NoticeId = "guest_shares") =>
  call(ACCESS_ONLY, R.noticeDismiss(id), cookie, "POST");

type U = { cookie: string; userId: string; email: string };
const user = async (
  p: string,
  role: "owner" | "admin" | "member" | "guest" = "member",
): Promise<U> => {
  const email = uniq(p, role === "guest" ? "x.com" : "a.com").toLowerCase();
  return { ...(await login(email, role)), email };
};

/** A live (or soft-deleted) artifact in `ownerId`'s personal space. */
async function artifact(ownerId: string, title: string, deleted = false) {
  const id = newId();
  await env.DB.prepare(
    "insert into artifacts (id, owner_id, space_id, title, format, visibility, created_at, updated_at, deleted_at) values (?, ?, ?, ?, 'html', 'private', 1, 1, ?)",
  )
    .bind(id, ownerId, ownerId, title, deleted ? Date.now() : null)
    .run();
  return id;
}

let at = 1_000;
async function share(artifactId: string, email: string, role = "editor") {
  at += 1;
  await env.DB.prepare(
    "insert into shares (artifact_id, email, role, created_by, created_at) values (?, ?, ?, ?, ?)",
  )
    .bind(artifactId, email, role, owner.userId, at)
    .run();
}

let owner: U;
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("delete from shares"),
    env.DB.prepare(
      "delete from settings where key like 'notice_dismissed:%' or key like 'notice_user:%'",
    ),
    // Earlier tests' guests no longer own artifacts for the summary.
    env.DB.prepare("update users set role = 'member' where role = 'guest'"),
  ]);
  owner ??= await user("owner", "owner");
});

describe("Me.notices.guestShares (parity 2)", () => {
  it("lists editor shares on the caller's own artifacts to active guests and never-signed-in addresses; skips viewers, members, inactive guests and deleted artifacts", async () => {
    const a = await user("a");
    const plan = await artifact(a.userId, "Plan");
    const gone = await artifact(a.userId, "Old", true);
    const g1 = await user("g1", "guest");
    const gv = await user("gv", "guest");
    const gr = await user("gr", "guest");
    const m = await user("m");
    // Never signed in: no users row, a guest at its first Access sign-in.
    const fresh = uniq("new", "y.com").toLowerCase();
    await env.DB.prepare("update users set status = 'removed' where id = ?")
      .bind(gr.userId)
      .run();
    await share(plan, g1.email);
    await share(plan, gv.email, "viewer");
    await share(plan, m.email);
    await share(plan, gr.email);
    await share(gone, g1.email);
    await share(plan, fresh);
    expect(await notices(a.cookie)).toEqual({
      guestShares: {
        items: [
          {
            artifactId: plan,
            title: "Plan",
            guestEmail: fresh,
            role: "editor",
          },
          {
            artifactId: plan,
            title: "Plan",
            guestEmail: g1.email,
            role: "editor",
          },
        ],
        more: false,
      },
    });
    // Share rows are untouched by the cap.
    const row = await env.DB.prepare(
      "select role from shares where artifact_id = ? and email = ?",
    )
      .bind(plan, g1.email)
      .first<{ role: string }>();
    expect(row?.role).toBe("editor");
  });

  it("per owner: A never sees B's titles, B never sees A's, and the org owner sees neither", async () => {
    const a = await user("a");
    const b = await user("b");
    const g = await user("g", "guest");
    const pa = await artifact(a.userId, "Alpha secret");
    const pb = await artifact(b.userId, "Beta secret");
    await share(pa, g.email);
    await share(pb, g.email);
    const na = await notices(a.cookie);
    expect(na?.guestShares?.items.map((i) => i.artifactId)).toEqual([pa]);
    expect(JSON.stringify(na)).not.toContain("Beta secret");
    const nb = await notices(b.cookie);
    expect(nb?.guestShares?.items.map((i) => i.artifactId)).toEqual([pb]);
    expect(JSON.stringify(nb)).not.toContain("Alpha secret");
    const no = await notices(owner.cookie);
    expect(no?.guestShares).toBeUndefined();
    expect(JSON.stringify(no)).not.toContain("secret");
  });

  it(`caps at ${GUEST_SHARES_NOTICE_LIMIT} items with more: true`, async () => {
    const a = await user("a");
    const many = await artifact(a.userId, "Many");
    for (let i = 0; i <= GUEST_SHARES_NOTICE_LIMIT; i++)
      await share(many, uniq(`cap${i}`, "x.com").toLowerCase());
    const n = (await notices(a.cookie))?.guestShares;
    expect(n?.items).toHaveLength(GUEST_SHARES_NOTICE_LIMIT);
    expect(n?.more).toBe(true);
    await env.DB.prepare(
      "delete from shares where rowid = (select rowid from shares order by created_at limit 1)",
    ).run();
    const m = (await notices(a.cookie))?.guestShares;
    expect(m?.items).toHaveLength(GUEST_SHARES_NOTICE_LIMIT);
    expect(m?.more).toBe(false);
  });

  it("only on Access-only installs: never on direct sign-in or hosted", async () => {
    const a = await user("a");
    await share(await artifact(a.userId, "Plan"), uniq("d", "x.com"));
    expect(await notices(a.cookie)).toBeDefined();
    expect(await notices(a.cookie, direct())).toBeUndefined();
    expect(
      await notices(a.cookie, { ...ACCESS_ONLY, HOSTED: "1" } as Env),
    ).toBeUndefined();
    expect(
      await notices(owner.cookie, direct({ HOSTED: "1" } as Partial<Env>)),
    ).toBeUndefined();
  });

  it("dismissal is per user: 204, idempotent, durable, and never hides another member's", async () => {
    const a = await user("a");
    const b = await user("b");
    const g = uniq("g", "x.com").toLowerCase();
    await share(await artifact(a.userId, "A"), g);
    await share(await artifact(b.userId, "B"), g);
    const r = await dismiss(a.cookie);
    expect(r.status).toBe(204);
    expect(await r.text()).toBe("");
    const key = `notice_user:${a.userId}:guest_shares`;
    const first = await env.DB.prepare(
      "select value from settings where key = ?",
    )
      .bind(key)
      .first<{ value: string }>();
    expect(first).not.toBeNull();
    expect((await dismiss(a.cookie)).status).toBe(204);
    expect(
      (
        await env.DB.prepare("select value from settings where key = ?")
          .bind(key)
          .first<{ value: string }>()
      )?.value,
    ).toBe(first?.value);
    expect(await notices(a.cookie)).toBeUndefined();
    expect((await notices(b.cookie))?.guestShares?.items).toHaveLength(1);
    // A later share never brings A's back.
    await share(await artifact(a.userId, "A2"), uniq("g2", "x.com"));
    expect(await notices(a.cookie)).toBeUndefined();
    // The per-user rows stay out of the install settings Me reads.
    const kv = await getSettingsKv(env);
    expect([...kv.keys()].some((k) => k.startsWith("notice_user:"))).toBe(
      false,
    );
  });

  it("guests get none and their dismiss is 404; a member can dismiss with a PAT", async () => {
    const g = await user("g", "guest");
    const own = await artifact(g.userId, "Guest-owned");
    await share(own, uniq("o", "x.com"));
    expect(await notices(g.cookie)).toBeUndefined();
    expect((await dismiss(g.cookie)).status).toBe(404);
    const a = await user("a");
    const { token } = await createPat(env, a.userId, "n");
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

describe("Me.notices.guestSummary (parity 2)", () => {
  it("counts guest shares and owners with no titles or share emails, and lists guests who own artifacts", async () => {
    const a = await user("a");
    const b = await user("b");
    const g = await user("g", "guest");
    const fresh = uniq("fresh", "y.com").toLowerCase();
    await share(await artifact(a.userId, "Alpha title"), g.email);
    await share(await artifact(a.userId, "Alpha two"), fresh);
    await share(await artifact(b.userId, "Beta title"), g.email);
    await share(await artifact(b.userId, "Beta view"), g.email, "viewer");
    const go = await user("go", "guest");
    await artifact(go.userId, "Guest one");
    await artifact(go.userId, "Guest two");
    await artifact(go.userId, "Guest gone", true);
    const n = await notices(owner.cookie);
    expect(n?.guestSummary).toEqual({
      shares: 3,
      owners: 2,
      guestOwners: [{ userId: go.userId, email: go.email, artifacts: 2 }],
      more: false,
    });
    const text = JSON.stringify(n);
    for (const secret of ["Alpha", "Beta", "Guest one", g.email, fresh])
      expect(text).not.toContain(secret);
  });

  it("only the uncapped org owner sees it; others get 404 on dismiss", async () => {
    const a = await user("a");
    await share(await artifact(a.userId, "Plan"), uniq("g", "x.com"));
    const admin = await user("ad", "admin");
    const g = await user("g", "guest");
    for (const u of [admin, a, g]) {
      expect((await notices(u.cookie))?.guestSummary).toBeUndefined();
      expect((await dismiss(u.cookie, "guest_summary")).status).toBe(404);
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
    expect((await notices(owner.cookie))?.guestSummary).toBeDefined();
  });

  it("dismissed install-wide: 204, idempotent, and later shares stay hidden; only on Access-only installs", async () => {
    const a = await user("a");
    await share(await artifact(a.userId, "Plan"), uniq("g", "x.com"));
    expect(await notices(owner.cookie, direct())).toBeUndefined();
    expect((await notices(owner.cookie))?.guestSummary?.shares).toBe(1);
    expect((await dismiss(owner.cookie, "guest_summary")).status).toBe(204);
    expect((await dismiss(owner.cookie, "guest_summary")).status).toBe(204);
    await share(await artifact(a.userId, "Plan 2"), uniq("g2", "x.com"));
    expect((await notices(owner.cookie))?.guestSummary).toBeUndefined();
    // The member's own list is separate.
    expect((await notices(a.cookie))?.guestShares?.items).toHaveLength(2);
  });
});
