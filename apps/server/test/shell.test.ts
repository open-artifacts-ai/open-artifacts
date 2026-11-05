import { env } from "cloudflare:workers";
import { type Member, newId, viewerPath } from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { instanceMeta } from "../src/routes/shell.js";
import { publish } from "../src/services/artifacts.js";
import { getUser } from "../src/services/users.js";
import { fakeAssets } from "./assets-stub.js";
import { fetchAndWait, login } from "./helpers.js";

const app = createApp();
const INDEX = `<!doctype html><html><head><title>Old</title></head><body><div id="root"></div></body></html>`;
const assets = fakeAssets({
  "/index.html": { body: INDEX, type: "text/html" },
}).fetcher;
const get = (path: string, extra: object = {}) =>
  fetchAndWait(app, new Request(`http://app.localhost${path}`), {
    ...(env as object),
    ASSETS: assets,
    ...extra,
  });
const setName = (name: string) =>
  env.DB.prepare(
    "insert or replace into settings (key, value) values ('name', ?)",
  )
    .bind(name)
    .run();
/**
 * A fresh D1 binding (so a fresh instance-name memo) that counts settings
 * reads; with `fail`, those reads throw.
 */
function settingsDb(fail = false) {
  const n = { reads: 0 };
  const DB = new Proxy(env.DB, {
    get(t, k) {
      if (k === "prepare")
        return (sql: string) => {
          const st = t.prepare(sql);
          if (!sql.includes("from settings")) return st;
          return new Proxy(st, {
            get(s, j) {
              if (j === "all")
                return () => {
                  n.reads++;
                  if (fail) throw new Error("d1 down");
                  return s.all();
                };
              const v = Reflect.get(s, j);
              return typeof v === "function" ? v.bind(s) : v;
            },
          });
        };
      const v = Reflect.get(t, k);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  return { DB, n };
}
const metas = (t: string) => t.match(/<meta name="oa-instance"[^>]*>/g) ?? [];

let owner: Member;
beforeAll(async () => {
  const l = await login(`sh-${newId().slice(0, 6).toLowerCase()}@x.com`);
  const m = await getUser(env, l.userId);
  if (!m) throw new Error("no user");
  owner = m;
});
const mk = async (visibility: string, title: string, description: string) =>
  (
    await publish(
      env,
      owner,
      {
        title,
        description,
        visibility,
        format: "markdown",
        content: "x",
      } as never,
      null,
      undefined,
      "create",
    )
  ).id;

describe("OG shell", () => {
  it("public artifact gets title and og tags", async () => {
    const id = await mk("public", 'Roadmap <b>"Q3"</b>', "Plan & more");
    const r = await get(viewerPath(id));
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const t = await r.text();
    expect(t).toContain("&lt;b&gt;");
    expect(t).not.toContain("<b>");
    expect(t).toContain("&quot;Q3&quot;");
    expect(t).toContain('property="og:title"');
    expect(t).toContain('property="og:type" content="website"');
    expect(t).toContain(`content="http://app.localhost${viewerPath(id)}"`);
    expect(t).toContain("Plan &amp; more");
    expect(t).toContain("· Open Artifacts</title>");
    expect(t).toContain(
      '<link rel="preconnect" href="http://content.localhost">',
    );
    const v = await (await get(viewerPath(id, 1))).text();
    expect(v).toContain('property="og:title"');
  });

  it("private, missing and deleted ids are byte-identical and leak nothing", async () => {
    const priv = await mk("private", "SecretTitleXyz", "SecretDescXyz");
    const gone = await mk("public", "GoneTitleXyz", "GoneDescXyz");
    await env.DB.prepare("update artifacts set deleted_at = 1 where id = ?")
      .bind(gone)
      .run();
    const a = await (await get(viewerPath(priv))).text();
    const b = await (await get(viewerPath(newId()))).text();
    const c = await (await get(viewerPath(gone))).text();
    expect(a).toBe(b);
    expect(a).toBe(c);
    expect(a).toContain("<title>Open Artifacts</title>");
    expect(a).toContain(
      '<link rel="preconnect" href="http://content.localhost">',
    );
    expect(a).not.toContain("og:");
    expect(a).not.toContain("SecretTitleXyz");
    expect(a).not.toContain("SecretDescXyz");
  });

  it("/a/:id/full serves the same shell, headers and canonical og:url", async () => {
    const id = await mk("public", "FullTitle", "FullDesc");
    const [a, f] = await Promise.all([
      get(viewerPath(id)),
      get(`${viewerPath(id)}/full`),
    ]);
    expect(f.status).toBe(200);
    for (const h of [
      "cache-control",
      "x-robots-tag",
      "content-security-policy",
    ])
      expect(f.headers.get(h)).toBe(a.headers.get(h));
    expect(await f.text()).toBe(await a.text());
    const priv = await mk("private", "SecretFullXyz", "D");
    const p = await (await get(`${viewerPath(priv)}/full`)).text();
    expect(p).toBe(await (await get(viewerPath(newId()))).text());
    expect(p).not.toContain("SecretFullXyz");
  });

  it("other /a/ paths fall through to the SPA", async () => {
    const id = await mk("public", "T", "D");
    const t = await (await get(`/a/${id}/diff/1/2`)).text();
    expect(t.replace(/<meta name="oa-instance"[^>]*>/, "")).toBe(INDEX);
  });
});

describe("instance meta", () => {
  it("signed-out shell routes carry exactly one instance meta", async () => {
    await setName("Acme Docs");
    const id = await mk("public", "T", "D");
    const { DB } = settingsDb();
    for (const p of ["/", "/library", viewerPath(id), viewerPath(newId())]) {
      const r = await get(p, { DB });
      expect(r.status).toBe(200);
      const t = await r.text();
      expect(metas(t)).toEqual([
        '<meta name="oa-instance" content="Acme Docs">',
      ]);
      expect(t).toMatch(/<head>.*oa-instance.*<\/head>/);
    }
  });

  it("memoizes the name for 60 s per isolate", async () => {
    const { DB, n } = settingsDb();
    const e = { ...(env as object), DB } as never;
    await setName("Memo One");
    expect(await instanceMeta(e, 1_000)).toContain('content="Memo One"');
    await setName("Memo Two");
    expect(await instanceMeta(e, 60_999)).toContain('content="Memo One"');
    expect(n.reads).toBe(1);
    expect(await instanceMeta(e, 61_000)).toContain('content="Memo Two"');
    expect(n.reads).toBe(2);
  });

  it("two shell loads within 60 s do one settings read", async () => {
    const { DB, n } = settingsDb();
    await get("/", { DB });
    await get(viewerPath(newId()), { DB });
    expect(n.reads).toBe(1);
  });

  it("escapes the name", async () => {
    await setName('Evil"><script>alert(1)</script> & co');
    const { DB } = settingsDb();
    for (const p of ["/", viewerPath(newId())]) {
      const t = await (await get(p, { DB })).text();
      expect(t).not.toContain("<script>");
      expect(metas(t)).toEqual([
        '<meta name="oa-instance" content="Evil&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt; &amp; co">',
      ]);
    }
  });

  it("a failed settings read serves the shell without the meta", async () => {
    // Only the settings read fails (the /a/:id OG read still works).
    const { DB, n } = settingsDb(true);
    for (const p of ["/", "/library", viewerPath(newId())]) {
      const r = await get(p, { DB });
      expect(r.status).toBe(200);
      const t = await r.text();
      expect(t).toContain('<div id="root">');
      expect(metas(t)).toEqual([]);
    }
    expect(n.reads).toBe(3); // failures are not memoized
  });

  it("static assets are untouched", async () => {
    const files = fakeAssets({
      "/index.html": { body: INDEX, type: "text/html" },
      "/assets/app.js": { body: "/*js*/", type: "text/javascript" },
      "/favicon.svg": { body: "<svg/>", type: "image/svg+xml" },
    }).fetcher;
    for (const p of ["/assets/app.js", "/assets/missing.js", "/favicon.svg"]) {
      const r = await get(p, { ASSETS: files });
      expect(r.headers.get("etag")).toBe('"e1"');
      expect(metas(await r.text())).toEqual([]);
    }
  });
});
