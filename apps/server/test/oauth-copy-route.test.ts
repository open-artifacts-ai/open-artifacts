import { env } from "cloudflare:workers";
import { newId } from "@oa/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OAUTH_COPY_PATH } from "../src/mcp/oauth-copy.js";
import {
  BACKFILLED_KEY,
  COPY_GEN_KEY,
  COPY_PAGE,
  KV_WRITES_OFF_KEY,
  keyCompare,
  type OAuthStoreMode,
  oauthEnv,
  resetOAuthStoreMarkers,
} from "../src/mcp/oauth-store.js";
import { APP, callWorker, E, limiter } from "./mcp-helpers.js";

// #1008: POST /__oa/oauth-store/copy, Platform's driver for the OAuth
// KV -> D1 copy. Off unless a 32+ char OAUTH_COPY_KEY (HOSTED plays no
// part); rate limit, then the key, then the input; uniform 404 before the key, a
// fixed-enum reason after it.

const KEY = "c".repeat(32);
const tag = newId().slice(0, 6).toLowerCase();
const nowS = () => Math.floor(Date.now() / 1000);
/** Seeded keys expire an hour out: far past MIN_COPY_TTL_S, no clock race. */
const EXP = nowS() + 3600;

/** An in-memory KV with KV's list order, cursor, expiry and metadata. */
function memKv(keys: number) {
  const m = new Map<string, { v: string; expiration: number }>();
  for (let i = 0; i < keys; i++)
    m.set(`token:cr-${tag}-${keys}:${String(i).padStart(5, "0")}`, {
      v: `v${i}`,
      expiration: EXP,
    });
  const sorted = () => [...m.entries()].sort(([a], [b]) => keyCompare(a, b));
  return {
    m,
    async get(k: string) {
      return m.get(k)?.v ?? null;
    },
    async put(k: string, v: string) {
      m.set(k, { v, expiration: EXP });
    },
    async delete(k: string) {
      m.delete(k);
    },
    async list(o: { prefix?: string; limit?: number; cursor?: string } = {}) {
      const all = sorted().filter(([k]) => k.startsWith(o.prefix ?? ""));
      const start = o.cursor ? Number(o.cursor) : 0;
      const lim = o.limit ?? 1000;
      const page = all
        .slice(start, start + lim)
        .map(([name, x]) => ({ name, expiration: x.expiration }));
      return start + lim >= all.length
        ? { keys: page, list_complete: true }
        : { keys: page, list_complete: false, cursor: String(start + lim) };
    },
  };
}

const passRl = limiter(1_000_000);
const ON = { OAUTH_COPY_KEY: KEY, RL_ANON: passRl.RL_ANON };
const inMode = (mode: OAuthStoreMode, over: Record<string, unknown> = {}) =>
  E({ ...ON, OAUTH_STORE: mode, ...over });

