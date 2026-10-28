// Byte-level snapshots of the list, me and search JSON (perf refactors of
// these paths must not change a byte). Ids, timestamps, emails' random tag
// and cursors are replaced by stable placeholders; key order, spacing and
// every other byte are compared as-is. Bodies repeat the tag a different
// number of times so bm25 never ties (ties order by random ids).
import { env } from "cloudflare:workers";
import {
  ArtifactSummarySchema,
  DataCountSchema,
  DataResetResultSchema,
  newId,
  PageSchema,
  R,
  SearchHitSchema,
} from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createPat } from "../src/auth/pat.js";
import { publish, softDelete } from "../src/services/artifacts.js";
import { putShare } from "../src/services/shares.js";
import { getUser } from "../src/services/users.js";
import { VERSION } from "../src/version.gen.js";
import { api, login, runIndex } from "./helpers.js";

const app = createApp();
// Letters only: FTS tokens and emails stay one word.
const tag = newId()
  .replace(/[^a-zA-Z]/g, "")
  .toLowerCase()
  .slice(0, 8)
  .padEnd(8, "z");
const agent = `snap-${tag}`;

type U = { cookie: string; userId: string };
let a: U;
let b: U;
let pat: string;
const ids: string[] = [];

/** Stable text: known ids → <ID n>, ISO times → <TS>, the tag → <TAG>, cursors → <CURSOR>. */
function norm(text: string): string {
  let s = text;
  [a.userId, b.userId, ...ids].forEach((id, i) => {
    s = s.split(id).join(`<ID${i}>`);
  });
  return s
    .split(tag)
    .join("<TAG>")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "<TS>")
    .replace(/"nextCursor":"[^"]+"/g, '"nextCursor":"<CURSOR>"');
}

const get = async (path: string, auth: string) => {
  const r = await api(app, path, auth);
  expect(r.status).toBe(200);
  expect(r.headers.get("content-type")).toBe("application/json");
  return r.text();
};

beforeAll(async () => {
  a = await login(`snap-a-${tag}@x.com`, "member");
  b = await login(`snap-b-${tag}@x.com`, "member");
  const ua = await getUser(env, a.userId);
  const ub = await getUser(env, b.userId);
  if (!ua || !ub) throw new Error("no users");
  pat = (await createPat(env, b.userId, "snap pat")).token;
  const pub = async (
    u: typeof ua,
    input: Record<string, unknown>,
    v?: string,
  ) => {
    const r = await publish(env, u, input as never, {
      name: agent,
      version: v ?? null,
    });
    ids.push(r.id);
    await runIndex(r.id);
    return r.id;
  };
  const a1 = await pub(ua, {
    title: `Private ${tag} "quoted" & <b>`,
    description: `desc ${tag}`,
    format: "html",
    content: `<p>alpha ${tag} body</p>`,
    capabilities: { db: true },
  });
  await putShare(env, ua, a1, { email: `snap-b-${tag}@x.com`, role: "viewer" });
  const a2 = await pub(ua, {
    title: `Team ${tag}`,
    format: "markdown",
    content: `# team ${tag}\n\nbeta ${tag} ${tag}`,
    visibility: "team",
    allowAnonymousWrites: true,
  });
  await env.DB.prepare("update artifacts set has_thumbnail = 1 where id = ?")
    .bind(a2)
    .run();
  const a3 = await pub(ua, {
    title: `Edit ${tag}`,
    format: "code",
    entry: "main.py",
    content: `print("${tag} ${tag} ${tag} ${tag}")`,
  });
  await putShare(env, ua, a3, { email: `snap-b-${tag}@x.com`, role: "editor" });
  await pub(
    ub,
    {
      title: `Mine ${tag}`,
      format: "markdown",
      content: `gamma ${`${tag} `.repeat(7)}`,
    },
    "1.2.3",
  );
  const b2 = await pub(ub, {
    title: `Gone ${tag}`,
    format: "markdown",
    content: `delta ${tag}`,
  });
  await softDelete(env, ub, b2);
});

