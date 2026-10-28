import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { STATUS_FOR } from "@oa/shared";
import { describe, expect, it } from "vitest";
import { ApiError } from "../src/http/errors.js";
import {
  type ArtifactRuntime,
  type RuntimeStub,
  runtimeCall,
  runtimeStub,
} from "../src/runtime/do.js";

// Review item 22: db.query pagination must not skip docs when the anchor doc changes.

let seq = 0;
const stubFor = () => runtimeStub(env, `qcur-${++seq}-${Math.random()}`);
const inDo = <R>(s: RuntimeStub, cb: (i: ArtifactRuntime) => R) =>
  runInDurableObject(s as unknown as DurableObjectStub<ArtifactRuntime>, cb);

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await runtimeCall(() => p);
  } catch (e) {
    if (e instanceof ApiError) return e.code;
    throw e;
  }
  return "ok";
}

const b64url = (o: unknown) =>
  btoa(JSON.stringify(o))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/** Every page of a query, following nextCursor; `between` runs after each page. */
async function allPages(
  s: RuntimeStub,
  q: Parameters<RuntimeStub["query"]>[1],
  between: (page: number, ids: string[]) => Promise<void> = async () => {},
): Promise<string[][]> {
  const pages: string[][] = [];
  let cursor: string | undefined;
  for (let n = 0; n < 20; n++) {
    const r = await runtimeCall(() => s.query("v", { ...q, cursor }));
    const ids = r.items.map((d) => d.id);
    pages.push(ids);
    if (!r.nextCursor) break;
    await between(n, ids);
    cursor = r.nextCursor;
  }
  return pages;
}

describe("db.query cursor carries the anchor's sort value", () => {
  it("a write that moves the last doc of a page doesn't skip the docs after it", async () => {
    const s = stubFor();
    for (const [id, score] of [
      ["a", 1],
      ["b", 2],
      ["c", 3],
      ["d", 4],
      ["e", 5],
    ] as const)
      await s.set("v", id, { score }, "u:1");
    const pages = await allPages(
      s,
      { orderBy: "score", limit: 2 },
      async (n) => {
        if (n === 0) await s.set("v", "b", { score: 10 }, "u:1");
      },
    );
    // b moved to the end after page 1 was read; c, d and e are all still served.
    expect(pages).toEqual([["a", "b"], ["c", "d"], ["e", "b"]]);
  });

  it("descending: the anchor moving up doesn't skip the rest (nulls last)", async () => {
    const s = stubFor();
    for (const [id, score] of [
      ["a", 5],
      ["b", 4],
      ["c", 3],
      ["d", null],
    ] as const)
      await s.set("v", id, { score }, "u:1");
    const pages = await allPages(
      s,
      { orderBy: "score", order: "desc", limit: 2 },
      async (n) => {
        if (n === 0) await s.set("v", "b", { score: 99 }, "u:1");
      },
    );
    expect(pages.flat()).toEqual(["a", "b", "c", "d"]);
  });

  it("without orderBy, rewriting the anchor (new updated_at) doesn't skip", async () => {
    const s = stubFor();
    let t = 1_700_000_000_000;
    await inDo(s, (i) => {
      i.now = () => t;
    });
    for (const id of ["a", "b", "c", "d"]) {
      t += 1000;
      await s.set("v", id, { x: id }, "u:1");
    }
    const pages = await allPages(s, { limit: 2 }, async (n) => {
      if (n === 0) {
        t += 1000;
        await s.set("v", "b", { x: "b2" }, "u:1");
      }
    });
    expect(pages).toEqual([["a", "b"], ["c", "d"], ["b"]]);
  });

  it("a deleted anchor still pages on (no cursor expired)", async () => {
    const s = stubFor();
    for (const [id, score] of [
      ["a", 1],
      ["b", 2],
      ["c", 3],
    ] as const)
      await s.set("v", id, { score }, "u:1");
    const p1 = await s.query("v", { orderBy: "score", limit: 2 });
    await s.delete("v", "b", "u:1");
    const p2 = await runtimeCall(() =>
      s.query("v", { orderBy: "score", limit: 2, cursor: p1.nextCursor! }),
    );
    expect(p2.items.map((d) => d.id)).toEqual(["c"]);
  });

  it("a sort value over the inline cap pages on, and a changed anchor is 409 cursor_stale", async () => {
    const s = stubFor();
    const long = (k: string) => k + "x".repeat(2000);
    for (const id of ["a", "b", "c"])
      await s.set("v", id, { t: long(id) }, "u:1");
    const p1 = await s.query("v", { orderBy: "t", limit: 1 });
    expect(p1.nextCursor!.length).toBeLessThan(512);
    // Unchanged anchor: the next page follows.
    const p2 = await runtimeCall(() =>
      s.query("v", { orderBy: "t", limit: 1, cursor: p1.nextCursor! }),
    );
    expect(p2.items[0]?.id).toBe("b");
    // A changed anchor is refused loudly instead of skipping.
    await s.set("v", "b", { t: long("z") }, "u:1");
    expect(
      await codeOf(
        s.query("v", { orderBy: "t", limit: 1, cursor: p2.nextCursor! }),
      ),
    ).toBe("cursor_stale");
    expect(STATUS_FOR.cursor_stale).toBe(409);
    // So is a deleted one.
    await s.delete("v", "a", "u:1");
    expect(
      await codeOf(
        s.query("v", { orderBy: "t", limit: 1, cursor: p1.nextCursor! }),
      ),
    ).toBe("cursor_stale");
  });

  it("a forged cursor only moves the start inside the where filter", async () => {
    const s = stubFor();
    for (let k = 0; k < 6; k++)
      await s.set(
        "v",
        `d${k}`,
        { choice: k % 2 ? "B" : "A", score: k, secret: k % 2 ? "" : "hide" },
        "u:1",
      );
    for (const forged of [
      { i: "", o: "score", d: "asc", t: "z", v: "" },
      { i: "", o: "score", d: "asc", t: "n", v: "-1e308" },
      { i: "zzz", o: "score", d: "asc", t: "s", v: "' or 1=1 --" },
    ]) {
      const r = await runtimeCall(() =>
        s.query("v", {
          where: { choice: "B" },
          orderBy: "score",
          cursor: b64url(forged),
        }),
      );
      for (const d of r.items)
        expect((d.data as { choice: string }).choice).toBe("B");
    }
    for (const bad of [
      { i: "", o: "score", d: "asc", t: "x", v: "1" },
      { i: "", o: "score", d: "asc", t: "n", v: "abc" },
      { i: "", o: "score", d: "asc", t: "n", v: "" },
      { i: "", o: "score", d: "asc", t: "z", v: "1" },
      { i: "", o: "score", d: "asc", t: "n", v: "Infinity" },
      { i: "", o: "score", d: "asc", t: "s" },
      { i: "", o: "score", d: "asc", t: "s", v: "a", u: "" },
      { i: "", o: "score", d: "asc", t: "s", v: 1 },
      { i: "", o: "other", d: "asc", t: "s", v: "a" },
    ])
      expect(
        await codeOf(
          s.query("v", {
            where: { choice: "B" },
            orderBy: "score",
            cursor: b64url(bad),
          }),
        ),
      ).toBe("bad_request");
  });
});
