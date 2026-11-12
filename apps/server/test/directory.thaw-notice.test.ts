// Me.instance.directory.pendingReverts and lastThaw (#2150): what the thaw
// will put back, and what the last one did. Owners and admins only.
import { env } from "cloudflare:workers";
import { newId, R } from "@oa/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Env } from "../src/env.js";
import { mailer, uniq } from "./auth-helpers.js";
import { directEnv, resetDirectory } from "./directory-helpers.js";
import { fetchAndWait, login } from "./helpers.js";

const app = createApp();
type Dir = {
  mode: string;
  pendingReverts?: number;
  lastThaw?: { id: string; reverted: number; at: string };
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

const edit = async (kind: string, status = "active") => {
  const u = await login(uniq("fe"), "member");
  if (status !== "active")
    await env.DB.prepare("update users set status = ? where id = ?")
      .bind(status, u.userId)
      .run();
  await env.DB.prepare(
    "insert into frozen_edits (space_id, user_id, at, manual_role, kind) values (?, ?, 1, null, ?)",
  )
    .bind(space, u.userId, kind)
    .run();
};
const thawRow = async (
  at: number,
  action: string,
  detail: unknown = { thaw: true },
  actor = "sync",
) =>
  env.DB.prepare(
    "insert into audit_events (id, at, actor_kind, actor_id, action, target_type, target_id, space_id, detail) values (?, ?, ?, null, ?, 'user', null, ?, ?)",
  )
    .bind(newId(), at, actor, action, space, JSON.stringify(detail))
    .run();

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
  const now = () => Date.now();
  it("counts the thaw's reverted roles (role, remove, add); removal_kept and sync rows are not counted", async () => {
    const t = now() - 1000;
    await thawRow(t, "space.member.role", { thaw: true, role: "viewer" });
    await thawRow(t + 5, "space.member.remove");
    await thawRow(t + 9, "space.member.add", { thaw: true, role: "editor" });
    await thawRow(t + 9, "directory.sync", { thaw: "removal_kept" });
    await thawRow(t + 9, "directory.sync", {
      thaw: "sync",
      from: "a",
      to: "b",
    });
    const owner = await login(uniq("lo"), "owner");
    const d = await meDirectory(directEnv(mailer().env), owner.cookie);
    expect(d?.lastThaw?.reverted).toBe(3);
    expect(d?.lastThaw?.id).toBe(String(t));
    expect(d?.lastThaw?.at).toBe(new Date(t + 9).toISOString());
  });

  it("ignores non-sync actors and ordinary role changes", async () => {
    const t = now() - 1000;
    await thawRow(t, "space.member.role", { thaw: true }, "user");
    await thawRow(t, "space.member.role", { role: "viewer" });
    const owner = await login(uniq("lo"), "owner");
    const d = await meDirectory(directEnv(mailer().env), owner.cookie);
    expect(d).not.toHaveProperty("lastThaw");
  });

  it("ignores a thaw older than three days", async () => {
    await thawRow(now() - 4 * 86_400_000, "space.member.role");
    const owner = await login(uniq("lo"), "owner");
    const d = await meDirectory(directEnv(mailer().env), owner.cookie);
    expect(d).not.toHaveProperty("lastThaw");
  });

  it("is absent for a member", async () => {
    await thawRow(now() - 1000, "space.member.role");
    const m = await login(uniq("lm"), "member");
    const d = await meDirectory(directEnv(mailer().env), m.cookie);
    expect(d).not.toHaveProperty("lastThaw");
  });
});
