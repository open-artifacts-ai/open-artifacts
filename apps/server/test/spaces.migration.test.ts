import { env } from "cloudflare:workers";
import { type Member, newId, R } from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { removeMember, SYSTEM_ACTOR } from "../src/services/members.js";
import { getUser } from "../src/services/users.js";
import { api, login } from "./helpers.js";

// P3 Task 1: migration NNNN_spaces (found by suffix, never by number) and the
// rollout window. The test DB has every migration applied at startup, so the
// backfill is asserted as an invariant (no artifact without a space, every
// personal space named after its user) plus the raw SQL that must keep doing
// it, rather than as a before/after snapshot.
const raw = import.meta.glob("../migrations/*_spaces.sql", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;
const file = Object.keys(raw).find((f) => f.endsWith("_spaces.sql"));
const SPACES_MIGRATION = file ? raw[file] : "";

const app = createApp();
const tag = newId().slice(0, 6).toLowerCase();

const cols = async (table: string) =>
  (
    await env.DB.prepare(
      `select name, pk, "notnull" as nn, dflt_value as d from pragma_table_info('${table}') order by cid`,
    ).all<{ name: string; pk: number; nn: number; d: string | null }>()
  ).results;
const one = async <T>(sql: string, ...binds: unknown[]) =>
  (await env.DB.prepare(sql)
    .bind(...binds)
    .first<T>()) as T;
const spaceRow = (id: string) =>
  one<{
    id: string;
    kind: string;
    name: string;
    owner_user_id: string | null;
    all_members_role: string | null;
    public_links: number;
    deleted_at: number | null;
  }>("select * from spaces where id = ?", id);
const artifactSpace = async (id: string) =>
  (
    await one<{ space_id: string | null }>(
      "select space_id from artifacts where id = ?",
      id,
    )
  ).space_id;
const insertArtifact = (id: string, owner: string, spaceId: string | null) =>
  env.DB.prepare(
    "insert into artifacts (id, owner_id, space_id, title, format, visibility, created_at, updated_at) values (?, ?, ?, 't', 'html', 'private', 1, 1)",
  )
    .bind(id, owner, spaceId)
    .run();

let owner: Member;
let ownerCookie: string;
let memberCookie: string;

beforeAll(async () => {
  // An instance owner, as every install has.
  const o = await login(`s4-owner-${tag}@a.com`, "owner");
  ownerCookie = o.cookie;
  owner = (await getUser(env, o.userId)) as Member;
  memberCookie = (await login(`s4-member-${tag}@a.com`)).cookie;
});

describe("migration spaces", () => {
  it("exists, and keeps its backfill, triggers and partial index", () => {
    expect(file).toBeTruthy();
    expect(SPACES_MIGRATION).toMatch(
      /UPDATE `artifacts` SET `space_id` = `owner_id` WHERE `space_id` IS NULL/,
    );
    expect(SPACES_MIGRATION).toMatch(
      /INSERT OR IGNORE INTO `spaces`[\s\S]*FROM `users`/,
    );
    expect(SPACES_MIGRATION).toMatch(
      /CREATE TRIGGER IF NOT EXISTS `users_personal_space`/,
    );
    expect(SPACES_MIGRATION).toMatch(
      /CREATE TRIGGER IF NOT EXISTS `artifacts_space_default`/,
    );
    expect(SPACES_MIGRATION).toMatch(
      /CREATE TRIGGER IF NOT EXISTS `artifacts_space_not_null`/,
    );
    expect(SPACES_MIGRATION).toMatch(
      /CREATE INDEX IF NOT EXISTS `artifacts_space_live_idx` ON `artifacts` \(`space_id`\) WHERE/,
    );
  });

  it("creates the space tables with their keys, defaults and checks", async () => {
    expect((await cols("spaces")).map((c) => c.name)).toEqual([
      "id",
      "kind",
      "name",
      "owner_user_id",
      "all_members_role",
      "public_links",
      "created_at",
      "deleted_at",
    ]);
    // Fail closed for new spaces; the backfill and the trigger set 1 explicitly.
    expect(
      (await cols("spaces")).find((c) => c.name === "public_links"),
    ).toMatchObject({ nn: 1, d: "0" });
    const pk = async (t: string) =>
      (await cols(t)).filter((c) => c.pk > 0).map((c) => c.name);
    expect(await pk("space_members")).toEqual([
      "space_id",
      "user_id",
      "source",
    ]);
    expect(await pk("group_mappings")).toEqual(["space_id", "group_id"]);
    expect(await pk("org_group_mappings")).toEqual(["group_id"]);
    expect(await pk("restricted_groups")).toEqual(["group_id"]);
    expect(await pk("directory_groups")).toEqual(["group_id"]);
    expect(await pk("directory_members")).toEqual(["group_id", "user_id"]);
    expect(await pk("directory_state")).toEqual(["key"]);
    expect(await pk("audit_events")).toEqual(["id"]);
    expect(
      (await cols("directory_groups")).find((c) => c.name === "parent_ids"),
    ).toMatchObject({ nn: 1, d: "'[]'" });
    expect(
      (await cols("audit_events")).find((c) => c.name === "detail"),
    ).toMatchObject({ nn: 1, d: "'{}'" });
  });

  it("adds the P3 columns with their defaults", async () => {
    const users = await cols("users");
    expect(users.find((c) => c.name === "restricted_manual")).toMatchObject({
      nn: 1,
      d: "0",
    });
    expect(users.find((c) => c.name === "restricted_sync")).toMatchObject({
      nn: 1,
      d: "0",
    });
    expect(
      (await cols("identities")).find((c) => c.name === "directory_bound"),
    ).toMatchObject({ nn: 1, d: "0" });
    // Nullable in the DDL (ADD COLUMN cannot add NOT NULL); the trigger below
    // is what makes it required.
    expect(
      (await cols("artifacts")).find((c) => c.name === "space_id"),
    ).toMatchObject({ pk: 0, nn: 0 });
    const idx = await one<{ sql: string }>(
      "select sql from sqlite_master where type = 'index' and name = 'artifacts_space_live_idx'",
    );
    expect(idx.sql).toMatch(/where .*deleted_at.*is null/i);
  });

  it("checks reject a bad space kind, role, source and public_links", async () => {
    const bad = (sql: string, ...binds: unknown[]) =>
      expect(
        env.DB.prepare(sql)
          .bind(...binds)
          .run(),
      ).rejects.toThrow(/CHECK/);
    await bad(
      "insert into spaces (id, kind, name, created_at) values (?, 'company', 'x', 1)",
      `s4-bad-${tag}`,
    );
    const { userId } = await login(`s4-ck-${tag}@a.com`);
    // Role/source checks need a shared space: a personal one refuses members
    // first (the trigger, tested separately below).
    const shared = `s4-shared-${tag}`;
    await env.DB.prepare(
      "insert into spaces (id, kind, name, created_at) values (?, 'shared', 'x', 1)",
    )
      .bind(shared)
      .run();
    await bad(
      "insert into space_members (space_id, user_id, role, source, created_at) values (?, ?, 'owner', 'manual', 1)",
      shared,
      userId,
    );
    await bad(
      "insert into space_members (space_id, user_id, role, source, created_at) values (?, ?, 'viewer', 'google', 1)",
      shared,
      userId,
    );
    // A CHECK on an UPDATE fires per matched row, so this must be the real id.
    await bad("update spaces set public_links = 2 where id = ?", userId);
  });

  it("backfills one personal space per user and space_id = owner_id for every artifact", async () => {
    const { userId } = await login(`s4-early-${tag}@a.com`);
    const r = await api(app, R.artifacts, ownerCookie, {
      method: "POST",
      body: { title: "t", format: "html", content: "<p>x" },
    });
    expect(r.status).toBe(201);
    const { id } = (await r.json()) as { id: string };

    // Invariants over the whole database, not just this test's rows.
    expect(
      await one<{ n: number }>(
        "select count(*) n from artifacts where space_id is null",
      ),
    ).toEqual({ n: 0 });
    expect(
      await one<{ n: number }>(
        "select count(*) n from artifacts a left join spaces s on s.id = a.space_id where s.id is null",
      ),
    ).toEqual({ n: 0 });
    expect(await spaceRow(userId)).toMatchObject({
      id: userId,
      kind: "personal",
      name: `s4-early-${tag}`,
      owner_user_id: userId,
      all_members_role: null,
      public_links: 1,
      deleted_at: null,
    });
    // Today's behaviour, unchanged: the creator's personal space.
    expect(await artifactSpace(id)).toBe(owner.id);
    expect((await api(app, R.artifact(id), ownerCookie)).status).toBe(200);
    expect((await api(app, R.artifact(id), memberCookie)).status).toBe(404);
  });

  it("a user inserted after the migration has a personal space (trigger)", async () => {
    const id = `s4-late-${tag}`;
    await env.DB.prepare(
      "insert into users (id, email, name, role, created_at) values (?, ?, 'Late', 'member', 7)",
    )
      .bind(id, `s4-late-${tag}@x.com`)
      .run();
    expect(await spaceRow(id)).toMatchObject({
      kind: "personal",
      name: "Late",
      owner_user_id: id,
    });
    // The trigger uses the display name when set, else the name, else the email.
    await env.DB.prepare(
      "update users set display_name = 'Chosen' where id = ?",
    )
      .bind(id)
      .run();
    const second = `s4-late2-${tag}`;
    await env.DB.prepare(
      "insert into users (id, email, name, display_name, role, created_at) values (?, ?, 'n', 'Chosen', 'member', 8)",
    )
      .bind(second, `s4-late2-${tag}@x.com`)
      .run();
    expect((await spaceRow(second)).name).toBe("Chosen");
  });

  it("old code inserting without space_id gets the owner's personal space (rollback-safe)", async () => {
    const id = `s4-nosp-${tag}`;
    await insertArtifact(id, owner.id, null);
    expect(await artifactSpace(id)).toBe(owner.id);
    // New code never writes NULL, and the guard refuses it on update.
    await expect(
      env.DB.prepare("update artifacts set space_id = null where id = ?")
        .bind(id)
        .run(),
    ).rejects.toThrow("space_id cannot be null");
  });

  it("a personal space refuses members, group mappings and allMembersRole", async () => {
    const { userId } = await login(`s4-pers-${tag}@a.com`);
    await expect(
      env.DB.prepare(
        "insert into space_members (space_id, user_id, role, source, created_at) values (?, ?, 'viewer', 'manual', 1)",
      )
        .bind(userId, owner.id)
        .run(),
    ).rejects.toThrow("personal spaces have no members");
    await expect(
      env.DB.prepare(
        "insert into group_mappings (space_id, group_id, group_email, role) values (?, 'g1', 'g1@x.com', 'viewer')",
      )
        .bind(userId)
        .run(),
    ).rejects.toThrow("personal spaces have no group mappings");
    await expect(
      env.DB.prepare(
        "update spaces set all_members_role = 'viewer' where id = ?",
      )
        .bind(userId)
        .run(),
    ).rejects.toThrow(/CHECK/);
  });

  it("org_group_mappings holds the Every-space target and checks its role", async () => {
    const id = `s4-org-${tag}`;
    await env.DB.prepare(
      "insert into org_group_mappings (group_id, group_email, role) values (?, 'every@x.com', 'editor')",
    )
      .bind(id)
      .run();
    expect(
      await one("select role from org_group_mappings where group_id = ?", id),
    ).toEqual({ role: "editor" });
    await expect(
      env.DB.prepare(
        "insert into org_group_mappings (group_id, group_email, role) values (?, 'bad@x.com', 'owner')",
      )
        .bind(`${id}-bad`)
        .run(),
    ).rejects.toThrow(/CHECK/);
  });

  it("space_id must name a space", async () => {
    await expect(
      insertArtifact(`s4-fk-${tag}`, owner.id, `s4-missing-${tag}`),
    ).rejects.toThrow(/FOREIGN KEY/);
  });

  it("flag-off removeMember moves nothing and keeps the personal space (parity 1)", async () => {
    const { userId } = await login(`s4-rm-${tag}@a.com`);
    const id = newId();
    await insertArtifact(id, userId, userId);
    await removeMember(env, userId, SYSTEM_ACTOR);
    const row = await one<{ owner_id: string; space_id: string }>(
      "select owner_id, space_id from artifacts where id = ?",
      id,
    );
    expect(row).toEqual({ owner_id: userId, space_id: userId });
    // The personal space stays: a Departed transfer reads from it.
    expect(await spaceRow(userId)).not.toBeNull();
  });
});
