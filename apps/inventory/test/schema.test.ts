import { describe, expect, it } from "vitest";
import { platformDb } from "../../../packages/provision/test/platform-db.ts";
import { REQUIRED_TABLES, SCHEMA_SQL } from "../src/schema.ts";
import {
  BEARER,
  makeEnv,
  makeKv,
  REDLINE,
  req,
  sqliteD1,
  worker,
} from "./support.ts";

// #1041: a verified caller on a D1 route gets 503 schema_missing while the
// platform schema is absent; an unverified one still gets the uniform 404,
// and every other failure keeps its own answer.

/** D1 over an empty database (no migrations), counting schema reads. */
function emptyD1() {
  const db = sqliteD1(platformDb([]));
  let schemaReads = 0;
  return {
    db: {
      prepare(sql: string) {
        if (sql === SCHEMA_SQL) schemaReads++;
        return db.prepare(sql);
      },
    },
    reads: () => schemaReads,
  };
}

const D1_ROUTES: [string, RequestInit][] = [
  ["/installs", {}],
  ["/health", {}],
  [
    "/prodclean",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    },
  ],
];

async function unknownRoute404() {
  const r = await worker().w.fetch(req("/nope", {}, BEARER), makeEnv());
  return { status: r.status, body: await r.text() };
}

describe("schema_missing", () => {
  it("a verified caller on each D1 route gets the fixed 503", async () => {
    for (const [path, init] of D1_ROUTES) {
      const { db } = emptyD1();
      const res = await worker().w.fetch(
        req(path, init, BEARER),
        makeEnv({ PLATFORM_DB: db }),
      );
      expect(res.status, path).toBe(503);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual({ error: "schema_missing" });
    }
  });

  it("one missing table is enough", async () => {
    for (const drop of REQUIRED_TABLES) {
      const sq = platformDb();
      sq.exec("PRAGMA foreign_keys = OFF");
      sq.exec(`DROP TABLE ${drop}`);
      const res = await worker().w.fetch(
        req("/health", {}, BEARER),
        makeEnv({ PLATFORM_DB: sqliteD1(sq) }),
      );
      expect(res.status, drop).toBe(503);
      expect(await res.json()).toEqual({ error: "schema_missing" });
    }
  });

  it("an unverified caller still gets the uniform 404, and D1 is never read", async () => {
    const ref = await unknownRoute404();
    for (const [path, init] of D1_ROUTES) {
      const d = emptyD1();
      for (const auth of [undefined, "Bearer wrong"]) {
        const res = await worker().w.fetch(
          req(path, init, auth),
          makeEnv({ PLATFORM_DB: d.db }),
        );
        expect({ status: res.status, body: await res.text() }, path).toEqual(
          ref,
        );
      }
      expect(d.reads()).toBe(0);
    }
  });

  it("/hosts reads only HOSTS: no schema check, still served", async () => {
    const d = emptyD1();
    const res = await worker(REDLINE).w.fetch(
      req("/hosts", {}, BEARER),
      makeEnv({ PLATFORM_DB: d.db, HOSTS: makeKv({}).kv }),
    );
    expect(res.status).toBe(200);
    expect(d.reads()).toBe(0);
  });

  it("a present schema is read once per isolate; a missing one is read again", async () => {
    const { w } = worker();
    const d = emptyD1();
    const env = makeEnv({ PLATFORM_DB: d.db });
    for (let i = 0; i < 2; i++)
      expect((await w.fetch(req("/health", {}, BEARER), env)).status).toBe(503);
    expect(d.reads()).toBe(2);

    const full = sqliteD1(platformDb());
    let reads = 0;
    const counted = {
      prepare(sql: string) {
        if (sql === SCHEMA_SQL) reads++;
        return full.prepare(sql);
      },
    };
    const env2 = makeEnv({ PLATFORM_DB: counted });
    for (let i = 0; i < 3; i++)
      expect((await w.fetch(req("/health", {}, BEARER), env2)).status).toBe(
        200,
      );
    expect(reads).toBe(1);
  });

  it("any other failure keeps its own answer: a failing schema read is the 500", async () => {
    const broken = {
      prepare() {
        throw new Error("D1 unavailable");
      },
    };
    const res = await worker().w.fetch(
      req("/installs", {}, BEARER),
      makeEnv({ PLATFORM_DB: broken }),
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal" });
  });

  it("with the schema present, a later D1 fault is still the 500", async () => {
    const full = sqliteD1(platformDb());
    const db = {
      prepare(sql: string) {
        if (sql !== SCHEMA_SQL) throw new Error("boom");
        return full.prepare(sql);
      },
    };
    const res = await worker().w.fetch(
      req("/health", {}, BEARER),
      makeEnv({ PLATFORM_DB: db }),
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal" });
  });
});
