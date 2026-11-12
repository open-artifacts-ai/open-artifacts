// Me.instance.directory.pendingReverts and lastThaw (#2150): what the thaw
// will put back, and what the last one did. Owners and admins only.
import { env } from "cloudflare:workers";
import { newId, R } from "@oa/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { HK } from "../src/directory/health.js";
import { UPSERT } from "../src/directory/store.js";
import { markThaw, thawFrozenEdits } from "../src/directory/thaw.js";
import type { Env } from "../src/env.js";
import { mailer, uniq } from "./auth-helpers.js";
import { directEnv, resetDirectory } from "./directory-helpers.js";
import { fetchAndWait, login } from "./helpers.js";

const app = createApp();
type Dir = {
  mode: string;
  pendingReverts?: number;
  lastThaw?: { id: string; reverted: number; names: string[]; at: string };
};
const meDirectory = async (e: Env, cookie: string) =>
  (
    (await (
      await fetchAndWait(
        app,
        new Request(`http://app.localhost${R.me}`, {
          headers: { cookie, "x-oa-request": "1" },
        }),
        e,
      )
    ).json()) as { instance: { directory?: Dir } }
  ).instance.directory;

const frozen = () =>
  directEnv({ ...mailer().env, FEATURES: "spaces,sync_frozen" });
const now = () => Date.now();
const google = () => directEnv(mailer().env);
let space: string;
beforeEach(async () => {
  await resetDirectory();
  await env.DB.prepare("delete from frozen_edits").run();
  await env.DB.prepare("delete from audit_events").run();
  space = `s-${newId()}`;
  await env.DB.prepare(
    "insert into spaces (id, kind, name, public_links, created_at) values (?, 'shared', ?, 0, 1)",
  )
    .bind(space, space)
    .run();
});

// A mapping on the space gives the person a role: the thaw re-derives the
// synced row, so the edit is a revert (without one it is kept, #2282).
const derive = async (u: string) => {
  const g = `g-${space}`;
  await env.DB.prepare(
    "insert or ignore into directory_groups (group_id, email) values (?, 'g@x.test')",
  )
    .bind(g)
    .run();
  await env.DB.prepare(
    "insert or ignore into group_mappings (space_id, group_id, group_email, role) values (?, ?, 'g@x.test', 'viewer')",
  )
    .bind(space, g)
    .run();
  await env.DB.prepare(
    "insert or ignore into directory_members (group_id, user_id) values (?, ?)",
  )
    .bind(g, u)
    .run();
};

const edit = async (kind: string, status = "active", who?: string) => {
  const u = who ? { userId: who } : await login(uniq("fe"), "member");
  if (status !== "active")
    await env.DB.prepare("update users set status = ? where id = ?")
      .bind(status, u.userId)
      .run();
  await env.DB.prepare(
    "insert into frozen_edits (space_id, user_id, at, manual_role, kind) values (?, ?, 1, null, ?)",
  )
    .bind(space, u.userId, kind)
    .run();
  // An override with no manual row before the freeze: the frozen one goes.
  if (kind === "override") await derive(u.userId);
  if (kind === "override")
    await env.DB.prepare(
      "insert into space_members (space_id, user_id, role, source, created_at) values (?, ?, 'editor', 'manual', 1)",
    )
      .bind(space, u.userId)
      .run();
};
const thawRow = async (
  at: number,
  action: string,
  who: string | null,
  detail: unknown = { thaw: true },
  actor = "sync",
) =>
  env.DB.prepare(
    "insert into audit_events (id, at, actor_kind, actor_id, action, target_type, target_id, space_id, detail) values (?, ?, ?, null, ?, 'user', ?, ?, ?)",
  )
    .bind(newId(), at, actor, action, who, space, JSON.stringify(detail))
    .run();
const person = async (name: string) => {
  const u = await login(uniq("tp"), "member");
  await env.DB.prepare("update users set name = ? where id = ?")
    .bind(name, u.userId)
    .run();
  return u.userId;
};

