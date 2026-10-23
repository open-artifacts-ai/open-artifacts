import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  DataChangeSchema,
  type DataDoc,
  dailyWritesMessage,
  dataDocLimit,
  dataDocTooLargeMessage,
  LIMITS,
} from "@oa/shared";
import { describe, expect, it } from "vitest";
import { ApiError } from "../src/http/errors.js";
import {
  type ArtifactRuntime,
  DAILY_WRITES,
  type RuntimeStub,
  runtimeCall,
  runtimeStub,
  toRuntimeApiError,
} from "../src/runtime/do.js";
import { doAsPaid, PAID_ENV } from "./helpers.js";

let seq = 0;
const stubFor = (name = `rt-${++seq}-${Math.random()}`) =>
  runtimeStub(env, name);

const inDo = <R>(
  s: RuntimeStub,
  cb: (i: ArtifactRuntime, state: DurableObjectState) => R | Promise<R>,
) => runInDurableObject(s as unknown as DurableObjectStub<ArtifactRuntime>, cb);

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await runtimeCall(() => p);
  } catch (e) {
    if (e instanceof ApiError) return e.code;
    throw e;
  }
  throw new Error("expected rejection");
}

describe("ArtifactRuntime docs", () => {
  it("set/get/update/delete round trip", async () => {
    const s = stubFor();
    const d = await s.set("votes", "a", { choice: "A", n: 1 }, "u:1");
    expect(d).toMatchObject({
      id: "a",
      data: { choice: "A", n: 1 },
      updatedBy: "u:1",
    });
    expect(new Date(d.updatedAt).toISOString()).toBe(d.updatedAt);
    expect(await s.get("votes", "a")).toEqual(d);
    const u = await s.update("votes", "a", { n: 2 }, "u:2");
    expect(u.data).toEqual({ choice: "A", n: 2 });
    expect(u.updatedBy).toBe("u:2");
    const created = await s.update("votes", "b", { x: 1 }, "u:2");
    expect(created.data).toEqual({ x: 1 });
    await s.delete("votes", "a", "u:1");
    expect(await s.get("votes", "a")).toBeNull();
    expect(await s.get("other", "b")).toBeNull();
  });

  it("query where returns only matching docs, typed equality", async () => {
    const s = stubFor();
    await s.set("v", "1", { choice: "A" }, "u:1");
    await s.set("v", "2", { choice: "B" }, "u:1");
    await s.set("v", "3", { choice: "B", flag: true }, "u:1");
    await s.set("v", "4", { choice: 1, flag: 1, z: null }, "u:1");
    const r = await s.query("v", { where: { choice: "B" } });
    expect(r.items.map((d) => d.id).sort()).toEqual(["2", "3"]);
    expect(
      (await s.query("v", { where: { flag: true } })).items.map((d) => d.id),
    ).toEqual(["3"]);
    expect(
      (await s.query("v", { where: { flag: 1 } })).items.map((d) => d.id),
    ).toEqual(["4"]);
    expect(
      (await s.query("v", { where: { z: null } })).items.map((d) => d.id),
    ).toEqual(["4"]);
  });

  it("injection-shaped where/orderBy keys are bad_request", async () => {
    const s = stubFor();
    await s.set("v", "1", { a: 1 }, "u:1");
    expect(await codeOf(s.query("v", { where: { "a') OR 1=1 --": 1 } }))).toBe(
      "bad_request",
    );
    expect(await codeOf(s.query("v", { orderBy: "a.b" }))).toBe("bad_request");
    expect(
      await codeOf(s.query("v", { where: JSON.parse('{"__proto__":1}') })),
    ).toBe("bad_request");
  });

  it("validates names, ids and patches", async () => {
    const s = stubFor();
    expect(await codeOf(s.set("a.b", "x", 1, "u:1"))).toBe("bad_request");
    expect(await codeOf(s.set("c", "..", 1, "u:1"))).toBe("bad_request");
    expect(await codeOf(s.get("c", "x".repeat(129)))).toBe("bad_request");
    expect(await codeOf(s.update("c", "x", [1] as never, "u:1"))).toBe(
      "bad_request",
    );
    expect(await codeOf(s.set("c", "x", undefined, "u:1"))).toBe("bad_request");
    expect(await codeOf(s.set("c", "x", 1, ""))).toBe("bad_request");
  });

  it("orders and paginates query by orderBy with keyset cursor", async () => {
    const s = stubFor();
    for (const [id, n] of [
      ["a", 3],
      ["b", 1],
      ["c", 2],
      ["d", 2],
      ["e", 5],
    ] as const)
      await s.set("v", id, { n }, "u:1");
    const p1 = await s.query("v", { orderBy: "n", limit: 2 });
    expect(p1.items.map((d) => d.id)).toEqual(["b", "c"]);
    const p2 = await s.query("v", {
      orderBy: "n",
      limit: 2,
      cursor: p1.nextCursor!,
    });
    expect(p2.items.map((d) => d.id)).toEqual(["d", "a"]);
    const p3 = await s.query("v", {
      orderBy: "n",
      limit: 2,
      cursor: p2.nextCursor!,
    });
    expect(p3.items.map((d) => d.id)).toEqual(["e"]);
    expect(p3.nextCursor).toBeNull();
    const desc = await s.query("v", { orderBy: "n", order: "desc", limit: 3 });
    expect(desc.items.map((d) => d.id)).toEqual(["e", "a", "d"]);
    const desc2 = await s.query("v", {
      orderBy: "n",
      order: "desc",
      cursor: desc.nextCursor!,
    });
    expect(desc2.items.map((d) => d.id)).toEqual(["c", "b"]);
  });

  it("lists with keyset cursor; bad cursors are bad_request", async () => {
    const s = stubFor();
    for (let i = 0; i < 5; i++) await s.set("v", `d${i}`, { i }, "u:1");
    await s.set("w", "x", 1, "u:1");
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const p = await s.list("v", cursor, 2);
      seen.push(...p.items.map((d: DataDoc) => d.id));
      cursor = p.nextCursor ?? undefined;
    } while (cursor);
    expect(seen.sort()).toEqual(["d0", "d1", "d2", "d3", "d4"]);
    expect(await codeOf(s.list("v", "!!notbase64", 2))).toBe("bad_request");
    expect(await codeOf(s.list("v", btoa("{}"), 2))).toBe("bad_request");
    expect(await codeOf(s.list("v", undefined, 0))).toBe("bad_request");
    expect(await codeOf(s.list("v", undefined, 501))).toBe("bad_request");
  });
});

