import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/http/errors.js";
import {
  type ArtifactRuntime,
  type RuntimeStub,
  runtimeCall,
  runtimeStub,
  toRuntimeApiError,
} from "../src/runtime/do.js";
import { doAsPaid } from "./helpers.js";

let seq = 0;
const stubFor = () => runtimeStub(env, `adv-${++seq}-${Math.random()}`);
const inDo = <R>(
  s: RuntimeStub,
  cb: (i: ArtifactRuntime, st: DurableObjectState) => R | Promise<R>,
) => runInDurableObject(s as unknown as DurableObjectStub<ArtifactRuntime>, cb);
/** Runs `fn` inside the DO and sums SQLite rows read by every statement it executes. */
const rowsReadBy = <R>(s: RuntimeStub, fn: (i: ArtifactRuntime) => R) =>
  inDo(s, (i, st) => {
    const sql = st.storage.sql;
    const own = Object.getOwnPropertyDescriptor(sql, "exec");
    const exec = sql.exec.bind(sql);
    const cursors: { rowsRead: number }[] = [];
    Object.defineProperty(sql, "exec", {
      configurable: true,
      writable: true,
      value: (...a: Parameters<typeof exec>) => {
        const c = exec(...a);
        cursors.push(c);
        return c;
      },
    });
    let result: R | undefined;
    let error: string | null = null;
    try {
      result = fn(i);
    } catch (e) {
      error = (e as Error).message;
    } finally {
      if (own) Object.defineProperty(sql, "exec", own);
      else delete (sql as { exec?: unknown }).exec;
    }
    const rows = cursors.reduce((n, c) => n + c.rowsRead, 0);
    return { rows, result, error, statements: cursors.length };
  });

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await runtimeCall(() => p);
  } catch (e) {
    if (e instanceof ApiError) return e.code;
    throw e;
  }
  return "ok";
}