describe("Me.instance.directory.pendingReverts", () => {
  it("counts changed roles on synced people; removals and manual adds are not counted", async () => {
    await edit("override");
    await edit("override");
    await edit("delete");
    await edit("manual");
    const owner = await login(uniq("po"), "owner");
    expect((await meDirectory(frozen(), owner.cookie))?.pendingReverts).toBe(2);
  });

  it("does not count an edit of a removed user (the thaw never restores them)", async () => {
    await edit("override");
    await edit("override", "removed");
    const admin = await login(uniq("pa"), "admin");
    expect((await meDirectory(frozen(), admin.cookie))?.pendingReverts).toBe(1);
  });

  it("counts people, not pairs: one person edited in two spaces is 1", async () => {
    const who = await person("Two Spaces");
    await edit("override", "active", who);
    const other = space;
    space = `s-${newId()}`;
    await env.DB.prepare(
      "insert into spaces (id, kind, name, public_links, created_at) values (?, 'shared', ?, 0, 1)",
    )
      .bind(space, space)
      .run();
    await edit("override", "active", who);
    space = other;
    const owner = await login(uniq("po"), "owner");
    expect((await meDirectory(frozen(), owner.cookie))?.pendingReverts).toBe(1);
  });

  it("is 0 with nothing pending", async () => {
    const owner = await login(uniq("po"), "owner");
    expect((await meDirectory(frozen(), owner.cookie))?.pendingReverts).toBe(0);
  });

  it("is absent for a member and a guest", async () => {
    await edit("override");
    for (const role of ["member", "guest"] as const) {
      const u = await login(uniq("pm"), role);
      const d = await meDirectory(frozen(), u.cookie);
      expect(d).not.toHaveProperty("pendingReverts");
      expect(d).not.toHaveProperty("lastThaw");
    }
  });
});

describe("Me.instance.directory.lastThaw", () => {
  const mark = (t: number) =>
    env.DB.prepare(UPSERT).bind(HK.thaw, String(t)).run();
  it("counts distinct people reverted and names the first two; removal_kept and sync rows are not counted", async () => {
    const t = now() - 1000;
    await mark(t);
    const [a, b, c] = [
      await person("Alex Kim"),
      await person("Sam Lee"),
      await person("Pat Roe"),
    ];
    await thawRow(t, "space.member.role", a, { thaw: true, role: "viewer" });
    // The same person again (a second space): still one.
    await thawRow(t + 1, "space.member.add", a, { thaw: true, role: "editor" });
    await thawRow(t + 5, "space.member.remove", b);
    await thawRow(t + 9, "space.member.add", c, { thaw: true, role: "editor" });
    await thawRow(t + 9, "directory.sync", a, { thaw: "removal_kept" });
    await thawRow(t + 9, "directory.sync", a, {
      thaw: "sync",
      from: "a",
      to: "b",
    });
    const owner = await login(uniq("lo"), "owner");
    const d = await meDirectory(google(), owner.cookie);
    expect(d?.lastThaw).toEqual({
      id: String(t),
      reverted: 3,
      names: ["Alex Kim", "Sam Lee"],
      at: new Date(t + 9).toISOString(),
    });
  });

  it("one person: one name; two people: two names", async () => {
    const t = now() - 1000;
    await mark(t);
    const a = await person("Alex Kim");
    await thawRow(t, "space.member.role", a);
    const owner = await login(uniq("lo"), "owner");
    expect((await meDirectory(google(), owner.cookie))?.lastThaw).toMatchObject(
      { reverted: 1, names: ["Alex Kim"] },
    );
    await thawRow(t + 1, "space.member.role", await person("Sam Lee"));
    expect((await meDirectory(google(), owner.cookie))?.lastThaw).toMatchObject(
      { reverted: 2, names: ["Alex Kim", "Sam Lee"] },
    );
  });

  it("falls back to the email when the name is blank", async () => {
    const a = await person("  ");
    await mark(now() - 2000);
    await thawRow(now() - 1000, "space.member.role", a);
    const owner = await login(uniq("lo"), "owner");
    const d = await meDirectory(google(), owner.cookie);
    expect(d?.lastThaw?.names[0]).toMatch(/@/);
  });

  it("ignores non-sync actors and ordinary role changes", async () => {
    const t = now() - 1000;
    await mark(t);
    const a = await person("Alex Kim");
    await thawRow(t, "space.member.role", a, { thaw: true }, "user");
    await thawRow(t, "space.member.role", a, { role: "viewer" });
    const owner = await login(uniq("lo"), "owner");
    expect(await meDirectory(google(), owner.cookie)).not.toHaveProperty(
      "lastThaw",
    );
  });

  it("ignores a thaw older than three days", async () => {
    await mark(now() - 5 * 86_400_000);
    await thawRow(
      now() - 4 * 86_400_000,
      "space.member.role",
      await person("Alex Kim"),
    );
    const owner = await login(uniq("lo"), "owner");
    expect(await meDirectory(google(), owner.cookie)).not.toHaveProperty(
      "lastThaw",
    );
  });

  it("is absent for a member", async () => {
    await mark(now() - 2000);
    await thawRow(now() - 1000, "space.member.role", await person("Alex Kim"));
    const m = await login(uniq("lm"), "member");
    expect(await meDirectory(google(), m.cookie)).not.toHaveProperty(
      "lastThaw",
    );
  });

  it("ignores reverts from before the thaw's marker, and each thaw has its own id", async () => {
    const t = now() - 5000;
    const a = await person("Alex Kim");
    const b = await person("Sam Lee");
    await mark(t);
    await thawRow(t + 1, "space.member.role", a);
    const owner = await login(uniq("lo"), "owner");
    expect((await meDirectory(google(), owner.cookie))?.lastThaw).toMatchObject(
      { id: String(t), reverted: 1, names: ["Alex Kim"] },
    );
    await mark(t + 100);
    await thawRow(t + 101, "space.member.role", b);
    expect((await meDirectory(google(), owner.cookie))?.lastThaw).toMatchObject(
      { id: String(t + 100), reverted: 1, names: ["Sam Lee"] },
    );
  });

  it("ignores removed people", async () => {
    const t = now() - 1000;
    await mark(t);
    const a = await person("Gone Gal");
    await env.DB.prepare("update users set status = 'removed' where id = ?")
      .bind(a)
      .run();
    await thawRow(t + 1, "space.member.role", a);
    const owner = await login(uniq("lo"), "owner");
    expect(await meDirectory(google(), owner.cookie)).not.toHaveProperty(
      "lastThaw",
    );
  });

  it("no marker, no lastThaw", async () => {
    await thawRow(now() - 1000, "space.member.role", await person("Alex Kim"));
    const owner = await login(uniq("lo"), "owner");
    expect(await meDirectory(google(), owner.cookie)).not.toHaveProperty(
      "lastThaw",
    );
  });
});

