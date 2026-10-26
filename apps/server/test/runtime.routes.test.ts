import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  DataCountSchema,
  DataDocSchema,
  LIMITS,
  type Member,
  newId,
  PageSchema,
  R,
  StorageEntrySchema,
  StorageKeySchema,
} from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { type ArtifactRuntime, runtimeStub } from "../src/runtime/do.js";
import { ipKey } from "../src/runtime/routes.js";
import { publish } from "../src/services/artifacts.js";
import { getUser } from "../src/services/users.js";
import { api, errOf, login } from "./helpers.js";

const app = createApp();
const tag = newId().slice(0, 6).toLowerCase();
type U = { cookie: string; userId: string; member: Member; email: string };
let owner: U;
let viewer: U;
let guest: U;

async function mk(prefix: string, role: Member["role"]): Promise<U> {
  const email = `${prefix}-${tag}@x.com`;
  const l = await login(email, role);
  const m = await getUser(env, l.userId);
  if (!m) throw new Error("no user");
  return { ...l, member: m, email };
}

const ALL = { db: true, viewer: true, storage: true };
const pub = async (extra: Record<string, unknown> = {}) =>
  (
    await publish(
      env,
      owner.member,
      {
        title: "live",
        format: "html",
        content: "<p>hi</p>",
        capabilities: ALL,
        ...extra,
      } as never,
      null,
      undefined,
      "create",
    )
  ).id;

const ctx = { waitUntil() {}, passThroughOnException() {} } as never;

/** Runs `cb` inside the artifact's runtime DO (e.g. to pin its clock). */
const inDo = (id: string, cb: (i: ArtifactRuntime) => void) =>
  runInDurableObject(
    runtimeStub(env, id) as unknown as DurableObjectStub<ArtifactRuntime>,
    cb,
  );
let ipSeq = 0;
/** A TEST-NET-2 address unique to this run and call. */
const uniqueIp = () =>
  `198.51.${Math.floor(Math.random() * 256)}.${(++ipSeq % 254) + 1}`;
type Limiter = { limit(o: { key: string }): Promise<{ success: boolean }> };