describe("ArtifactRuntime limits", () => {
  for (const plan of ["free", "paid"] as const)
    it(`${plan}: a doc over ${dataDocLimit(plan) / 1024} KB (UTF-8) is too_large; exactly at it is ok`, async () => {
      const s = stubFor();
      if (plan === "paid") await doAsPaid(s);
      const limit = dataDocLimit(plan);
      // JSON.stringify("x...") adds 2 quote bytes.
      const ok = "x".repeat(limit - 2);
      await s.set("v", "ok", ok, "u:1");
      expect(await codeOf(s.set("v", "big", `${ok}x`, "u:1"))).toBe(
        "too_large",
      );
      // Multibyte: 2-byte chars count as 2.
      const mb = "é".repeat(limit / 2);
      expect(await codeOf(s.set("v", "mb", mb, "u:1"))).toBe("too_large");
    });

  it("tracks total bytes transactionally and rejects over artifactDataBytes", async () => {
    const s = stubFor();
    await s.set("v", "a", "x".repeat(100), "u:1");
    await s.set("v", "a", "x".repeat(10), "u:1");
    await s.storageSet("u:1", "k", "yy");
    expect(await inDo(s, (i) => i.totalBytes())).toBe(
      // data + collection + id + updated_by + 64 per row; storage: data + viewer + key + 64
      12 + 1 + 1 + 3 + 64 + (4 + 3 + 1 + 64),
    );
    await s.delete("v", "a", "u:1");
    expect(await inDo(s, (i) => i.totalBytes())).toBe(4 + 3 + 1 + 64);
    await inDo(s, (_i, state) => {
      state.storage.sql.exec(
        "update totals set bytes = ? where id = 1",
        LIMITS.artifactDataBytes - 100,
      );
    });
    expect(await codeOf(s.set("v", "b", "x".repeat(40), "u:1"))).toBe(
      "too_large",
    );
    // Rejected write left the total untouched.
    expect(await inDo(s, (i) => i.totalBytes())).toBe(
      LIMITS.artifactDataBytes - 100,
    );
    // 22 data bytes + 69 row bytes = 91 fits in the remaining 100.
    await s.set("v", "b", "x".repeat(20), "u:1");
  });

  it("101st write in a minute is rate_limited; other actors unaffected", async () => {
    const s = stubFor();
    await inDo(s, (i) => {
      i.now = () => 1_700_000_000_000;
    });
    for (let n = 0; n < LIMITS.viewerWritesPerMin; n++)
      await s.set("v", `d${n % 3}`, n, "u:1");
    expect(await codeOf(s.set("v", "x", 1, "u:1"))).toBe("rate_limited");
    expect(await codeOf(s.storageSet("u:1", "k", 1))).toBe("rate_limited");
    await s.set("v", "x", 1, "u:2");
    // Next minute resets; the counter lives in memory, not SQLite.
    await inDo(s, (i) => {
      i.now = () => 1_700_000_000_000 + 60_000;
    });
    await s.set("v", "x", 1, "u:1");
    const tables = await inDo(s, (_i, state) =>
      state.storage.sql
        .exec("select name from sqlite_master where type = 'table'")
        .toArray()
        .map((r) => r.name),
    );
    expect(tables).not.toContain("writes");
  });

  it("10,001st write of the UTC day is rate_limited (totals row); next day resets", async () => {
    const s = stubFor();
    const t = Date.UTC(2026, 0, 1, 12);
    await inDo(s, (i) => {
      i.now = () => t;
    });
    await s.set("v", "a", 1, "u:1");
    await inDo(s, (_i, state) => {
      state.storage.sql.exec(
        "update totals set writes = ? where id = 1",
        DAILY_WRITES,
      );
    });
    const e = await s.set("v", "b", 1, "u:2").catch((x: Error) => x);
    expect(String((e as Error).message)).toBe(
      `oa:rate_limited:${dailyWritesMessage(DAILY_WRITES)}`,
    );
    expect(await s.get("v", "b")).toBeNull();
    await inDo(s, (i) => {
      i.now = () => t + 86_400_000;
    });
    await s.set("v", "b", 1, "u:2");
  });

  it("Paid overrides: DATA_DOC_BYTES and DATA_DAILY_WRITES are enforced", async () => {
    const s = stubFor();
    const docBytes = 1536 * 1024;
    await inDo(s, (i) => {
      (i as unknown as { env: object }).env = {
        ...PAID_ENV,
        DATA_DOC_BYTES: String(docBytes),
        DATA_DAILY_WRITES: "20000",
      };
    });
    const ok = "x".repeat(docBytes - 2);
    await s.set("v", "ok", ok, "u:1");
    const e = await s.set("v", "big", `${ok}x`, "u:1").catch((x: Error) => x);
    expect(String((e as Error).message)).toBe(
      `oa:too_large:${dataDocTooLargeMessage("paid", docBytes)}`,
    );
    expect(String((e as Error).message)).toContain("1536 KB");
    // 15,000 writes is past the default but under the override.
    await inDo(s, (_i, state) => {
      state.storage.sql.exec(
        "update totals set writes = ? where id = 1",
        15_000,
      );
    });
    await s.set("v", "a", 1, "u:2");
    await inDo(s, (_i, state) => {
      state.storage.sql.exec(
        "update totals set writes = ? where id = 1",
        20_000,
      );
    });
    const w = await s.set("v", "b", 1, "u:2").catch((x: Error) => x);
    expect(String((w as Error).message)).toBe(
      "oa:rate_limited:daily write limit reached (20000 writes per artifact per UTC day on this instance)",
    );
  });

  it("Free override: a lower DATA_DOC_BYTES applies; a higher one clamps to 256 KB", async () => {
    const s = stubFor();
    await inDo(s, (i) => {
      (i as unknown as { env: object }).env = {
        ...env,
        PLAN: "free",
        DATA_DOC_BYTES: "1024",
        DATA_DAILY_WRITES: "",
      };
    });
    await s.set("v", "ok", "x".repeat(1022), "u:1");
    expect(await codeOf(s.set("v", "big", "x".repeat(1023), "u:1"))).toBe(
      "too_large",
    );
    const t = stubFor();
    await inDo(t, (i) => {
      (i as unknown as { env: object }).env = {
        ...env,
        PLAN: "free",
        DATA_DOC_BYTES: String(1024 * 1024),
      };
    });
    const limit = 256 * 1024;
    await t.set("v", "ok", "x".repeat(limit - 2), "u:1");
    expect(await codeOf(t.set("v", "big", "x".repeat(limit - 1), "u:1"))).toBe(
      "too_large",
    );
  });

  it("a rolled-back first-ever write leaves the schema in place (next write succeeds)", async () => {
    const s = stubFor();
    await inDo(s, (i) => {
      const o = i as unknown as { bump: (...a: unknown[]) => void };
      const orig = o.bump;
      o.bump = () => {
        o.bump = orig;
        throw new Error("oa:too_large:artifact data exceeds 50 MB");
      };
    });
    expect(await codeOf(s.set("v", "a", 1, "u:1"))).toBe("too_large");
    const d = await s.set("v", "b", 1, "u:1");
    expect(d.id).toBe("b");
    expect(await inDo(s, (i) => i.totalBytes())).toBeGreaterThan(0);
  });

  it("migrates a pre-M2 meta/writes schema into the totals row", async () => {
    const s = stubFor();
    await inDo(s, (_i, state) => {
      state.storage.sql.exec(`
        create table meta (k text primary key, v integer not null) without rowid;
        insert into meta values ('bytes', 500), ('c:v', 400);
        create table writes (actor text, minute integer, n integer);`);
    });
    expect(await inDo(s, (i) => i.totalBytes())).toBe(500);
    const row = await inDo(s, (_i, state) =>
      state.storage.sql.exec("select cols from totals").one(),
    );
    expect(JSON.parse(String(row.cols))).toEqual({ v: 400 });
  });

  it("anonymous ip: actors get the lower per-IP limit", async () => {
    const s = stubFor();
    await inDo(s, (i) => {
      i.now = () => 1_700_000_000_000;
    });
    for (let n = 0; n < LIMITS.anonWritesPerMinPerIp; n++)
      await s.set("v", "a", n, "ip:1.2.3.4");
    expect(await codeOf(s.set("v", "a", 1, "ip:1.2.3.4"))).toBe("rate_limited");
  });
});

