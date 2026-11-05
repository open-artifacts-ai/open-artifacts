import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { seedShare, seedUser, uniq } from "./auth-helpers.js";
import { accessSignIn } from "./fake-access.js";

// P3 Task 8: an Access sign-in writes auth.signin (a fake Access answers the
// OIDC exchange: fake-access.ts).
afterEach(() => vi.restoreAllMocks());

const auditRows = async (id: string) =>
  (
    await env.DB.prepare(
      "select action, actor_id, detail from audit_events where target_id = ?",
    )
      .bind(id)
      .all<{ action: string; actor_id: string; detail: string }>()
  ).results;

it("an Access sign-in is audited as auth.signin (provider access)", async () => {
  const email = uniq("accessaudit");
  const id = await seedUser(email, "member");
  const r = await accessSignIn(email);
  expect(r.status).toBe(302);
  expect(r.headers.get("location")).toBe("/");
  expect(await auditRows(id)).toEqual([
    {
      action: "auth.signin",
      actor_id: id,
      detail: JSON.stringify({ provider: "access" }),
    },
  ]);
});

it("a first Access sign-in by an invited guest is audited in the same batch", async () => {
  const email = uniq("accessguest", "out.com");
  await seedShare(email);
  expect((await accessSignIn(email)).status).toBe(302);
  const u = await env.DB.prepare("select id from users where email = ?")
    .bind(email)
    .first<{ id: string }>();
  expect(await auditRows(u?.id ?? "")).toHaveLength(1);
});

it("a refused Access sign-in writes no audit row", async () => {
  const email = uniq("accessnone", "out.com");
  expect((await accessSignIn(email)).status).toBe(302);
  expect(
    (
      await env.DB.prepare(
        "select count(*) n from audit_events where action = 'auth.signin' and target_id not in (select id from users)",
      ).first<{ n: number }>()
    )?.n,
  ).toBe(0);
  expect(
    await env.DB.prepare("select id from users where email = ?")
      .bind(email)
      .first(),
  ).toBeNull();
});

describe("a failing audit insert", () => {
  const FAIL =
    "create trigger if not exists audit_fail_access before insert on audit_events begin select raise(abort, 'audit down'); end";
  afterEach(async () => {
    await env.DB.prepare("drop trigger if exists audit_fail_access").run();
  });

  it("leaves an existing user unchanged and fails the sign-in", async () => {
    const email = uniq("accessatomic");
    const id = await seedUser(email, "member");
    await env.DB.prepare(
      "update users set last_seen_at = 1, name = 'Before' where id = ?",
    )
      .bind(id)
      .run();
    await env.DB.prepare(FAIL).run();
    const r = await accessSignIn(email);
    expect(r.status).toBe(500);
    expect(
      r.headers.getSetCookie().some((c) => c.startsWith("oa_session")),
    ).toBe(false);
    expect(
      await env.DB.prepare(
        "select last_seen_at l, name n from users where id = ?",
      )
        .bind(id)
        .first(),
    ).toEqual({ l: 1, n: "Before" });
  });

  it("creates no guest row", async () => {
    const email = uniq("accessatomicguest", "out.com");
    await seedShare(email);
    await env.DB.prepare(FAIL).run();
    expect((await accessSignIn(email)).status).toBe(500);
    expect(
      await env.DB.prepare("select id from users where email = ?")
        .bind(email)
        .first(),
    ).toBeNull();
  });
});