/** Anonymous request from `ip` (none when null), with an optional RL_ANON stub. */
function anon(
  path: string,
  init: { method?: string; body?: unknown } = {},
  ip: string | null = "203.0.113.7",
  rl?: Limiter,
) {
  const headers: Record<string, string> = {};
  if (ip) headers["cf-connecting-ip"] = ip;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  return app.fetch(
    new Request(`http://app.localhost${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
    rl ? { ...env, RL_ANON: rl } : env,
    ctx,
  );
}

const put = (id: string, u: U | null, doc: string, body: unknown) =>
  u
    ? api(app, R.dataDoc(id, "c", doc), u.cookie, { method: "PUT", body })
    : anon(R.dataDoc(id, "c", doc), { method: "PUT", body });

beforeAll(async () => {
  owner = await mk("rt-owner", "member");
  viewer = await mk("rt-viewer", "member");
  guest = await mk("rt-guest", "guest");
});

describe("capabilities", () => {
  it("db.set without capabilities.db → 403 capability_denied", async () => {
    const id = await pub({ capabilities: { db: false, storage: true } });
    const r = await put(id, owner, "a", { n: 1 });
    expect(r.status).toBe(403);
    expect((await errOf(r)).code).toBe("capability_denied");
    const g = await api(app, R.dataCollection(id, "c"), owner.cookie);
    expect(g.status).toBe(403);
  });

  it("storage without capabilities.storage → 403; invisible artifact → 404 first", async () => {
    const id = await pub({ capabilities: { db: true } });
    const r = await api(app, R.storageKey(id, "k"), owner.cookie);
    expect(r.status).toBe(403);
    expect((await errOf(r)).code).toBe("capability_denied");
    // A caller with no access never learns about capabilities.
    const priv = await pub({ capabilities: { db: false } });
    const g = await put(priv, guest, "a", 1);
    expect(g.status).toBe(404);
    expect((await errOf(g)).code).toBe("not_found");
  });
});

describe("data routes", () => {
  it("round trip for a signed-in viewer, attributed u:{id}", async () => {
    const id = await pub({ visibility: "team" });
    const s = await put(id, viewer, "a", { n: 1 });
    expect(s.status).toBe(200);
    expect(DataDocSchema.parse(await s.json())).toMatchObject({
      id: "a",
      data: { n: 1 },
      updatedBy: `u:${viewer.userId}`,
    });
    const g = await api(app, R.dataDoc(id, "c", "a"), viewer.cookie);
    expect(g.status).toBe(200);
    expect(((await g.json()) as { data: unknown }).data).toEqual({ n: 1 });
    const p = await api(app, R.dataDoc(id, "c", "a"), owner.cookie, {
      method: "PATCH",
      body: { m: 2 },
    });
    expect(((await p.json()) as { data: unknown }).data).toEqual({
      n: 1,
      m: 2,
    });
    const l = await api(
      app,
      `${R.dataCollection(id, "c")}?limit=1`,
      viewer.cookie,
    );
    const page = PageSchema(DataDocSchema).parse(await l.json());
    expect(page.items.map((d) => d.id)).toEqual(["a"]);
    const q = await api(app, R.dataQuery(id, "c"), viewer.cookie, {
      method: "POST",
      body: { where: { m: 2 } },
    });
    expect(q.status).toBe(200);
    expect(PageSchema(DataDocSchema).parse(await q.json()).items).toHaveLength(
      1,
    );
    const d = await api(app, R.dataDoc(id, "c", "a"), viewer.cookie, {
      method: "DELETE",
    });
    expect(d.status).toBe(204);
    const gone = await api(app, R.dataDoc(id, "c", "a"), viewer.cookie);
    expect(gone.status).toBe(404);
  });

  it("validates names, bodies and list params", async () => {
    const id = await pub({ visibility: "team" });
    const bad = await api(app, R.dataDoc(id, "c", "a b"), viewer.cookie, {
      method: "PUT",
      body: 1,
    });
    expect(bad.status).toBe(400);
    const patch = await api(app, R.dataDoc(id, "c", "a"), viewer.cookie, {
      method: "PATCH",
      body: [1],
    });
    expect(patch.status).toBe(400);
    const lim = await api(
      app,
      `${R.dataCollection(id, "c")}?limit=0`,
      viewer.cookie,
    );
    expect(lim.status).toBe(400);
    const q = await api(app, R.dataQuery(id, "c"), viewer.cookie, {
      method: "POST",
      body: { nope: 1 },
    });
    expect(q.status).toBe(400);
  });

  it("cookie writes need X-OA-Request (CSRF)", async () => {
    const id = await pub({ visibility: "team" });
    const r = await api(app, R.dataDoc(id, "c", "a"), viewer.cookie, {
      method: "PUT",
      body: 1,
      headers: { "x-oa-request": "0" },
    });
    expect(r.status).toBe(403);
    expect((await errOf(r)).code).toBe("csrf");
  });
});

describe("anonymous access", () => {
  it("reads and writes a public artifact (dataWriters viewers, the default)", async () => {
    const id = await pub({ visibility: "public" });
    await put(id, owner, "a", { v: 1 });
    const g = await anon(R.dataCollection(id, "c"));
    expect(g.status).toBe(200);
    expect(PageSchema(DataDocSchema).parse(await g.json()).items).toHaveLength(
      1,
    );
    expect((await anon(R.dataDoc(id, "c", "a"))).status).toBe(200);
    expect((await put(id, null, "b", 1)).status).toBe(200);
  });

  // #681: a write refused by dataWriters "editors" is 403
  // data_editors_only, for anonymous and signed-in viewers alike (never 401).
  it('dataWriters "editors": anonymous and viewer writes → 403 data_editors_only', async () => {
    const id = await pub({ visibility: "public", dataWriters: "editors" });
    expect((await put(id, owner, "a", { v: 1 })).status).toBe(200);
    const anonWrites = [
      await put(id, null, "b", 1),
      await anon(R.dataDoc(id, "c", "a"), { method: "PATCH", body: { v: 2 } }),
      await anon(R.dataDoc(id, "c", "a"), { method: "DELETE" }),
    ];
    for (const r of anonWrites) {
      expect(r.status).toBe(403);
      expect((await errOf(r)).code).toBe("data_editors_only");
    }
    // A signed-in viewer (public link, or a Viewer share) is refused alike.
    for (const u of [viewer, guest]) {
      const r = await put(id, u, "c", 1);
      expect(r.status).toBe(403);
      expect((await errOf(r)).code).toBe("data_editors_only");
    }
    const share = await api(app, R.shares(id), owner.cookie, {
      method: "PUT",
      body: { email: viewer.email, role: "viewer" },
    });
    expect(share.status).toBe(200);
    const v = await put(id, viewer, "c", 1);
    expect(v.status).toBe(403);
    expect((await errOf(v)).code).toBe("data_editors_only");
    // An Editor share writes.
    await api(app, R.shares(id), owner.cookie, {
      method: "PUT",
      body: { email: viewer.email, role: "editor" },
    });
    expect((await put(id, viewer, "c", 1)).status).toBe(200);
    // Reads stay open; no anonymous id is issued.
    expect((await anon(R.dataDoc(id, "c", "a"))).status).toBe(200);
    expect((await anon(R.anonId(id))).status).toBe(401);
  });

  it('dataWriters "editors" at every visibility', async () => {
    for (const visibility of ["private", "team"] as const) {
      const id = await pub({ visibility, dataWriters: "editors" });
      await api(app, R.shares(id), owner.cookie, {
        method: "PUT",
        body: { email: guest.email, role: "viewer" },
      });
      const r = await put(id, guest, "a", 1);
      expect(r.status, visibility).toBe(403);
      expect((await errOf(r)).code, visibility).toBe("data_editors_only");
      if (visibility === "team") {
        const t = await put(id, viewer, "a", 1);
        expect((await errOf(t)).code).toBe("data_editors_only");
      }
      expect((await put(id, owner, "a", 1)).status, visibility).toBe(200);
    }
  });

  it("other refusals keep their codes", async () => {
    // No db declared: capability_denied, whatever dataWriters says.
    for (const dataWriters of ["viewers", "editors"]) {
      const noDb = await pub({
        visibility: "public",
        dataWriters,
        capabilities: { db: false, viewer: true, storage: true },
      });
      for (const u of [null, viewer]) {
        const w = await put(noDb, u, "a", 1);
        expect(w.status, dataWriters).toBe(403);
        expect((await errOf(w)).code, dataWriters).toBe("capability_denied");
      }
    }
    // Storage is signed-in only, whatever dataWriters says.
    for (const dataWriters of ["viewers", "editors"]) {
      const id = await pub({ visibility: "public", dataWriters });
      const s = await anon(R.storageKey(id, "k"), { method: "PUT", body: 1 });
      expect(s.status).toBe(401);
      expect((await errOf(s)).code).toBe("unauthorized");
    }
    // No access is still 404.
    const priv = await pub({ dataWriters: "editors" });
    expect((await put(priv, viewer, "a", 1)).status).toBe(404);
    expect((await put(priv, null, "a", 1)).status).toBe(404);
  });

  it("private artifact → 404 for anonymous reads and writes", async () => {
    const id = await pub({ allowAnonymousWrites: true });
    expect((await anon(R.dataCollection(id, "c"))).status).toBe(404);
    expect((await put(id, null, "a", 1)).status).toBe(404);
  });

  it('allowAnonymousWrites: updatedBy "anon:{short}" (ip:{ip} rate key); the 31st write per minute → 429', async () => {
    const id = await pub({ visibility: "public", allowAnonymousWrites: true });
    // Deterministic: the DO's minute window is pinned (no rollover mid-test),
    // and the RL_ANON stub counts per key for this test only (no wall clock).
    await inDo(id, (i) => {
      i.now = () => Date.UTC(2026, 0, 1, 12, 0, 30);
    });
    const counts = new Map<string, number>();
    const rl: Limiter = {
      async limit({ key }) {
        const n = (counts.get(key) ?? 0) + 1;
        counts.set(key, n);
        return { success: n <= LIMITS.anonWritesPerMinPerIp };
      },
    };
    const ip = uniqueIp();
    const write = (doc: string, from: string, limiter?: Limiter) =>
      anon(R.dataDoc(id, "c", doc), { method: "PUT", body: 1 }, from, limiter);
    for (let i = 0; i < 30; i++) {
      const r = await write(`d${i}`, ip, rl);
      expect(r.status).toBe(200);
      if (i === 0)
        expect(((await r.json()) as { updatedBy: string }).updatedBy).toMatch(
          /^anon:[A-Za-z0-9_-]{8}$/,
        );
    }
    const r = await write("x", ip, rl);
    expect(r.status).toBe(429);
    expect((await errOf(r)).code).toBe("rate_limited");
    // Without RL_ANON the DO's own per-actor counter enforces the same cap.
    const r2 = await write("y", ip);
    expect(r2.status).toBe(429);
    // Another IP is unaffected.
    expect((await write("x", uniqueIp(), rl)).status).toBe(200);
  });

  it("RL_ANON rejection → 429, keyed ip:{ip}; missing IP → 429", async () => {
    const id = await pub({ visibility: "public", allowAnonymousWrites: true });
    const keys: string[] = [];
    const deny: Limiter = {
      async limit({ key }) {
        keys.push(key);
        return { success: false };
      },
    };
    const r = await anon(
      R.dataDoc(id, "c", "a"),
      { method: "PUT", body: 1 },
      "192.0.2.1",
      deny,
    );
    expect(r.status).toBe(429);
    expect(keys).toEqual(["ip:192.0.2.1"]);
    const allow: Limiter = { limit: async () => ({ success: true }) };
    const ok = await anon(
      R.dataDoc(id, "c", "a"),
      { method: "PUT", body: 1 },
      "192.0.2.1",
      allow,
    );
    expect(ok.status).toBe(200);
    // Reads never hit the limiter.
    keys.length = 0;
    await anon(R.dataCollection(id, "c"), {}, "192.0.2.1", deny);
    expect(keys).toEqual([]);
    const noIp = await anon(
      R.dataDoc(id, "c", "a"),
      { method: "PUT", body: 1 },
      null,
    );
    expect(noIp.status).toBe(429);
  });
});

describe("data count", () => {
  const count = async (id: string, u: U | null, col = "c") => {
    const r = u
      ? await api(app, R.dataCount(id, col), u.cookie)
      : await anon(R.dataCount(id, col));
    return r.status === 200
      ? DataCountSchema.parse(await r.json()).count
      : r.status;
  };

  it("tracks inserts and deletes; empty collection → 0", async () => {
    const id = await pub({ visibility: "team" });
    expect(await count(id, viewer)).toBe(0);
    for (const d of ["a", "b", "c"]) await put(id, owner, d, { d });
    await put(id, owner, "a", { d: "again" }); // overwrite, not a new doc
    expect(await count(id, viewer)).toBe(3);
    // A doc whose id is "count" stays a doc, and other collections don't count.
    await put(id, owner, "count", 1);
    await api(app, R.dataDoc(id, "other", "x"), owner.cookie, {
      method: "PUT",
      body: 1,
    });
    expect(await count(id, owner)).toBe(4);
    expect(
      (await api(app, R.dataDoc(id, "c", "count"), owner.cookie)).status,
    ).toBe(200);
    await api(app, R.dataDoc(id, "c", "b"), owner.cookie, {
      method: "DELETE",
    });
    expect(await count(id, owner)).toBe(3);
    expect(await count(id, owner, "nope")).toBe(0);
    const r = await api(app, R.dataCount(id, "bad name"), owner.cookie);
    expect(r.status).toBe(400);
  });

  it("gated like list: 404 non-viewer, 403 no db, anonymous only on public", async () => {
    const priv = await pub();
    expect(await count(priv, guest)).toBe(404);
    expect(await count(priv, null)).toBe(404);
    const noDb = await pub({ capabilities: { db: false, storage: true } });
    const d = await api(app, R.dataCount(noDb, "c"), owner.cookie);
    expect(d.status).toBe(403);
    expect((await errOf(d)).code).toBe("capability_denied");
    const team = await pub({ visibility: "team" });
    expect(await count(team, null)).toBe(
      (await anon(R.dataCollection(team, "c"))).status,
    );
    const pubId = await pub({ visibility: "public" });
    await put(pubId, owner, "a", 1);
    expect((await anon(R.dataCollection(pubId, "c"))).status).toBe(200);
    expect(await count(pubId, null)).toBe(1);
  });

  it("uses an index, never the doc bodies", async () => {
    const id = await pub();
    await inDo(id, (i) => {
      const sql = (i as unknown as { ctx: DurableObjectState }).ctx.storage.sql;
      const plan = sql
        .exec<{ detail: string }>(
          "explain query plan select count(*) as n from docs where collection = ?",
          "c",
        )
        .toArray()
        .map((r) => r.detail)
        .join("; ");
      expect(plan).toMatch(/^SEARCH docs USING .*INDEX .*\(collection=\?\)/);
    });
  });
});

describe("shares", () => {
  it("a viewer whose share was revoked → 404", async () => {
    const id = await pub();
    expect((await put(id, guest, "a", 1)).status).toBe(404);
    const s = await api(app, R.shares(id), owner.cookie, {
      method: "PUT",
      body: { email: guest.email, role: "viewer" },
    });
    expect(s.status).toBe(200);
    expect((await put(id, guest, "a", 1)).status).toBe(200);
    const del = await api(app, R.share(id, guest.email), owner.cookie, {
      method: "DELETE",
    });
    expect(del.status).toBe(204);
    const r = await put(id, guest, "a", 2);
    expect(r.status).toBe(404);
    expect((await errOf(r)).code).toBe("not_found");
    expect((await api(app, R.dataDoc(id, "c", "a"), guest.cookie)).status).toBe(
      404,
    );
    expect((await api(app, R.storageKey(id, "k"), guest.cookie)).status).toBe(
      404,
    );
  });
});

describe("storage routes", () => {
  it("per-viewer get/set/list/delete", async () => {
    const id = await pub({ visibility: "team" });
    const s = await api(app, R.storageKey(id, "k1"), viewer.cookie, {
      method: "PUT",
      body: { value: { done: true } },
    });
    expect(s.status).toBe(200);
    expect(StorageEntrySchema.parse(await s.json())).toMatchObject({
      key: "k1",
      value: { done: true },
    });
    const g = await api(app, R.storageKey(id, "k1"), viewer.cookie);
    expect(StorageEntrySchema.parse(await g.json()).value).toEqual({
      done: true,
    });
    // Another viewer sees nothing.
    expect((await api(app, R.storageKey(id, "k1"), owner.cookie)).status).toBe(
      404,
    );
    const l = await api(app, R.storage(id), viewer.cookie);
    expect(
      PageSchema(StorageKeySchema)
        .parse(await l.json())
        .items.map((k) => k.key),
    ).toEqual(["k1"]);
    const d = await api(app, R.storageKey(id, "k1"), viewer.cookie, {
      method: "DELETE",
    });
    expect(d.status).toBe(204);
    expect((await api(app, R.storageKey(id, "k1"), viewer.cookie)).status).toBe(
      404,
    );
    const bad = await api(app, R.storageKey(id, "k2"), viewer.cookie, {
      method: "PUT",
      body: { value: 1, extra: 1 },
    });
    expect(bad.status).toBe(400);
  });

  it("anonymous storage → 401, even with allowAnonymousWrites", async () => {
    const id = await pub({ visibility: "public", allowAnonymousWrites: true });
    const g = await anon(R.storageKey(id, "k"));
    expect(g.status).toBe(401);
    expect((await anon(R.storage(id))).status).toBe(401);
    const s = await anon(R.storageKey(id, "k"), {
      method: "PUT",
      body: { value: 1 },
    });
    expect(s.status).toBe(401);
  });
});

describe("data subscribe", () => {
  it("426 without Upgrade; 101 websocket with it", async () => {
    const id = await pub({ visibility: "team" });
    const no = await api(app, R.dataSubscribe(id, "c"), viewer.cookie);
    expect(no.status).toBe(426);
    const r = await api(app, R.dataSubscribe(id, "c"), viewer.cookie, {
      headers: { upgrade: "websocket" },
    });
    expect(r.status).toBe(101);
    const ws = r.webSocket;
    if (!ws) throw new Error("no websocket");
    ws.accept();
    const got = new Promise<string>((res) =>
      ws.addEventListener("message", (e) => res(String(e.data))),
    );
    await put(id, viewer, "a", { n: 1 });
    expect(JSON.parse(await got)).toMatchObject({
      type: "db.change",
      collection: "c",
      docs: [{ id: "a", data: { n: 1 } }],
    });
    ws.close();
  });

  it("checks access, capability, collection and origin", async () => {
    const id = await pub({ visibility: "team" });
    const up = { upgrade: "websocket" };
    expect(
      (await api(app, R.dataSubscribe(id, "c"), guest.cookie, { headers: up }))
        .status,
    ).toBe(404);
    const noDb = await pub({ visibility: "team", capabilities: { db: false } });
    expect(
      (
        await api(app, R.dataSubscribe(noDb, "c"), viewer.cookie, {
          headers: up,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await api(app, R.dataSubscribe(id, "a b"), viewer.cookie, {
          headers: up,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await api(app, R.dataSubscribe(id, "c"), viewer.cookie, {
          headers: { ...up, origin: "https://evil.example" },
        })
      ).status,
    ).toBe(403);
  });
});

describe("fix round 1", () => {
  it("ipKey: IPv4 as is, IPv6 by /64, junk → null", () => {
    expect(ipKey("203.0.113.7")).toBe("203.0.113.7");
    expect(ipKey("2001:DB8:1:2:aaaa::1")).toBe("2001:db8:1:2::/64");
    expect(ipKey("2001:db8:1:2::2")).toBe("2001:db8:1:2::/64");
    expect(ipKey("2001:db8::")).toBe("2001:db8:0:0::/64");
    expect(ipKey("::ffff:1.2.3.4")).toBe("0:0:0:0::/64");
    expect(ipKey("::1")).toBe("0:0:0:0::/64");
    for (const bad of [
      "",
      "1.2.3.999",
      "zz",
      "1::2::3",
      "1:2:3:4:5:6:7:8:9",
      "12345::",
    ])
      expect(ipKey(bad), bad).toBeNull();
  });

  it("raw bodies: strict JSON only, stored as sent, echoed unparsed", async () => {
    const id = await pub({ visibility: "team" });
    const raw = (body: string, doc = "a") =>
      app.fetch(
        new Request(`http://app.localhost${R.dataDoc(id, "c", doc)}`, {
          method: "PUT",
          headers: { cookie: viewer.cookie, "x-oa-request": "1" },
          body,
        }),
        env,
        ctx,
      );
    for (const bad of ["{a:1}", "[1,]", "", "\u00ff", "NaN"])
      expect((await raw(bad)).status, bad).toBe(400);
    const ok = await raw('{ "x" : [1, 2] }');
    expect(ok.status).toBe(200);
    expect(DataDocSchema.parse(await ok.json()).data).toEqual({ x: [1, 2] });
    const g = await api(app, R.dataDoc(id, "c", "a"), viewer.cookie);
    expect(((await g.json()) as { data: unknown }).data).toEqual({ x: [1, 2] });
  });

  it("anonymous subscribe: RL_ANON sub:ip:{key}; unbound outside dev → 503", async () => {
    const id = await pub({ visibility: "public" });
    const keys: string[] = [];
    const deny: Limiter = {
      async limit({ key }) {
        keys.push(key);
        return { success: false };
      },
    };
    const sub = (e: object, ip = "2001:db8:9:9::5") =>
      app.fetch(
        new Request(`http://app.localhost${R.dataSubscribe(id, "c")}`, {
          headers: { upgrade: "websocket", "cf-connecting-ip": ip },
        }),
        { ...env, ...e } as never,
        ctx,
      );
    expect((await sub({ RL_ANON: deny })).status).toBe(429);
    expect(keys).toEqual(["sub:ip:2001:db8:9:0::/56"]);
    const prod = await sub({ RL_ANON: undefined, ENVIRONMENT: "production" });
    expect(prod.status).toBe(503);
    const w = await app.fetch(
      new Request(`http://app.localhost${R.dataDoc(id, "c", "a")}`, {
        method: "PUT",
        headers: { "cf-connecting-ip": "203.0.113.1" },
        body: "1",
      }),
      { ...env, RL_ANON: undefined, ENVIRONMENT: "production" } as never,
      ctx,
    );
    expect(w.status).toBe(503); // anonymous writes allowed (viewers): the unbound limiter refuses
  });

  const closed = async (ws: WebSocket) =>
    new Promise<number>((res) =>
      ws.addEventListener("close", (e) => res((e as CloseEvent).code)),
    );
  const open = async (id: string, u: U) => {
    const r = await api(app, R.dataSubscribe(id, "c"), u.cookie, {
      headers: { upgrade: "websocket" },
    });
    const ws = r.webSocket;
    if (!ws) throw new Error(`no websocket (${r.status})`);
    ws.accept();
    return ws;
  };

  it("visibility change and soft delete close sockets with 4403", async () => {
    const id = await pub({ visibility: "team" });
    const ws = await open(id, viewer);
    const code = closed(ws);
    const p = await api(app, R.artifact(id), owner.cookie, {
      method: "PATCH",
      body: { visibility: "private" },
    });
    expect(p.status).toBe(200);
    expect(await code).toBe(4403);

    const id2 = await pub({ visibility: "team" });
    const ws2 = await open(id2, viewer);
    const code2 = closed(ws2);
    expect(
      (await api(app, R.artifact(id2), owner.cookie, { method: "DELETE" }))
        .status,
    ).toBe(204);
    expect(await code2).toBe(4403);
  });

  it("at most 20 sockets per actor", async () => {
    const id = await pub({ visibility: "team" });
    const socks: WebSocket[] = [];
    for (let i = 0; i < 20; i++) socks.push(await open(id, viewer));
    const r = await api(app, R.dataSubscribe(id, "c"), viewer.cookie, {
      headers: { upgrade: "websocket" },
    });
    expect(r.status).toBe(429);
    expect((await open(id, owner)).readyState).toBe(1);
    for (const w of socks) w.close();
  });

  /** An anonymous data socket from `ip`: the WebSocket, or the refusal status. */
  const anon = async (id: string, ip: string) => {
    const r = await api(app, R.dataSubscribe(id, "c"), null, {
      headers: { upgrade: "websocket", "cf-connecting-ip": ip },
    });
    r.webSocket?.accept();
    return r.webSocket ?? r.status;
  };

  it("8 anonymous sockets per IPv6 /56; a 9th from another /64 in it is refused", async () => {
    const id = await pub({ visibility: "public" });
    const socks: WebSocket[] = [];
    for (let i = 0; i < 8; i++) {
      const w = await anon(
        id,
        `2001:db8:7:1${i.toString(16).padStart(2, "0")}::1`,
      );
      if (typeof w === "number") throw new Error(`refused ${w}`);
      socks.push(w);
    }
    expect(await anon(id, "2001:db8:7:1ff::9")).toBe(429);
    const other = await anon(id, "2001:db8:7:200::1");
    expect(typeof other).not.toBe("number");
    // Members aren't limited by the anonymous caps.
    const member: WebSocket[] = [];
    for (let i = 0; i < 9; i++) member.push(await open(id, viewer));
    for (const w of member) w.close();
    for (const w of [...socks, other as WebSocket]) w.close();
  });

  it("a full anonymous pool (100) still lets members connect", async () => {
    const id = await pub({ visibility: "public" });
    const socks: WebSocket[] = [];
    // 13 IPv4 actors × 8 = 104 attempts over the 100-socket anonymous pool.
    let refused = 0;
    for (let a = 0; a < 13; a++)
      for (let k = 0; k < 8; k++) {
        const w = await anon(id, `192.0.2.${a + 1}`);
        if (typeof w === "number") {
          expect(w).toBe(429);
          refused++;
        } else socks.push(w);
      }
    expect(socks).toHaveLength(100);
    expect(refused).toBe(4);
    expect(await anon(id, "192.0.2.99")).toBe(429);
    for (const u of [viewer, owner])
      expect((await open(id, u)).readyState).toBe(1);
    for (const w of socks) w.close();
  }, 60_000); // 104 WebSocket upgrades: slow under a loaded full-suite run
});
