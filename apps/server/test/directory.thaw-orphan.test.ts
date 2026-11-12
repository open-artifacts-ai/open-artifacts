// #2282: a frozen role change on a synced row whose group mapping is gone
// leaves a manual row nothing would replace; the thaw keeps it.
import { env } from "cloudflare:workers";
import { newId, R } from "@oa/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { thawFrozenEdits } from "../src/directory/thaw.js";
import { mailer, uniq } from "./auth-helpers.js";
import { directEnv, resetDirectory } from "./directory-helpers.js";
import { fetchAndWait, login } from "./helpers.js";

const app = createApp();
const frozen = () =>
  directEnv({ ...mailer().env, FEATURES: "spaces,sync_frozen" });
let space: string;
let group: string;
beforeEach(async () => {
  await resetDirectory();
  await env.DB.prepare("delete from frozen_edits").run();
  space = `s-${newId()}`;
  group = `g-${newId()}`;
  await env.DB.prepare(
    "insert into spaces (id, kind, name, public_links, created_at) values (?, 'shared', ?, 0, 1)",
  )
    .bind(space, space)
    .run();
  await env.DB.prepare(
    "insert into directory_groups (group_id, email) values (?, ?)",
  )
    .bind(group, `${group}@x.test`)
    .run();
});

const sql = (q: string, ...a: unknown[]) =>
  env.DB.prepare(q)
    .bind(...a)
    .run();
const map = (role = "viewer") =>
  sql(
    "insert into group_mappings (space_id, group_id, group_email, role) values (?, ?, 'g@x.test', ?)",
    space,
    group,
    role,
  );
const member = async () => {
  const u = await login(uniq("om"), "member");
  await sql(
    "insert into directory_members (group_id, user_id) values (?, ?)",
    group,
    u.userId,
  );
  await sql(
    "insert into space_members (space_id, user_id, role, source, created_at) values (?, ?, 'viewer', 'sync', 1)",
    space,
    u.userId,
  );
  return u.userId;
};
const adminSets = async (userId: string, role: string) => {
  const admin = await login(uniq("oa"), "owner");
  const r = await fetchAndWait(
    app,
    new Request(`http://app.localhost${R.spaceMember(space, userId)}`, {
      method: "PUT",
      headers: {
        cookie: admin.cookie,
        "x-oa-request": "1",
        "content-type": "application/json",
      },
      body: JSON.stringify({ role }),
    }),
    frozen(),
  );
  expect(r.status).toBe(200);
};
const rows = async (userId: string) =>
  (
    await env.DB.prepare(
      "select source, role from space_members where space_id = ? and user_id = ? order by source",
    )
      .bind(space, userId)
      .all()
  ).results;
const edits = async (userId: string) =>
  env.DB.prepare(
    "select kind, manual_role from frozen_edits where space_id = ? and user_id = ?",
  )
    .bind(space, userId)
    .first();

describe("thaw keeps a manual row no current mapping would replace (#2282)", () => {
  it("mapping deleted after the freeze, admin changed the role: the manual row stays", async () => {
    await map();
    const u = await member();
    await sql("delete from group_mappings where space_id = ?", space);
    await adminSets(u, "editor");
    expect(await edits(u)).toEqual({ kind: "override", manual_role: null });
    expect(await rows(u)).toEqual([{ source: "manual", role: "editor" }]);
    await thawFrozenEdits(frozen());
    expect(await rows(u)).toEqual([{ source: "manual", role: "editor" }]);
    expect(await edits(u)).toBeNull();
    const audit = await env.DB.prepare(
      "select action, detail from audit_events where space_id = ? and target_id = ? and actor_kind = 'sync'",
    )
      .bind(space, u)
      .all<{ action: string; detail: string }>();
    expect(audit.results.map((a) => a.action)).toEqual(["directory.sync"]);
    expect(JSON.parse(audit.results[0]?.detail ?? "{}")).toMatchObject({
      thaw: "manual_kept",
      role: "editor",
    });
  });

  it("a pre-freeze manual role is not put back over the kept row", async () => {
    await map("editor");
    const u = await member();
    await sql(
      "insert into space_members (space_id, user_id, role, source, created_at) values (?, ?, 'viewer', 'manual', 1)",
      space,
      u,
    );
    await sql("delete from group_mappings where space_id = ?", space);
    await adminSets(u, "manager");
    expect(await edits(u)).toEqual({ kind: "override", manual_role: "viewer" });
    await thawFrozenEdits(frozen());
    expect(await rows(u)).toEqual([{ source: "manual", role: "manager" }]);
  });

  it("a mapping still derives a role: the manual row goes, the sync row is re-derived", async () => {
    await map("viewer");
    const u = await member();
    await adminSets(u, "editor");
    expect(await rows(u)).toEqual([{ source: "manual", role: "editor" }]);
    await thawFrozenEdits(frozen());
    expect(await rows(u)).toEqual([{ source: "sync", role: "viewer" }]);
  });

  it("the own-group variant (a mapping on the space's own group) takes the same path", async () => {
    // Own-group rows derive from group_mappings too: a deleted one keeps the
    // admin's manual row, the other pair, mapped, is re-derived.
    await map();
    const a = await member();
    const b = await member();
    await adminSets(a, "editor");
    await adminSets(b, "editor");
    await sql("delete from group_mappings where space_id = ?", space);
    await map();
    await sql("delete from directory_members where user_id = ?", a);
    await thawFrozenEdits(frozen());
    expect(await rows(a)).toEqual([{ source: "manual", role: "editor" }]);
    expect(await rows(b)).toEqual([{ source: "sync", role: "viewer" }]);
  });
});

describe("pendingReverts leaves out the orphan pair", () => {
  it("counts only the override pairs a mapping would re-derive", async () => {
    await map();
    const kept = await member();
    const reverted = await member();
    await adminSets(kept, "editor");
    await adminSets(reverted, "editor");
    await sql("delete from directory_members where user_id = ?", kept);
    const owner = await login(uniq("po"), "owner");
    const r = await fetchAndWait(
      app,
      new Request(`http://app.localhost${R.me}`, {
        headers: { cookie: owner.cookie, "x-oa-request": "1" },
      }),
      frozen(),
    );
    const body = (await r.json()) as {
      instance: { directory?: { pendingReverts?: number } };
    };
    expect(body.instance.directory?.pendingReverts).toBe(1);
  });
});
