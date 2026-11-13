import { env } from "cloudflare:workers";
import { type Member, newId } from "@oa/shared";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { publicHome } from "../src/routes/shell.js";
import { publish } from "../src/services/artifacts.js";
import { getUser } from "../src/services/users.js";
import { fetchAndWait, login } from "./helpers.js";

const app = createApp();
const ASSETS = { fetch: async () => new Response("spa") } as never;

/** A fresh D1 binding (so a fresh memo) that counts PUBLIC_HOME reads. */
function homeDb() {
  const n = { reads: 0 };
  const DB = new Proxy(env.DB, {
    get(t, k) {
      if (k === "prepare")
        return (sql: string) => {
          if (sql.includes("from artifacts where id = ?")) n.reads++;
          return t.prepare(sql);
        };
      const v = Reflect.get(t, k);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  return { DB, n };
}

const get = (
  path: string,
  home: string | undefined,
  o: { cookie?: string; method?: string; DB?: unknown } = {},
) =>
  fetchAndWait(
    app,
    new Request(`http://app.localhost${path}`, {
      method: o.method ?? "GET",
      headers: o.cookie ? { cookie: o.cookie } : {},
    }),
    {
      ...(env as object),
      ASSETS,
      DB: o.DB ?? homeDb().DB,
      PUBLIC_HOME: home,
    },
  );

let owner: Member;
let cookie: string;
beforeAll(async () => {
  const l = await login(`ph-${newId().slice(0, 6).toLowerCase()}@x.com`);
  cookie = l.cookie;
  const m = await getUser(env, l.userId);
  if (!m) throw new Error("no user");
  owner = m;
});
const mk = async (visibility: string) =>
  (
    await publish(
      env,
      owner,
      { title: "Home", visibility, format: "markdown", content: "x" } as never,
      null,
      undefined,
      "create",
    )
  ).id;

afterEach(() => vi.restoreAllMocks());

const expectShell = async (r: Response) => {
  expect(r.status).toBe(200);
  expect(r.headers.get("location")).toBeNull();
  expect(await r.text()).toBe("spa");
};

describe("PUBLIC_HOME", () => {
  it("unset or empty: / is unchanged", async () => {
    await expectShell(await get("/", undefined));
    await expectShell(await get("/", ""));
  });

  it("public + logged out: 302 to /a/<id>/full, no-store", async () => {
    const id = await mk("public");
    const r = await get("/", id);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe(`/a/${id}/full`);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const h = await get("/", id, { method: "HEAD" });
    expect(h.status).toBe(302);
    expect(h.headers.get("location")).toBe(`/a/${id}/full`);
  });

  it("an invalid session cookie counts as logged out", async () => {
    const id = await mk("public");
    const r = await get("/", id, {
      cookie: `${cookie.split("=")[0]}=forged.sig`,
    });
    expect(r.status).toBe(302);
  });

  it("logged in: the dashboard, no D1 read", async () => {
    const id = await mk("public");
    const { DB, n } = homeDb();
    await expectShell(await get("/", id, { cookie, DB }));
    const h = await get("/", id, { cookie, DB, method: "HEAD" });
    expect(h.status).toBe(200);
    expect(h.headers.get("location")).toBeNull();
    expect(n.reads).toBe(0);
  });

  it("private: unchanged and logged", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const id = await mk("private");
    await expectShell(await get("/", id));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(id));
  });

  it("deleted or missing: unchanged", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const gone = await mk("public");
    await env.DB.prepare("update artifacts set deleted_at = 1 where id = ?")
      .bind(gone)
      .run();
    await expectShell(await get("/", gone));
    await expectShell(await get("/", newId()));
  });

  it("invalid id: unchanged, no D1 read, logged once per isolate", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { DB, n } = homeDb();
    await expectShell(await get("/", "not an id!", { DB }));
    await expectShell(await get("/", "not an id!", { DB }));
    expect(n.reads).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("other paths are unaffected", async () => {
    const id = await mk("public");
    const { DB, n } = homeDb();
    for (const p of ["/library", "/search", "//", "/index.html"])
      await expectShell(await get(p, id, { DB }));
    expect(n.reads).toBe(0);
    const q = await get("/?ref=1", id);
    expect(q.status).toBe(302);
  });

  it("memoizes for 60 s per isolate", async () => {
    const id = await mk("public");
    const { DB, n } = homeDb();
    const e = { ...(env as object), DB, PUBLIC_HOME: id } as never;
    expect(await publicHome(e, 1_000)).toBe(`/a/${id}/full`);
    await env.DB.prepare(
      "update artifacts set visibility = 'private' where id = ?",
    )
      .bind(id)
      .run();
    expect(await publicHome(e, 60_999)).toBe(`/a/${id}/full`);
    expect(n.reads).toBe(1);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await publicHome(e, 61_000)).toBeNull();
    expect(n.reads).toBe(2);
  });

  it("many logged-out requests within 60 s do one D1 read", async () => {
    const id = await mk("public");
    const { DB, n } = homeDb();
    for (let i = 0; i < 5; i++)
      expect((await get("/", id, { DB })).status).toBe(302);
    expect(n.reads).toBe(1);
  });
});