describe("JSON shapes (byte snapshots)", () => {
  it("list: pages, includeDeleted, cookie and PAT", async () => {
    const q = `${R.artifacts}?agent=${agent}`;
    const p1 = await get(`${q}&limit=2`, b.cookie);
    const cursor = (JSON.parse(p1) as { nextCursor: string }).nextCursor;
    const p2 = await get(
      `${q}&limit=2&cursor=${encodeURIComponent(cursor)}`,
      b.cookie,
    );
    const all = await get(`${q}&includeDeleted=true`, b.cookie);
    expect(await get(q, pat)).toBe(await get(q, b.cookie));
    expect(norm(p1)).toMatchSnapshot("page 1");
    expect(norm(p2)).toMatchSnapshot("page 2");
    expect(norm(all)).toMatchSnapshot("with deleted");
  });

  it("healthz: public, then oauthStore", async () => {
    const r = await app.request("http://app.localhost/healthz", {}, env);
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(body).toBe(
      `{"ok":true,"plan":"free","version":"${VERSION}","oauthStore":{"mode":"kv","backfilled":false,"kvWritesOffSince":null}}`,
    );
    expect(body.replace(VERSION, "<VERSION>")).toMatchSnapshot("healthz");
  });

  it("usage: plan before date (no analytics token in tests)", async () => {
    const admin = await login(`snap-u-${tag}@x.com`, "admin");
    const body = await get(R.usage, admin.cookie);
    expect(body.replace(/\d{4}-\d{2}-\d{2}/, "<DATE>")).toMatchSnapshot(
      "usage",
    );
  });

  it("me: cookie and PAT", async () => {
    expect(norm(await get(R.me, a.cookie))).toMatchSnapshot("me a");
    expect(norm(await get(R.me, pat))).toMatchSnapshot("me b pat");
  });

  it("responses equal their schema's parse, byte for byte", async () => {
    // Response schemas are not applied in production: pin that the built
    // JSON is exactly what parsing it would produce (keys, order, values).
    const hits = await get(`${R.search}?q=${tag}`, b.cookie);
    expect(
      JSON.stringify(PageSchema(SearchHitSchema).parse(JSON.parse(hits))),
    ).toBe(hits);
    const list = await get(
      `${R.artifacts}?agent=${agent}&includeDeleted=true`,
      b.cookie,
    );
    expect(
      JSON.stringify(PageSchema(ArtifactSummarySchema).parse(JSON.parse(list))),
    ).toBe(list);
  });

  it("data reset: result, equal to its schema's parse", async () => {
    const r = await api(app, R.dataReset(ids[0] ?? ""), a.cookie, {
      method: "PUT",
      body: { collections: { c: { d: { n: 1 }, e: [2] }, f: {} } },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/json");
    const body = await r.text();
    expect(JSON.stringify(DataResetResultSchema.parse(JSON.parse(body)))).toBe(
      body,
    );
    expect(norm(body)).toMatchSnapshot("data reset");
  });

  it("data count: equal to its schema's parse", async () => {
    const body = await get(R.dataCount(ids[0] ?? "", "c"), b.cookie);
    expect(JSON.stringify(DataCountSchema.parse(JSON.parse(body)))).toBe(body);
    expect(norm(body)).toMatchSnapshot("data count");
  });

  it("search: hits with snippets, pages", async () => {
    const q = `${R.search}?q=${tag}`;
    expect(norm(await get(q, b.cookie))).toMatchSnapshot("search b");
    expect(norm(await get(`${q}&limit=1`, b.cookie))).toMatchSnapshot(
      "search b limit 1",
    );
    expect(
      norm(await get(`${R.search}?q=alpha%20${tag}`, a.cookie)),
    ).toMatchSnapshot("search a owner");
  });
});