describe("the real thaw", () => {
  const manual = (u: string, role: string) =>
    env.DB.prepare(
      "insert into space_members (space_id, user_id, role, source, created_at) values (?, ?, ?, 'manual', 1)",
    )
      .bind(space, u, role)
      .run();
  const frozenEdit = async (u: string, m: string | null) => {
    await derive(u);
    return env.DB.prepare(
      "insert into frozen_edits (space_id, user_id, at, manual_role, kind) values (?, ?, 1, ?, 'override')",
    )
      .bind(space, u, m)
      .run();
  };

  it("pendingReverts before, then lastThaw after, from the thaw's own audit rows", async () => {
    const [a, b, c, d] = [
      await person("Alex Kim"),
      await person("Sam Lee"),
      await person("Pat Roe"),
      await person("Dee Fox"),
    ];
    await manual(a, "editor"); // was viewer: role goes back
    await frozenEdit(a, "viewer");
    await frozenEdit(b, "viewer"); // manual row gone: added back
    await manual(c, "viewer"); // changed and changed back: nobody
    await frozenEdit(c, "viewer");
    await manual(d, "editor"); // had none: the frozen one goes
    await frozenEdit(d, null);
    const owner = await login(uniq("ro"), "owner");
    expect((await meDirectory(frozen(), owner.cookie))?.pendingReverts).toBe(3);
    const t = now();
    await markThaw(env, t);
    await thawFrozenEdits(env, { now: t, revoke: async () => {} });
    const d2 = await meDirectory(google(), owner.cookie);
    expect(d2?.lastThaw?.id).toBe(String(t));
    expect(d2?.lastThaw?.reverted).toBe(3);
    expect(d2?.lastThaw?.names).toHaveLength(2);
    for (const n of d2?.lastThaw?.names ?? [])
      expect(["Alex Kim", "Sam Lee", "Dee Fox"]).toContain(n);
    expect((await meDirectory(frozen(), owner.cookie))?.pendingReverts).toBe(0);
  });
});