describe("B12 adversarial", () => {
  it("viewers with lone surrogates or NUL are rejected (no namespace collisions)", async () => {
    const s = stubFor();
    expect(await codeOf(s.storageSet("u:\uD800", "k", "secret"))).toBe(
      "bad_request",
    );
    expect(await codeOf(s.storageGet("u:\uDC00", "k"))).toBe("bad_request");
    expect(await codeOf(s.storageSet("u:a\u0000", "k", "x"))).toBe(
      "bad_request",
    );
    expect(await codeOf(s.set("v", "a", 1, "u:" + "x".repeat(251)))).toBe(
      "bad_request",
    );
  });
  it("BREAK actor must match u:|ip:|agent: format (IP: gets the 100/min cap)", async () => {
    const s = stubFor();
    expect(await codeOf(s.set("v", "a", 1, "IP:1.2.3.4"))).toBe("bad_request");
  });
  it("BREAK orderBy on a long string field: nextCursor must be accepted back", async () => {
    const s = stubFor();
    for (const id of ["a", "b", "c"])
      await s.set("v", id, { t: id + "x".repeat(4000) }, "u:1");
    const p1 = await s.query("v", { orderBy: "t", limit: 1 });
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await runtimeCall(() =>
      s.query("v", { orderBy: "t", limit: 1, cursor: p1.nextCursor! }),
    );
    expect(p2.items[0]?.id).toBe("b");
  });
  it("BREAK byte total counts row overhead (128-char collection/id, tiny data)", async () => {
    const s = stubFor();
    const c = "c".repeat(128),
      id = "i".repeat(128);
    await s.set(c, id, 0, "u:" + "x".repeat(250));
    expect(await inDo(s, (i) => i.totalBytes())).toBeGreaterThanOrEqual(256);
  });
  it("accounting stays exact across overwrite/update/delete/failures", async () => {
    const s = stubFor();
    await s.set("v", "a", { x: "é".repeat(10) }, "u:1");
    await s.set("v", "a", [1, 2], "u:1");
    await s.update("v", "a", { y: 1 }, "u:1");
    await s.update("v", "b", { z: "ü" }, "u:2");
    await s.storageSet("u:1", "k", "abc");
    await s.storageSet("u:1", "k", "abcdef");
    expect(
      await codeOf(s.set("v", "a", "x".repeat(LIMITS_DOC + 1), "u:1")),
    ).toBe("too_large");
    await s.delete("v", "b", "u:1");
    await s.delete("v", "nope", "u:1");
    const [t, real] = await inDo(s, (i, st) => [
      i.totalBytes(),
      st.storage.sql
        .exec<{ n: number }>(
          "select (select coalesce(sum(length(cast(data as blob)) + length(collection) + length(id) + coalesce(length(updated_by),0) + 64),0) from docs)+(select coalesce(sum(length(cast(data as blob)) + length(viewer) + length(key) + 64),0) from storage) n",
        )
        .one().n,
    ]);
    expect(t).toBe(real);
  });
  it("destroy racing a write leaves the DO usable", async () => {
    const s = stubFor();
    await s.set("v", "a", 1, "u:1");
    const r = await Promise.allSettled([
      s.destroy(),
      s.set("v", "b", 2, "u:1"),
      s.get("v", "b"),
    ]);
    expect(r.map((x) => x.status)).toEqual([
      "fulfilled",
      "fulfilled",
      "fulfilled",
    ]);
    // Only doc "b": 1 data byte + "v" + "b" + "u:1" + 64 overhead.
    expect(await inDo(s, (i) => i.totalBytes())).toBe(1 + 1 + 1 + 3 + 64);
  });
  it("__proto__ in nested set data does not pollute", async () => {
    const s = stubFor();
    const d = await s.set(
      "v",
      "a",
      JSON.parse('{"__proto__":{"polluted":1}}'),
      "u:1",
    );
    expect(Object.hasOwn(d.data as object, "__proto__")).toBe(true);
    expect(
      await inDo(s, () => (({}) as Record<string, unknown>).polluted),
    ).toBeUndefined();
    expect(
      await codeOf(
        s.update("v", "a", JSON.parse('{"__proto__":{"p":1}}'), "u:1"),
      ),
    ).toBe("bad_request");
  });
  it("BREAK toRuntimeApiError only maps errors that start with oa:", () => {
    expect(
      toRuntimeApiError(new Error("D1_ERROR: near 'oa:not_found:x'")),
    ).toBeNull();
  });
  it("BREAK hostile client messages close the socket (subscribe-only)", async () => {
    const s = stubFor();
    const res = await s.fetch("http://do/s?collection=v", {
      headers: {
        Upgrade: "websocket",
        "X-OA-Actor": "u:1",
        "X-OA-Authz-At": String(Date.now()),
      },
    });
    const ws = res.webSocket!;
    ws.accept();
    const closed = new Promise<number>((r) =>
      ws.addEventListener("close", (e) => r(e.code)),
    );
    ws.send("x".repeat(100_000));
    expect(
      await Promise.race([
        closed,
        new Promise((r) => setTimeout(() => r("open"), 200)),
      ]),
    ).not.toBe("open");
  });
  it("fan-out: sockets capped at 200; 1 MB docs fan out as small data:null frames", async () => {
    const s = stubFor();
    await doAsPaid(s); // 1 MB docs: the Paid limit
    const msgs: string[] = [];
    for (let k = 0; k < 200; k++) {
      // Distinct signed-in actors: the 200-socket pool, under per-actor caps.
      const r = await s.fetch("http://do/s?collection=v", {
        headers: {
          Upgrade: "websocket",
          "X-OA-Actor": `u:${k}`,
          "X-OA-Authz-At": String(Date.now()),
        },
      });
      const ws = r.webSocket!;
      ws.accept();
      if (k === 0)
        ws.addEventListener("message", (e) => msgs.push(e.data as string));
    }
    const over = await s.fetch("http://do/s?collection=v", {
      headers: {
        Upgrade: "websocket",
        "X-OA-Actor": "u:999",
        "X-OA-Authz-At": String(Date.now()),
      },
    });
    expect(over.status).toBe(429);
    expect(await inDo(s, (_i, st) => st.getWebSockets("v").length)).toBe(200);
    await s.set("v", "a", "x".repeat(1024 * 1024 - 2), "u:1");
    await s.set("v", "b", "x".repeat(1024 * 1024 - 2), "u:1");
    await s.set("v", "small", { ok: 1 }, "u:1");
    // The bound: frame sizes below (200 sockets never get the 1 MB doc).
    await vi.waitFor(() => expect(msgs).toHaveLength(3));
    const frames = msgs.map((m) => JSON.parse(m));
    // Over 16 KB: the broadcast carries data:null (subscribers refetch), so each of the
    // 200 sockets gets a tiny frame instead of 1 MB.
    for (const [k, id] of [
      [0, "a"],
      [1, "b"],
    ] as const) {
      expect(frames[k].docs[0]).toMatchObject({
        id,
        data: null,
        updatedBy: "u:1",
      });
      expect(msgs[k]!.length).toBeLessThan(512);
    }
    expect(frames[2].docs[0]).toMatchObject({ id: "small", data: { ok: 1 } });
  }, 60_000);
});
const LIMITS_DOC = 1024 * 1024;
describe("B12 adversarial scan", () => {
  const colBytes = (s: RuntimeStub, c: string) =>
    inDo(s, (_i, st) => [
      st.storage.sql
        .exec<{ v: number }>(
          "select coalesce(json_extract(cols, ?), 0) v from totals",
          `$."${c}"`,
        )
        .one().v,
      st.storage.sql
        .exec<{ n: number }>(
          "select coalesce(sum(size), 0) n from docs where collection = ?",
          c,
        )
        .one().n,
    ]);

  it("query over a full 50 MB collection is refused quickly; list still works", async () => {
    const s = stubFor();
    await s.get("v", "warm");
    await inDo(s, (_i, st) => {
      const body = JSON.stringify({ choice: "A", pad: "x".repeat(25_000) });
      for (let k = 0; k < 2000; k++)
        st.storage.sql.exec(
          "insert into docs values ('v', ?, ?, ?, '2026-01-01T00:00:00.000Z', 'u:1')",
          `d${k}`,
          body,
          body.length,
        );
      // Mirror what writes would have tracked.
      st.storage.sql.exec(
        "update totals set cols = json_set(cols, '$.\"v\"', ?)",
        2000 * body.length,
      );
    });
    expect(await codeOf(s.query("v", { where: { choice: "B" } }))).toBe(
      "bad_request",
    );
    // Refused from the totals row alone: no doc rows are scanned.
    const probe = await rowsReadBy(s, (i) =>
      i.query("v", { where: { choice: "B" } }),
    );
    expect(probe.error).toMatch(/^oa:bad_request:collection too large/);
    expect(probe.rows).toBeLessThanOrEqual(1);
    expect(await codeOf(s.query("v", { orderBy: "choice" }))).toBe(
      "bad_request",
    );
    expect((await s.query("v", { limit: 2 })).items).toHaveLength(2);
    expect((await s.list("v", undefined, 2)).items).toHaveLength(2);
  }, 60_000);

  it("query just under 2 MiB completes; one more write crosses the cap", async () => {
    const s = stubFor();
    await inDo(s, (i) => {
      i.now = () => 1_700_000_000_000;
    });
    const pad = "x".repeat(25_000);
    for (let k = 0; k < 83; k++)
      await s.set("v", `d${k}`, { choice: k === 7 ? "B" : "A", pad }, "u:1");
    await s.set("w", "other", { pad }, "u:1");
    const [tracked, real] = await colBytes(s, "v");
    expect(tracked).toBe(real);
    expect(tracked).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(tracked).toBeGreaterThan(2 * 1024 * 1024 - 30_000);
    const r = await s.query("v", { where: { choice: "B" } });
    // The scan bound is the rows-read check below.
    expect(r.items.map((d) => d.id)).toEqual(["d7"]);
    // The scan touches only this collection's 83 rows (+ the totals row), never "w".
    const probe = await rowsReadBy(s, (i) =>
      i.query("v", { where: { choice: "B" } }),
    );
    expect(probe.error).toBeNull();
    expect(probe.result?.items.map((d) => d.id)).toEqual(["d7"]);
    expect(probe.rows).toBeGreaterThanOrEqual(83);
    expect(probe.rows).toBeLessThanOrEqual(83 + 2);
    const o = await s.query("v", {
      orderBy: "choice",
      order: "desc",
      limit: 1,
    });
    expect(o.items[0]?.id).toBe("d7");
    await s.set("v", "extra", { pad }, "u:1");
    expect(await codeOf(s.query("v", { where: { choice: "B" } }))).toBe(
      "bad_request",
    );
    // Deleting brings it back under.
    await s.delete("v", "extra", "u:1");
    await s.update("v", "d0", { pad: "" }, "u:1");
    const [t2, r2] = await colBytes(s, "v");
    expect(t2).toBe(r2);
    expect((await s.query("v", { where: { choice: "B" } })).items).toHaveLength(
      1,
    );
  }, 60_000);
});