describe("ArtifactRuntime storage", () => {
  it("is per viewer and lists Page<StorageKey>", async () => {
    const s = stubFor();
    await s.storageSet("u:x", "k1", { a: 1 });
    await s.storageSet("u:x", "k2", [1]);
    await s.storageSet("u:x", "k3", "z");
    expect(await s.storageGet("u:x", "k1")).toEqual({ a: 1 });
    expect(await s.storageGet("u:y", "k1")).toBeNull();
    expect((await s.storageList("u:y")).items).toEqual([]);
    const p1 = await s.storageList("u:x", undefined, 2);
    expect(p1.items.map((k) => k.key)).toEqual(["k1", "k2"]);
    expect(typeof p1.items[0]!.updatedAt).toBe("string");
    const p2 = await s.storageList("u:x", p1.nextCursor!, 2);
    expect(p2).toEqual({
      items: [expect.objectContaining({ key: "k3" })],
      nextCursor: null,
    });
    await s.storageDelete("u:x", "k1");
    expect(await s.storageGet("u:x", "k1")).toBeNull();
    expect(await codeOf(s.storageSet("u:x", "a.b", 1))).toBe("bad_request");
  });
});

describe("ArtifactRuntime errors", () => {
  it("errors survive RPC serialization and map to ApiError", async () => {
    const s = stubFor();
    let raw: unknown;
    try {
      await s.get("bad.name", "x");
    } catch (e) {
      raw = e;
    }
    const api = toRuntimeApiError(raw);
    expect(api).toBeInstanceOf(ApiError);
    expect(api?.code).toBe("bad_request");
    expect(toRuntimeApiError(new Error("boom"))).toBeNull();
    await expect(
      runtimeCall(() => Promise.reject(new Error("boom"))),
    ).rejects.toThrow("boom");
  });
});

