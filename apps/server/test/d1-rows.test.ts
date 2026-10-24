// #248: D1 bills rows written (every index entry, and 1 per FTS statement).
// Pins the per-publish costs measured there, after the cuts.
import { env } from "cloudflare:workers";
import { R } from "@oa/shared";
import { beforeAll, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { authConfig } from "../src/auth/config.js";
import { admit } from "../src/services/identity.js";
import { indexVersionOrThrow } from "../src/services/search.js";
import { direct, seedUser, uniq } from "./auth-helpers.js";
import { api, login } from "./helpers.js";

/** env.DB whose run/batch results add their meta.rows_written to `rows.n`. */
const rows = { n: 0 };
const add = (r: D1Result) => {
  rows.n += r.meta.rows_written;
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
  // spaces 1 (WITHOUT ROWID) + audit_events 2 (table, audit_events_at_idx).
  expect(rows.n).toBe(3);
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
