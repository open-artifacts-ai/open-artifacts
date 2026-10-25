// #248: D1 bills rows written (every index entry, and 1 per FTS statement).
// Pins the per-publish costs measured there, after the cuts.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { R } from "@oa/shared";
import { beforeAll, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { authConfig } from "../src/auth/config.js";
import { createPat } from "../src/auth/pat.js";
import {
  publicPrefix,
  signContent,
  signContentPrefix,
} from "../src/content/signing.js";
import { applyGroupDiff } from "../src/directory/apply.js";
import { SyncEngine } from "../src/directory/sync.js";
import { thawFrozenEdits } from "../src/directory/thaw.js";
import type { Env } from "../src/env.js";
import { resetTouchMemo, touchGrant } from "../src/services/agent-usage.js";
import { publish } from "../src/services/artifacts.js";
import { admit } from "../src/services/identity.js";
import { indexVersionOrThrow } from "../src/services/search.js";
import { getUser, getUserWithEpoch } from "../src/services/users.js";
import { contentCall, fakeAssets } from "./assets-stub.js";
import { direct, seedUser, uniq } from "./auth-helpers.js";
import {
  begin,
  DIR_CID,
  directEnv,
  get,
  post,
  resetDirectory,
} from "./directory-helpers.js";
import { fakeDirectory } from "./fixtures/fake-directory.js";
import { api, login } from "./helpers.js";

/** env.DB whose run/batch results add their meta.rows_written to `rows.n`. */
const rows = { n: 0, read: 0 };
const add = (r: D1Result) => {
  rows.n += r.meta.rows_written;
  rows.read += r.meta.rows_read;
  return r;
};
const DB = new Proxy(env.DB, {
  get(t, p) {
    if (p === "batch")
      return async (ss: D1PreparedStatement[]) => (await t.batch(ss)).map(add);
    const v = Reflect.get(t, p);
    return typeof v === "function" ? v.bind(t) : v;
  },
});
const counted = { ...(env as object), DB } as typeof env;
const app = createApp();
const A = {
  fetch: (r: Request, _e: unknown, c: never) => app.fetch(r, counted, c),
};

let cookie: string;
beforeAll(async () => {
  cookie = (await login("rows@x.com")).cookie;
});

it("publish, new version and index alarm write the #248 row counts", async () => {
  const html = (w: string) => `<!doctype html><p>${w} words here</p>`;
  rows.n = 0;
  const r = await api(A as never, R.artifacts, cookie, {
    method: "POST",
    body: { title: "Rows", format: "html", content: html("alpha") },
  });
  expect(r.status).toBe(201);
  const { id } = (await r.json()) as { id: string };
  // artifacts insert 5 (table, pk, 3 live partials incl. artifacts_space_live_idx)
  // + bump 3 + versions 2 + FTS seed 1.
  expect(rows.n).toBe(11);

  rows.n = 0;
  await indexVersionOrThrow(counted, id, 1);
  expect(rows.n).toBe(2); // one FTS write + text_indexed

  rows.n = 0;
  await indexVersionOrThrow(counted, id, 1);
  expect(rows.n).toBe(1); // unchanged text: no FTS write

  rows.n = 0;
  const v = await api(A as never, R.versions(id), cookie, {
    method: "POST",
    body: { format: "html", content: html("beta") },
  });
  expect(v.status).toBe(201);
  expect(rows.n).toBe(5); // bump 3 + versions 2

  rows.n = 0;
  await indexVersionOrThrow(counted, id, 2);
  expect(rows.n).toBe(2);
  const hit = await env.DB.prepare(
    "select body from artifact_search where artifact_id = ?",
  )
    .bind(id)
    .first<{ body: string }>();
  expect(hit?.body).toContain("beta");
});

it("a Google sign-in writes the user touch plus the auth.signin audit row", async () => {
  const sub = `sub-${crypto.randomUUID()}`;
  const email = uniq("rows-signin");
  await seedUser(email, "member", { googleSub: sub });
  rows.n = 0;
  const r = await admit(counted, authConfig(direct()), {
    provider: "google",
    subject: sub,
    email,
    name: "R",
    tenant: "a.com",
  });
  expect(r.ok).toBe(true);
  // users touch 1 + audit_events 2 (table, audit_events_at_idx).
  expect(rows.n).toBe(3);
});

it("spaces API (P3 T9): create, member add, a no-op and a role change", async () => {
  const spacesEnv = {
    ...(counted as object),
    FEATURES: "spaces",
  } as unknown as typeof env;
  const S = {
    fetch: (r: Request, _e: unknown, c: never) => app.fetch(r, spacesEnv, c),
  };
  const admin = await login("rows-space-admin@x.com", "admin");
  const m = await login("rows-space-member@x.com");
  rows.n = 0;
  const r = await api(S as never, R.spaces, admin.cookie, {
    method: "POST",
    body: { name: "Rows" },
  });
  expect(r.status).toBe(201);
  const { id } = (await r.json()) as { id: string };
  // spaces 2 (WITHOUT ROWID table, spaces_kind_name_idx) + audit_events 2
  // (table, audit_events_at_idx).
  expect(rows.n).toBe(4);
  const put = (role: string) =>
    api(S as never, R.spaceMember(id, m.userId), admin.cookie, {
      method: "PUT",
      body: { role },
    });
  rows.n = 0;
  expect((await put("viewer")).status).toBe(200);
  // space_members 2 (table, space_members_user_idx) + audit 2.
  expect(rows.n).toBe(4);
  rows.n = 0;
  await put("viewer");
  // A no-op writes nothing: no audit row, no update.
  expect(rows.n).toBe(0);
  rows.n = 0;
  await put("editor");
  // space_members role update 1 + audit 2.
  expect(rows.n).toBe(3);
});

it("frozen edits (P3 T15): an override records one row; the thaw writes only what it replaces", async () => {
  const frozenEnv = {
    ...(counted as object),
    FEATURES: "spaces,sync_frozen",
  } as unknown as typeof env;
  const S = {
    fetch: (r: Request, _e: unknown, c: never) => app.fetch(r, frozenEnv, c),
  };
  const admin = await login("rows-frozen-admin@x.com", "admin");
  const m = await login("rows-frozen-member@x.com");
  const space = `s-rows-frozen-${crypto.randomUUID()}`;
  const gid = `g-rows-frozen-${crypto.randomUUID()}`;
  await env.DB.batch([
    env.DB.prepare(
      "insert into spaces (id, kind, name, public_links, created_at) values (?, 'shared', ?, 0, ?)",
    ).bind(space, space, Date.now()),
    env.DB.prepare(
      "insert into directory_groups (group_id, email) values (?, ?)",
    ).bind(gid, `${gid}@a.com`),
    env.DB.prepare(
      "insert into group_mappings (space_id, group_id, group_email, role) values (?, ?, ?, 'editor')",
    ).bind(space, gid, `${gid}@a.com`),
    env.DB.prepare(
      "insert into directory_members (group_id, user_id) values (?, ?)",
    ).bind(gid, m.userId),
    env.DB.prepare(
      "insert into space_members (space_id, user_id, role, source, created_at) values (?, ?, 'editor', 'sync', 1)",
    ).bind(space, m.userId),
  ]);
  rows.n = 0;
  const r = await api(
    S as never,
    R.spaceMember(space, m.userId),
    admin.cookie,
    {
      method: "PUT",
      body: { role: "viewer" },
    },
  );
  expect(r.status).toBe(200);
  // audit 2 + frozen_edits 1 + the synced row deleted 1 + the manual row 2
  // (table, user index).
  expect(rows.n).toBe(6);
  rows.n = 0;
  expect(await thawFrozenEdits(counted)).toBe(false);
  // No manual row before the freeze: the manual row deleted 1 + its audit 2
  // + the synced row added 2 + its audit 2 + frozen_edits 1.
  expect(rows.n).toBe(8);
  rows.n = 0;
  await thawFrozenEdits(counted);
  // Nothing left: one read, no batch.
  expect(rows.n).toBe(0);
});

it("spaces API reads (P3 T9): GET /spaces skips personal spaces; a member page decorates only its rows", async () => {
  const spacesEnv = {
    ...(counted as object),
    FEATURES: "spaces",
  } as unknown as typeof env;
  const S = {
    fetch: (r: Request, _e: unknown, c: never) => app.fetch(r, spacesEnv, c),
  };
  const admin = await login("rows-read-admin@x.com", "admin");
  // Many users (personal spaces) a shared-space walk must not read.
  for (let i = 0; i < 30; i++) await login(`rows-read-u${i}@x.com`);
  const r = await api(S as never, R.spaces, admin.cookie, {
    method: "POST",
    body: { name: "Rows read" },
  });
  const { id } = (await r.json()) as { id: string };
  for (let i = 0; i < 5; i++) {
    const m = await login(`rows-read-m${i}@x.com`);
    await api(S as never, R.spaceMember(id, m.userId), admin.cookie, {
      method: "PUT",
      body: { role: "viewer" },
    });
  }
  const spaceCount = (
    await env.DB.prepare(
      "select count(*) n from spaces where kind = 'shared'",
    ).first<{ n: number }>()
  )?.n as number;
  rows.read = 0;
  const list = await api(S as never, `${R.spaces}?limit=200`, admin.cookie);
  expect(list.status).toBe(200);
  // Measured 20: the PK read, the walk over the 2 shared spaces and their
  // counts and roles. A scan of the 36+ personal spaces would read more.
  // (rows_read moves by a few with b-tree layout; random ids.)
  expect(rows.read).toBeLessThanOrEqual(24);
  // Personal space by PK, then the shared walk; never the 36+ personal rows.
  const allSpaces = (
    await env.DB.prepare("select count(*) n from spaces").first<{ n: number }>()
  )?.n as number;
  expect(allSpaces).toBeGreaterThan(spaceCount + 30);
  rows.read = 0;
  const page = await api(
    S as never,
    `${R.spaceMembers(id)}?limit=2`,
    admin.cookie,
  );
  expect(page.status).toBe(200);
  // Measured 37 to 40: the 5-member set and its users twice (page ids,
  // total), then only the 2-row page decorated (roles, groups).
  expect(rows.read).toBeLessThanOrEqual(44);
});

it("agent identity: a token publish adds its counter row; a grant's use writes at most once a minute", async () => {
  const u = await login("rows-agent@x.com");
  const { token } = await createPat(env, u.userId, "rows");
  const r = await api(A as never, R.artifacts, token, {
    method: "POST",
    body: { title: "Rows", format: "markdown", content: "# a" },
  });
  const { id } = (await r.json()) as { id: string };
  rows.n = 0;
  const v = await api(A as never, R.versions(id), token, {
    method: "POST",
    body: { format: "markdown", content: "# b" },
  });
  expect(v.status).toBe(201);
  // bump 3 + versions 2 (agent_via has no index) + tokens counter 1.
  expect(rows.n).toBe(6);

  const grantId = `g-${u.userId}`;
  resetTouchMemo();
  const t0 = Date.now();
  // First use: the agent_grants insert (table, primary key index,
  // agent_grants_user_idx).
  expect(await touchGrant(env, grantId, u.userId, "1.0", t0)).toBe(3);
  resetTouchMemo();
  // Within the minute (memo cleared): the conditional upsert writes nothing.
  expect(await touchGrant(env, grantId, u.userId, "1.0", t0 + 59_000)).toBe(0);
  // Same isolate within the minute: no D1 call at all.
  expect(await touchGrant(env, grantId, u.userId, null, t0 + 59_500)).toBe(0);
  resetTouchMemo();
  // A minute on: one row update.
  expect(await touchGrant(env, grantId, u.userId, null, t0 + 60_000)).toBe(1);
});

it("move and transfer (P3 T10): the row, its index entries and the audit row", async () => {
  const spacesEnv = {
    ...(counted as object),
    FEATURES: "spaces",
  } as unknown as typeof env;
  const S = {
    fetch: (r: Request, _e: unknown, c: never) => app.fetch(r, spacesEnv, c),
  };
  const admin = await login("rows-move-admin@x.com", "admin");
  const u = await login("rows-move-u@x.com");
  const b = await login("rows-move-b@x.com");
  const s = await api(S as never, R.spaces, admin.cookie, {
    method: "POST",
    body: { name: "Rows move" },
  });
  const { id: sid } = (await s.json()) as { id: string };
  await api(S as never, R.spaceMember(sid, u.userId), admin.cookie, {
    method: "PUT",
    body: { role: "editor" },
  });
  const mk = async () => {
    const r = await api(S as never, R.artifacts, u.cookie, {
      method: "POST",
      body: { title: "M", format: "html", content: "<p>m</p>" },
    });
    return ((await r.json()) as { id: string }).id;
  };
  const moved = await mk();
  rows.n = 0;
  const m = await api(S as never, R.moveArtifact(moved), u.cookie, {
    method: "POST",
    body: { spaceId: sid },
  });
  expect(m.status).toBe(200);
  // The artifacts row 1 and its artifacts_space_live_idx entry 2 (out and
  // in), plus audit_events 2 (table, audit_events_at_idx).
  expect(rows.n).toBe(5);
  const given = await mk();
  rows.n = 0;
  const t = await api(S as never, R.transferArtifact(given), u.cookie, {
    method: "POST",
    body: { userId: b.userId },
  });
  expect(t.status).toBe(200);
  // Measured 8: the artifacts row and its owner and space index entries,
  // the editor share (table, shares_email_idx) and audit 2.
  expect(rows.n).toBe(8);
});

it("content host (P3 T11): one statement per file; the bound viewer adds one PK row", async () => {
  // Every statement and the rows it read, through all() (first() has no meta).
  const reads: number[] = [];
  const wrap = (s: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(s, {
      get(t, p) {
        if (p === "bind") return (...a: unknown[]) => wrap(t.bind(...a));
        if (p === "first")
          return async (col?: string) => {
            const r = await t.all<Record<string, unknown>>();
            reads.push(r.meta.rows_read);
            const row = r.results[0] ?? null;
            return col ? (row?.[col] ?? null) : row;
          };
        const v = Reflect.get(t, p);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
  const DB = new Proxy(env.DB, {
    get(t, p) {
      if (p === "prepare") return (q: string) => wrap(t.prepare(q));
      const v = Reflect.get(t, p);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  const u = await login("rows-content@x.com");
  const member = await getUser(env, u.userId);
  if (!member) throw new Error("no user");
  const mk = async (visibility: string) =>
    (
      await publish(
        env,
        member,
        {
          title: "c",
          format: "html",
          entry: "index.html",
          files: { "index.html": "<p>c</p>", "a.css": "x{}" },
          visibility,
        } as never,
        null,
        undefined,
        "create",
      )
    ).id;
  const priv = await mk("private");
  const pub = await mk("public");
  const row = await getUserWithEpoch(env, u.userId);
  const viewer = { uid: u.userId, epoch: row?.sessionEpoch ?? -1 };
  const bound = (
    await signContent(env, priv, 1, Date.now(), 600, "frame", viewer)
  ).prefix;
  const unbound = await signContentPrefix(env, priv, 1);
  const read = async (path: string) => {
    reads.length = 0;
    const r = await contentCall(path, undefined, fakeAssets().fetcher, { DB });
    expect(r.status, path).toBe(200);
    return [...reads];
  };
  // Measured: artifacts PK 1, versions PK 1 on a manifest miss, users PK 1
  // for a uid-bound token. The public-links toggle reads no spaces row.
  expect(await read(`${bound}__view`)).toEqual([3]);
  expect(await read(`${bound}a.css`)).toEqual([2]);
  expect(await read(`${unbound}a.css`)).toEqual([1]);
  expect(await read(`${publicPrefix(pub, 1)}__view`)).toEqual([2]);
  expect(await read(`${publicPrefix(pub, 1)}a.css`)).toEqual([1]);
});

it("directory connect (P3 T12): the pending flow, then binding, sealed token, audit and the initial pass", async () => {
  // Rows written by every statement (run, all, first and batch alike).
  const w = { n: 0 };
  const note = <T extends D1Result>(r: T) => {
    w.n += r.meta.rows_written;
    return r;
  };
  const wrap = (s: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(s, {
      get(t, p) {
        if (p === "bind") return (...a: unknown[]) => wrap(t.bind(...a));
        if (p === "run") return async () => note(await t.run());
        if (p === "all") return async () => note(await t.all());
        if (p === "first")
          return async (col?: string) => {
            const r = note(await t.all<Record<string, unknown>>());
            const row = r.results[0] ?? null;
            return col ? (row?.[col] ?? null) : row;
          };
        const v = Reflect.get(t, p);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
  const DB = new Proxy(env.DB, {
    get(t, p) {
      if (p === "prepare") return (q: string) => wrap(t.prepare(q));
      if (p === "batch")
        return async (ss: D1PreparedStatement[]) =>
          (await t.batch(ss)).map(note);
      const v = Reflect.get(t, p);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  await resetDirectory();
  const g = fakeDirectory();
  const sub = `g-rows-${crypto.randomUUID()}`;
  g.addUser({ id: sub, primaryEmail: uniq("rows-super"), isAdmin: true });
  // One unknown in-domain user: created, with its personal space and identity.
  g.addUser({
    id: `g-rows-new-${crypto.randomUUID()}`,
    primaryEmail: uniq("rows-new"),
  });
  const owner = await login(uniq("rows-dir-owner"), "owner");
  const e = directEnv({ DB } as never);
  w.n = 0;
  const b = await begin(e, owner.cookie);
  expect(b.r.status).toBe(302);
  // directory_state connect.pending 1.
  expect(w.n).toBe(1);
  const code = g.issueCode(b.to?.searchParams.get("code_challenge") as string, {
    sub,
    aud: DIR_CID,
  });
  w.n = 0;
  const r = await get(
    e,
    `${R.directoryCallback}?code=${code}&state=${encodeURIComponent(b.to?.searchParams.get("state") ?? "")}`,
    `${owner.cookie}; ${b.dirCookie}`,
  );
  expect(new URL(r.headers.get("location") ?? "").search).toBe("");
  // Consent only: pending delete 1 + binding 1 + refresh 1 + confirm row 1
  // + audit 2 (table, audit_events_at_idx). No users, identities or spaces.
  expect(w.n).toBe(6);
  w.n = 0;
  const c = await post(e, R.directoryConfirm, owner.cookie);
  expect(c.status).toBe(200);
  // Confirm: the swap (grant.sub 1, binding 1, refresh 1, pending rows
  // deleted 2, confirm row deleted 1) + audit 2 + binding.initial 1, plus 6 per
  // created user (the super admin and the new user): users 2 (table, email
  // unique), personal space 2 (table, spaces_kind_name_idx), identity 2
  // (table, identities_user_provider).
  expect(w.n).toBe(21);

  // P3 T13 DirectorySync, steady state: after the first reconcile, a fast
  // tick with no events writes nothing, and the next hourly reconcile only
  // its lastSuccessAt (the health row).
  const ns = env.DIRECTORY_SYNC as NonNullable<Env["DIRECTORY_SYNC"]>;
  const ds = ns.get(ns.idFromName(`rows-${crypto.randomUUID()}`));
  const drainAt = async (now: number) => {
    for (let i = 0; i < 40; i++) {
      const due = await runInDurableObject(ds, async (_i, s) => {
        const en = new SyncEngine(e, s.storage);
        await en.alarm(now);
        return en.due(now);
      });
      if (!due) return;
    }
    throw new Error("sync never settled");
  };
  const t0 = Date.now();
  await drainAt(t0);
  w.n = 0;
  await drainAt(t0 + 2 * 60_000);
  expect(w.n).toBe(0);
  await drainAt(t0 + 62 * 60_000);
  // directory_state sync.health 1.
  expect(w.n).toBe(1);
  g.restore();
});

it("rows written equal changed rows only (P3 T14 applyGroupDiff)", async () => {
  const SYNC = { kind: "sync", id: null } as const;
  const space = `s-rows-${crypto.randomUUID()}`;
  const [ga, gb] = [
    `g-rows-a-${crypto.randomUUID()}`,
    `g-rows-b-${crypto.randomUUID()}`,
  ];
  await env.DB.batch([
    env.DB.prepare(
      "insert into spaces (id, kind, name, public_links, created_at) values (?, 'shared', ?, 0, ?)",
    ).bind(space, space, Date.now()),
    ...[ga, gb].flatMap((gid) => [
      env.DB.prepare(
        "insert into directory_groups (group_id, email) values (?, ?)",
      ).bind(gid, `${gid}@a.com`),
      env.DB.prepare(
        "insert into group_mappings (space_id, group_id, group_email, role) values (?, ?, ?, ?)",
      ).bind(space, gid, `${gid}@a.com`, gid === ga ? "viewer" : "editor"),
    ]),
  ]);
  const [u, v] = [
    await seedUser(uniq("rows-ga"), "member"),
    await seedUser(uniq("rows-gb"), "member"),
  ];
  rows.n = 0;
  await applyGroupDiff(counted, ga, [u, v], [], SYNC);
  // Per user: directory_members 1 + space_members 2 (table, user index).
  expect(rows.n).toBe(6);
  rows.n = 0;
  await applyGroupDiff(counted, ga, [u, v], [], SYNC);
  // Nothing changed: nothing written.
  expect(rows.n).toBe(0);
  rows.n = 0;
  await applyGroupDiff(counted, gb, [u], [], SYNC);
  // u only: directory_members 1 + the role raised in place 1; v untouched.
  expect(rows.n).toBe(2);
  rows.n = 0;
  await applyGroupDiff(counted, gb, [], [u], SYNC);
  // directory_members 1 + the role lowered in place 1.
  expect(rows.n).toBe(2);
});