describe("ArtifactRuntime websocket", () => {
  async function connect(s: ReturnType<typeof stubFor>, collection: string) {
    const res = await s.fetch(`http://do/subscribe?collection=${collection}`, {
      headers: {
        Upgrade: "websocket",
        "X-OA-Actor": "u:1",
        "X-OA-Authz-At": String(Date.now()),
      },
    });
    expect(res.status).toBe(101);
    const ws = res.webSocket!;
    ws.accept();
    const msgs: unknown[] = [];
    ws.addEventListener("message", (e) =>
      msgs.push(JSON.parse(e.data as string)),
    );
    return { ws, msgs };
  }
  const tick = () => new Promise((r) => setTimeout(r, 50));

  it("sockets older than signedUrlTtlSec close 4408 on the alarm; younger re-arm it", async () => {
    const s = stubFor();
    // Real-time based: an alarm in the past would fire on its own.
    const t0 = Date.now();
    await inDo(s, (i) => {
      i.now = () => t0;
    });
    const old = await connect(s, "c");
    const alarm = await inDo(s, (_i, st) => st.storage.getAlarm());
    expect(alarm).toBe(t0 + LIMITS.signedUrlTtlSec * 1000);
    await inDo(s, (i) => {
      i.now = () => t0 + 300_000;
    });
    const young = await connect(s, "c");
    const codes: Record<string, number> = {};
    old.ws.addEventListener("close", (e) => {
      codes.old = (e as CloseEvent).code;
    });
    young.ws.addEventListener("close", (e) => {
      codes.young = (e as CloseEvent).code;
    });
    await inDo(s, async (i, st) => {
      i.now = () => t0 + LIMITS.signedUrlTtlSec * 1000;
      await i.alarm();
      expect(await st.storage.getAlarm()).toBe(
        t0 + 300_000 + LIMITS.signedUrlTtlSec * 1000,
      );
    });
    await tick();
    expect(codes).toEqual({ old: 4408 });
    young.ws.close();
  });

  it("broadcasts db.change to the collection only, including deletes", async () => {
    const s = stubFor();
    const a = await connect(s, "votes");
    const b = await connect(s, "votes");
    const o = await connect(s, "other");
    const doc = await s.set("votes", "x", { choice: "B" }, "u:1");
    await tick();
    expect(b.msgs).toEqual([
      { type: "db.change", collection: "votes", docs: [doc], deleted: [] },
    ]);
    expect(a.msgs).toHaveLength(1);
    expect(DataChangeSchema.safeParse(b.msgs[0]).success).toBe(true);
    await s.delete("votes", "x", "u:1");
    await tick();
    expect(b.msgs[1]).toEqual({
      type: "db.change",
      collection: "votes",
      docs: [],
      deleted: ["x"],
    });
    expect(o.msgs).toEqual([]);
    for (const c of [a, b, o]) c.ws.close();
  });

  it("rejects non-upgrade and bad collections", async () => {
    const s = stubFor();
    expect((await s.fetch("http://do/subscribe?collection=votes")).status).toBe(
      426,
    );
    const bad = await s.fetch("http://do/subscribe?collection=a.b", {
      headers: {
        Upgrade: "websocket",
        "X-OA-Actor": "u:1",
        "X-OA-Authz-At": String(Date.now()),
      },
    });
    expect(bad.status).toBe(400);
    const none = await s.fetch("http://do/subscribe", {
      headers: {
        Upgrade: "websocket",
        "X-OA-Actor": "u:1",
        "X-OA-Authz-At": String(Date.now()),
      },
    });
    expect(none.status).toBe(400);
    // No actor: no per-actor cap to apply, so refused (not uncapped).
    const anonymous = await s.fetch("http://do/subscribe?collection=votes", {
      headers: { Upgrade: "websocket" },
    });
    expect(anonymous.status).toBe(400);
  });
});

describe("ArtifactRuntime destroy", () => {
  it("wipes all data and stays usable", async () => {
    const s = stubFor();
    await s.set("v", "a", 1, "u:1");
    await s.storageSet("u:1", "k", 1);
    await s.destroy();
    expect(await s.get("v", "a")).toBeNull();
    expect(await s.storageGet("u:1", "k")).toBeNull();
    await s.set("v", "a", 2, "u:1");
    expect((await s.get("v", "a"))?.data).toBe(2);
  });
});
