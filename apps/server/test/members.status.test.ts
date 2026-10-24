// P3 Task 6: user status (setUserStatus), the active-only user read, and
// removeMember with and without the spaces flag (#478).
import { env } from "cloudflare:workers";
import { newId, R } from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createPat } from "../src/auth/pat.js";
import type { Env } from "../src/env.js";
import { userActor } from "../src/services/audit.js";
import { patchMember, removeMember } from "../src/services/members.js";
import {
  getUser,
  getUserWithEpoch,
  setUserStatus,
} from "../src/services/users.js";
import { api, login } from "./helpers.js";
import { callWorker, MCP_URL } from "./mcp-helpers.js";

const app = createApp();
const tag = newId().slice(0, 6).toLowerCase();
const SPACES = { ...(env as object), FEATURES: "spaces" } as Env;

const one = <T>(sql: string, ...binds: unknown[]) =>
  env.DB.prepare(sql)
    .bind(...binds)
    .first<T>();
const status = async (id: string) =>
  (await one<{ status: string }>("select status from users where id = ?", id))
    ?.status;
type AuditRow = {
  action: string;
  actor_kind: string;
  actor_id: string | null;
  target_type: string;
  target_id: string;
  detail: string;
};
const auditsFor = async (targetId: string, action: string) =>
  (
    await env.DB.prepare(
      "select * from audit_events where target_id = ? and action = ? order by at, id",
    )
      .bind(targetId, action)
      .all<AuditRow>()
  ).results;
const insertArtifact = (
  id: string,
  owner: string,
  spaceId: string,
  deletedAt: number | null = null,
) =>
  env.DB.prepare(
    "insert into artifacts (id, owner_id, space_id, title, format, visibility, created_at, updated_at, deleted_at) values (?, ?, ?, 't', 'html', 'private', 1, 1, ?)",
  )
    .bind(id, owner, spaceId, deletedAt)
    .run();
const sharedSpace = async () => {
  const id = newId();
  await env.DB.prepare(
    "insert into spaces (id, kind, name, created_at) values (?, 'shared', 'Team', 1)",
  )
    .bind(id)
    .run();
  return id;
};
const placement = (id: string) =>
  one<{ owner_id: string; space_id: string }>(
    "select owner_id, space_id from artifacts where id = ?",
    id,
  );

let owner: { cookie: string; userId: string };
let admin: { cookie: string; userId: string };
let ownerOfRecord: string;

beforeAll(async () => {
  owner = await login(`st-owner-${tag}@x.com`, "owner");
  admin = await login(`st-admin-${tag}@x.com`, "admin");
  ownerOfRecord =
    (
      await one<{ id: string }>(
        "select id from users where role = 'owner' order by created_at, id limit 1",
      )
    )?.id ?? "";
});

const mk = (p: string, role: "member" | "admin" | "guest" = "member") =>
  login(`${p}-${newId().slice(0, 4).toLowerCase()}-${tag}@x.com`, role);

