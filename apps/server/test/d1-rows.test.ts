// #248: D1 bills rows written (every index entry, and 1 per FTS statement).
// Pins the per-publish costs measured there, after the cuts.
import { env } from "cloudflare:workers";
import { R } from "@oa/shared";
import { beforeAll, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { authConfig } from "../src/auth/config.js";
import { createPat } from "../src/auth/pat.js";
import { resetTouchMemo, touchGrant } from "../src/services/agent-usage.js";
import { admit } from "../src/services/identity.js";
import { indexVersionOrThrow } from "../src/services/search.js";
import { direct, seedUser, uniq } from "./auth-helpers.js";
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
  // First use: the agent_grants insert (table + its primary key index).
  expect(await touchGrant(env, grantId, u.userId, "1.0", t0)).toBe(2);
  resetTouchMemo();
  // Within the minute (memo cleared): the conditional upsert writes nothing.
  expect(await touchGrant(env, grantId, u.userId, "1.0", t0 + 59_000)).toBe(0);
  // Same isolate within the minute: no D1 call at all.
  expect(await touchGrant(env, grantId, u.userId, null, t0 + 59_500)).toBe(0);
  resetTouchMemo();
  // A minute on: one row update.
  expect(await touchGrant(env, grantId, u.userId, null, t0 + 60_000)).toBe(1);
});