async function post(
  e: unknown,
  init: {
    key?: string;
    body?: string;
    host?: string;
    path?: string;
  } = {},
) {
  return callWorker(
    new Request(
      `https://${init.host ?? "app.localhost"}${init.path ?? OAUTH_COPY_PATH}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": "198.51.100.210",
          ...(init.key ? { authorization: `Bearer ${init.key}` } : {}),
        },
        ...(init.body !== undefined ? { body: init.body } : {}),
      },
    ),
    e,
  );
}
const copy = (e: unknown, body: unknown = {}) =>
  post(e, { key: KEY, body: JSON.stringify(body) });

/** Byte for byte what an unknown route answers on the same install. */
async function same404(r: Response, e: unknown) {
  const ref = await post(e, { path: "/__oa/no-such-route", body: "{}" });
  expect(ref.status).toBe(404);
  expect(r.status).toBe(404);
  expect(r.headers.get("content-type")).toBe(ref.headers.get("content-type"));
  expect(await r.text()).toBe(await ref.text());
}
/** A refusal after the key: the same 404, plus error.details.reason. */
async function refused404(r: Response, e: unknown, reason: string) {
  const ref = await post(e, { path: "/__oa/no-such-route", body: "{}" });
  expect(r.status).toBe(404);
  expect(r.headers.get("content-type")).toBe(ref.headers.get("content-type"));
  const { error } = (await ref.json()) as { error: object };
  expect(await r.json()).toEqual({ error: { ...error, details: { reason } } });
}

const genOf = async () =>
  (
    await env.DB.prepare("select value from settings where key = ?")
      .bind(COPY_GEN_KEY)
      .first<{ value: string }>()
  )?.value ?? null;
/** Rows under one memKv's prefix. */
const rowsFor = async (keys: number) =>
  (
    await env.DB.prepare("select count(*) n from oauth_kv where key like ?")
      .bind(`token:cr-${tag}-${keys}:%`)
      .first<{ n: number }>()
  )?.n ?? 0;
const isBackfilled = async () =>
  (await env.DB.prepare("select 1 from settings where key = ?")
    .bind(BACKFILLED_KEY)
    .first()) !== null;
/** Nothing the copy writes moved: no generation minted, no row inserted. */
async function notRun(keys: number, gen: string | null) {
  expect(await genOf()).toBe(gen);
  expect(await rowsFor(keys)).toBe(0);
}

type Counts = {
  kvKeys: number;
  copied: number;
  skippedExpiring: number;
  d1Rows: number | null;
  nextCursor: string | null;
  restarted: boolean;
  backfilled: boolean;
};

// Each test starts as if this install never served in d1 mode, with a copy
// recorded (d1 needs one) and no isolate's markers checked.
beforeEach(async () => {
  resetOAuthStoreMarkers();
  await env.DB.batch([
    env.DB.prepare("delete from settings where key in (?, ?)").bind(
      KV_WRITES_OFF_KEY,
      COPY_GEN_KEY,
    ),
    env.DB.prepare(
      "insert into settings (key, value) values (?, '1') on conflict(key) do nothing",
    ).bind(BACKFILLED_KEY),
  ]);
});
afterEach(() => vi.restoreAllMocks());

describe("off: any unknown route", () => {
  it("without a key, or with a key under 32 chars, even with that key", async () => {
    const kv = memKv(3);
    const offs = [
      inMode("dual", { OAUTH_KV: kv, OAUTH_COPY_KEY: undefined }),
      inMode("dual", { OAUTH_KV: kv, OAUTH_COPY_KEY: "c".repeat(31) }),
    ];
    for (const e of offs) {
      const key = (e as { OAUTH_COPY_KEY?: string }).OAUTH_COPY_KEY ?? KEY;
      await same404(await post(e, { key, body: "{}" }), e);
    }
    await notRun(3, null);
  });

  it("the content host never serves it", async () => {
    const e = inMode("dual", { OAUTH_KV: memKv(4) });
    const r = await post(e, {
      host: "content.localhost",
      key: KEY,
      body: "{}",
    });
    const ref = await post(e, {
      host: "content.localhost",
      path: "/__oa/no-such-route",
      body: "{}",
    });
    expect(r.status).toBe(404);
    expect(ref.status).toBe(404);
    expect(r.headers.get("content-type")).toBe(ref.headers.get("content-type"));
    expect(await r.text()).toBe(await ref.text());
    await notRun(4, null);
  });

  it("only POST: GET is the standard 404", async () => {
    const e = inMode("dual", { OAUTH_KV: memKv(5) });
    const r = await callWorker(
      new Request(`${APP}${OAUTH_COPY_PATH}`, {
        headers: { authorization: `Bearer ${KEY}` },
      }),
      e,
    );
    const ref = await callWorker(new Request(`${APP}/__oa/no-such-route`), e);
    expect(r.status).toBe(404);
    expect(await r.text()).toBe(await ref.text());
    await notRun(5, null);
  });
});

describe("before the key: the uniform 404", () => {
  it("a missing or wrong key: identical to an unknown route, no reason", async () => {
    const e = inMode("dual", { OAUTH_KV: memKv(6) });
    await same404(await post(e, { body: "{}" }), e);
    await same404(await post(e, { key: "x".repeat(32), body: "{}" }), e);
    await same404(await post(e, { key: `${KEY}c`, body: "{}" }), e);
    await notRun(6, null);
  });

  it("rate limited (its own key prefix), or RL_ANON unbound: the uniform 404, even with the key", async () => {
    const counted = limiter(1_000_000);
    const e0 = inMode("dual", { OAUTH_KV: memKv(7), ...counted });
    await refused404(await post(e0, { key: KEY, body: "[]" }), e0, "bad_input");
    const keys = [...counted.counts.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toBe("oauth-copy:app.localhost:198.51.100.210");

    const limited = inMode("dual", { OAUTH_KV: memKv(7), ...limiter(0) });
    await same404(await copy(limited), limited);
    const unbound = inMode("dual", { OAUTH_KV: memKv(7), RL_ANON: undefined });
    await same404(await copy(unbound), unbound);
    await notRun(7, null);
  });

  it("d1 with OAUTH_KV unbound and no markers: a wrong key is the uniform 404, the key not_dual", async () => {
    // A fresh install provisioned straight into d1: no copy, no stamp, no KV.
    await env.DB.prepare("delete from settings where key = ?")
      .bind(BACKFILLED_KEY)
      .run();
    const e = inMode("d1", { OAUTH_KV: undefined });
    // The route answers first, in a cold isolate: its marker check sees the
    // raw binding (unbound), not d1's store past the provider.
    await same404(await post(e, { key: "x".repeat(32), body: "{}" }), e);
    resetOAuthStoreMarkers();
    await env.DB.prepare("delete from settings where key = ?")
      .bind(KV_WRITES_OFF_KEY)
      .run();
    await refused404(await copy(e), e, "not_dual");
    expect(await genOf()).toBeNull();
  });

  it("d1 with OAUTH_KV bound and no copy recorded: the same 503 any route answers, before the key", async () => {
    await env.DB.prepare("delete from settings where key = ?")
      .bind(BACKFILLED_KEY)
      .run();
    const e = inMode("d1", { OAUTH_KV: memKv(12) });
    const ref = await callWorker(new Request(`${APP}/robots.txt`), e);
    expect(ref.status).toBe(503);
    const r = await post(e, { key: "x".repeat(32), body: "{}" });
    expect(r.status).toBe(503);
    expect(await r.text()).toBe(await ref.text());
    await notRun(12, null);
  });

  it("dual after d1 (refused): the same 503 any route answers, before the key", async () => {
    await env.DB.prepare("insert into settings (key, value) values (?, ?)")
      .bind(KV_WRITES_OFF_KEY, String(Date.now()))
      .run();
    const e = inMode("dual", { OAUTH_KV: memKv(8) });
    const ref = await callWorker(new Request(`${APP}/robots.txt`), e);
    expect(ref.status).toBe(503);
    const refBody = await ref.text();
    for (const r of [
      await post(e, { body: "{}" }),
      await post(e, { key: "x".repeat(32), body: "{}" }),
      await post(
        E({ ...ON, OAUTH_STORE: "dual", OAUTH_KV: memKv(8), ...limiter(0) }),
        {
          key: KEY,
          body: "{}",
        },
      ),
    ]) {
      expect(r.status).toBe(503);
      expect(await r.text()).toBe(refBody);
    }
    await notRun(8, null);
  });
});

describe("after the key: a fixed-enum reason", () => {
  it("probe: an empty or invalid body is bad_input and never runs the copy", async () => {
    const e = inMode("dual", { OAUTH_KV: memKv(9) });
    for (const body of [
      undefined,
      "",
      "  ",
      "not json",
      "null",
      "[]",
      '"x"',
      "1",
      '{"cursor":""}',
      '{"cursor":5}',
      '{"cursor":null}',
      '{"other":1}',
    ]) {
      const r = await post(e, {
        key: KEY,
        ...(body !== undefined ? { body } : {}),
      });
      await refused404(r, e, "bad_input");
    }
    await notRun(9, null);
  });

  it("kv and d1 modes: not_dual, nothing copied", async () => {
    for (const mode of ["kv", "d1"] as const) {
      resetOAuthStoreMarkers();
      const e = inMode(mode, { OAUTH_KV: memKv(10) });
      await refused404(await copy(e), e, "not_dual");
    }
    await notRun(10, null);
  });

  it("dual after d1 without the override: markers, nothing copied", async () => {
    await env.DB.prepare("insert into settings (key, value) values (?, ?)")
      .bind(KV_WRITES_OFF_KEY, String(Date.now()))
      .run();
    // An authorized call reaches the copy, whose marker check refuses.
    const e = inMode("dual", { OAUTH_KV: memKv(11) });
    const r = await copy(e);
    expect(r.status).toBe(404);
    expect(
      ((await r.json()) as { error: { details: unknown } }).error.details,
    ).toEqual({ reason: "markers" });
    await notRun(11, null);
  });
});

describe("dual: the copy", () => {
  it("pages to completion via nextCursor, then a rerun copies nothing; the KV binding under the store is read, not the dual merge", async () => {
    await env.DB.prepare("delete from settings where key = ?")
      .bind(BACKFILLED_KEY)
      .run();
    const n = COPY_PAGE * 2 + 5;
    const kv = memKv(n);
    const e = inMode("dual", { OAUTH_KV: kv });
    const logs = vi.spyOn(console, "log");
    const pass = async () => {
      const out: Counts[] = [];
      let cursor: string | null = null;
      do {
        const r = await copy(e, cursor ? { cursor } : {});
        expect(r.status).toBe(200);
        expect(r.headers.get("cache-control")).toBe("no-store");
        const body = (await r.json()) as Counts;
        expect(Object.keys(body)).toEqual([
          "kvKeys",
          "copied",
          "skippedExpiring",
          "d1Rows",
          "nextCursor",
          "restarted",
          "backfilled",
        ]);
        expect(body.backfilled).toBe(body.nextCursor === null);
        expect(body.d1Rows === null).toBe(body.nextCursor !== null);
        if (body.backfilled) expect(await isBackfilled()).toBe(true);
        out.push(body);
        cursor = body.nextCursor;
      } while (cursor);
      return out;
    };
    const first = await pass();
    expect(await isBackfilled()).toBe(true);
    expect(first.map((c) => c.kvKeys)).toEqual([COPY_PAGE, COPY_PAGE, 5]);
    expect(first.map((c) => c.copied)).toEqual([COPY_PAGE, COPY_PAGE, 5]);
    expect(first.every((c) => !c.restarted && c.skippedExpiring === 0)).toBe(
      true,
    );
    expect(first.at(-1)?.d1Rows).toBeGreaterThanOrEqual(n);
    expect(await rowsFor(n)).toBe(n);
    // Rerun: the same keys, nothing new, rows unchanged.
    const second = await pass();
    expect(second.map((c) => c.copied)).toEqual([0, 0, 0]);
    expect(await rowsFor(n)).toBe(n);
    // Logs carry counts only: never a key, a value or a cursor.
    const logged = logs.mock.calls.map((a) => a.join(" ")).join("\n");
    expect(logged).toContain("oauth_copy.ok");
    expect(logged).not.toContain(KEY);
    expect(logged).not.toContain(`cr-${tag}`);
    for (const c of [...first, ...second])
      if (c.nextCursor) expect(logged).not.toContain(c.nextCursor);
  });

  it("a cursor a kv run retired restarts the pass (restarted)", async () => {
    const n = COPY_PAGE + 3;
    const e = inMode("dual", { OAUTH_KV: memKv(n) });
    const r1 = (await (await copy(e)).json()) as Counts;
    expect(r1).toMatchObject({ kvKeys: COPY_PAGE, restarted: false });
    expect(r1.nextCursor).not.toBeNull();
    // A kv isolate's first store operation retires the copy's generation.
    resetOAuthStoreMarkers();
    await oauthEnv(E({ OAUTH_STORE: "kv" })).OAUTH_KV.get(`cr-${tag}:none`);
    expect(await genOf()).toBeNull();
    resetOAuthStoreMarkers();
    const r2 = (await (
      await copy(e, { cursor: r1.nextCursor })
    ).json()) as Counts;
    expect(r2).toMatchObject({
      kvKeys: COPY_PAGE,
      restarted: true,
      backfilled: false,
    });
    const r3 = (await (
      await copy(e, { cursor: r2.nextCursor })
    ).json()) as Counts;
    expect(r3).toMatchObject({
      kvKeys: 3,
      nextCursor: null,
      restarted: false,
      backfilled: true,
    });
    expect(await rowsFor(n)).toBe(n);
  });
});