describe("setUserStatus", () => {
  it.each(["cookie", "pat"])("suspended user → 401 via %s", async (cred) => {
    const u = await mk(`st-401-${cred}`);
    const { token } = await createPat(env, u.userId, "t");
    const auth = cred === "cookie" ? u.cookie : token;
    expect((await api(app, R.me, auth)).status).toBe(200);
    await setUserStatus(env, u.userId, "suspended", "admin_suspend");
    expect((await api(app, R.me, auth)).status).toBe(401);
  });

  it("suspended user → 401 via a PAT at /mcp", async () => {
    const u = await mk("st-401-mcp");
    const { token } = await createPat(env, u.userId, "t");
    await setUserStatus(env, u.userId, "suspended", "admin_suspend");
    const r = await callWorker(
      new Request(MCP_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    expect(r.status).toBe(401);
  });

  it("reactivated user's PATs and old sessions stay revoked", async () => {
    const u = await mk("st-react");
    const { token } = await createPat(env, u.userId, "t");
    await setUserStatus(env, u.userId, "suspended", "admin_suspend");
    await setUserStatus(env, u.userId, "active", "admin_restore");
    expect(await status(u.userId)).toBe("active");
    expect(await getUser(env, u.userId)).not.toBeNull();
    expect((await api(app, R.me, token)).status).toBe(401);
    // The session cookie minted before the suspension is dead too (epoch).
    expect((await api(app, R.me, u.cookie)).status).toBe(401);
    const revoked = await one<{ n: number }>(
      "select count(*) n from tokens where user_id = ? and revoked_at is null",
      u.userId,
    );
    expect(revoked?.n).toBe(0);
  });

  it("gatherer: a suspended or removed user resolves to nobody on every surface", async () => {
    for (const s of ["suspended", "removed"] as const) {
      const u = await mk(`st-gather-${s}`);
      await setUserStatus(env, u.userId, s, "admin_suspend");
      // Cookie (getUserWithEpoch), PAT and OAuth (getUser) all read this row.
      expect(await getUserWithEpoch(env, u.userId)).toBeNull();
      expect(await getUser(env, u.userId)).toBeNull();
    }
  });

  it("unsuspend sets status back to active; a removed row stays removed", async () => {
    const u = await mk("st-un");
    await setUserStatus(env, u.userId, "suspended", "directory_suspend");
    expect(await status(u.userId)).toBe("suspended");
    await setUserStatus(env, u.userId, "active", "directory_unsuspend");
    expect(await status(u.userId)).toBe("active");
    await setUserStatus(env, u.userId, "removed", "directory_delete");
    expect(await status(u.userId)).toBe("removed");
    await setUserStatus(env, u.userId, "active", "admin_restore");
    await setUserStatus(env, u.userId, "suspended", "admin_suspend");
    expect(await status(u.userId)).toBe("removed");
  });

  it("the instance owner is never deactivated", async () => {
    await setUserStatus(env, owner.userId, "suspended", "directory_suspend");
    expect(await status(owner.userId)).toBe("active");
    expect(await auditsFor(owner.userId, "user.status")).toEqual([]);
  });

  it("writes one user.status audit row per change, none for a no-op", async () => {
    const u = await mk("st-audit");
    await setUserStatus(
      env,
      u.userId,
      "suspended",
      "admin_suspend",
      undefined,
      userActor(admin.userId),
    );
    await setUserStatus(env, u.userId, "suspended", "admin_suspend");
    await setUserStatus(env, u.userId, "active", "directory_unsuspend");
    // A removed row stays removed: the refused restore is not audited.
    await setUserStatus(env, u.userId, "removed", "directory_delete");
    await setUserStatus(env, u.userId, "active", "admin_restore");
    const rows = await auditsFor(u.userId, "user.status");
    expect(
      rows.map((r) => ({
        kind: r.actor_kind,
        actor: r.actor_id,
        target: r.target_type,
        detail: JSON.parse(r.detail),
      })),
    ).toEqual([
      {
        kind: "user",
        actor: admin.userId,
        target: "user",
        detail: { status: "suspended", reason: "admin_suspend" },
      },
      {
        kind: "sync",
        actor: null,
        target: "user",
        detail: { status: "active", reason: "directory_unsuspend" },
      },
      {
        kind: "sync",
        actor: null,
        target: "user",
        detail: { status: "removed", reason: "directory_delete" },
      },
    ]);
  });
});

describe("removeMember with the spaces flag on", () => {
  it("keeps the row (status removed) and the personal space; nothing moves", async () => {
    const u = await mk("st-rm-on");
    const mine = newId();
    await insertArtifact(mine, u.userId, u.userId);
    const space = await sharedSpace();
    const inSpace = newId();
    await insertArtifact(inSpace, u.userId, space);
    const { token } = await createPat(env, u.userId, "t");
    await removeMember(SPACES, u.userId, undefined, userActor(admin.userId));
    expect(await status(u.userId)).toBe("removed");
    expect(
      await one("select id, kind from spaces where id = ?", u.userId),
    ).toEqual({ id: u.userId, kind: "personal" });
    expect(await placement(mine)).toEqual({
      owner_id: u.userId,
      space_id: u.userId,
    });
    expect(await placement(inSpace)).toEqual({
      owner_id: u.userId,
      space_id: space,
    });
    expect((await api(app, R.me, token)).status).toBe(401);
    expect((await api(app, R.me, u.cookie)).status).toBe(401);
    const [row, ...rest] = await auditsFor(u.userId, "user.status");
    expect(rest).toEqual([]);
    expect(row).toMatchObject({ actor_kind: "user", actor_id: admin.userId });
    expect(JSON.parse(row?.detail ?? "{}")).toEqual({
      status: "removed",
      reason: "admin_remove",
    });
  });

  it("removed user's personal artifacts stay unreadable by the org owner", async () => {
    const u = await mk("st-rm-read");
    const mine = newId();
    await insertArtifact(mine, u.userId, u.userId);
    await removeMember(SPACES, u.userId, undefined, userActor(owner.userId));
    expect((await api(app, R.artifact(mine), owner.cookie)).status).toBe(404);
  });

  it("the owner still can't be removed", async () => {
    await expect(removeMember(SPACES, ownerOfRecord)).rejects.toMatchObject({
      code: "bad_request",
    });
    expect(await status(ownerOfRecord)).toBe("active");
  });
});

describe("removeMember with the spaces flag off (#478)", () => {
  it("only personal-space artifacts move; shared-space ones keep their space", async () => {
    const u = await mk("st-rm-off");
    const space = await sharedSpace();
    const [mine, mineGone, inSpace, inSpaceGone] = [
      newId(),
      newId(),
      newId(),
      newId(),
    ] as const;
    await insertArtifact(mine, u.userId, u.userId);
    await insertArtifact(mineGone, u.userId, u.userId, 5);
    await insertArtifact(inSpace, u.userId, space);
    await insertArtifact(inSpaceGone, u.userId, space, 5);
    await removeMember(env, u.userId);
    const to = ownerOfRecord;
    expect(await placement(mine)).toEqual({ owner_id: to, space_id: to });
    expect(await placement(mineGone)).toEqual({ owner_id: to, space_id: to });
    // owner_id must name a user (the row is deleted); it grants nothing in a
    // shared space, where access comes from the space alone.
    expect(await placement(inSpace)).toEqual({ owner_id: to, space_id: space });
    expect(await placement(inSpaceGone)).toEqual({
      owner_id: to,
      space_id: space,
    });
    expect(await one("select id from users where id = ?", u.userId)).toBeNull();
  });
});

describe("patchMember", () => {
  it("audits a role change as user.role; the same role writes no row", async () => {
    const u = await mk("st-role");
    await patchMember(
      env,
      u.userId,
      { role: "admin" },
      undefined,
      userActor(owner.userId),
    );
    await patchMember(env, u.userId, { role: "admin" });
    const rows = await auditsFor(u.userId, "user.role");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_kind: "user",
      actor_id: owner.userId,
      target_type: "user",
    });
    expect(JSON.parse(rows[0]?.detail ?? "{}")).toEqual({
      from: "member",
      to: "admin",
    });
  });

  it("the members route audits with the calling admin as actor", async () => {
    const u = await mk("st-role-route");
    const r = await api(app, R.member(u.userId), admin.cookie, {
      method: "PATCH",
      body: { role: "admin" },
    });
    expect(r.status).toBe(200);
    expect((await auditsFor(u.userId, "user.role"))[0]).toMatchObject({
      actor_kind: "user",
      actor_id: admin.userId,
    });
  });
});
