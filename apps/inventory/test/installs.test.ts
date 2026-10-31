import { InventoryInstallsSchema } from "@oa/shared/provisioning";
import { describe, expect, it } from "vitest";
// The real platform schema (every migration) in node:sqlite.
import {
  install,
  job,
  lifecycle,
  platformDb,
  signup,
} from "../../../packages/provision/test/platform-db.ts";
import { INSTALLS_SQL, UNTRACKED_SQL } from "../src/installs.ts";
import {
  BEARER,
  getJson,
  makeDb,
  makeEnv,
  makeKv,
  req,
  sqliteD1,
  worker,
} from "./support.ts";

const id = (c: string) => `i${c.repeat(11)}`;

describe("GET /installs", () => {
  it("an installs row with no lifecycle row fails closed, so prodClean cannot pass over it", async () => {
    const sq = platformDb();
    install(sq, id("a"), { app_host: "a.test", content_host: "a-c.test" });
    lifecycle(sq, id("a"));
    // Created outside the Provisioning API (no install_lifecycle row): the
    // install_status view never lists it.
    install(sq, id("b"), {
      app_host: "b.test",
      content_host: "b-c.test",
      test_hooks: 1,
    });
    const r = await worker().w.fetch(
      req("/installs", {}, BEARER),
      makeEnv({ PLATFORM_DB: sqliteD1(sq), HOSTS: makeKv({}).kv }),
    );
    expect(r.status).toBe(500);
    expect(await r.json()).toEqual({ error: "internal" });
  });

  it("reads install_status, only the five columns it maps", async () => {
    const { db, sqls } = makeDb([]);
    await getJson(makeEnv({ PLATFORM_DB: db }), "/installs");
    expect(sqls).toEqual([UNTRACKED_SQL, INSTALLS_SQL]);
    expect(INSTALLS_SQL).toBe(
      "SELECT install_id, app_host, content_host, state, test_hooks FROM install_status ORDER BY install_id",
    );
  });

  it("all six states and every mode, on the real view", async () => {
    const sq = platformDb();
    // active, serving
    install(sq, id("a"), { app_host: "a.test", content_host: "a-c.test" });
    lifecycle(sq, id("a"));
    // suspended, paused
    install(sq, id("b"), {
      app_host: "b.test",
      content_host: "b-c.test",
      test_hooks: 1,
    });
    lifecycle(sq, id("b"), { suspended_at: 5, suspend_reason: "admin" });
    // deleting, closed
    install(sq, id("c"), { app_host: "c.test", content_host: "c-c.test" });
    lifecycle(sq, id("c"), { deleted_at: 5, purge_at: 9 });
    // deleted, HOSTS names another install: mode null
    install(sq, id("d"), {
      app_host: "d.test",
      content_host: "d-c.test",
      state: "deleted",
    });
    lifecycle(sq, id("d"), { discarded_at: 5 });
    // provisioning (an open job), unmapped
    install(sq, id("e"), {
      app_host: "e.test",
      content_host: "e-c.test",
      state: "creating",
    });
    lifecycle(sq, id("e"));
    job(sq, id("e"), { status: "running" });
    // failed (no job, never active), HOSTS junk
    install(sq, id("f"), {
      app_host: "f.test",
      content_host: "f-c.test",
      state: "creating",
    });
    lifecycle(sq, id("f"));
    const kv = makeKv({
      "a.test": id("a"),
      "b.test": `paused:${id("b")}`,
      "c.test": `closed:${id("c")}`,
      "d.test": id("a"),
      "f.test": "junk",
    });
    const body = await getJson(
      makeEnv({ PLATFORM_DB: sqliteD1(sq), HOSTS: kv.kv }),
      "/installs",
    );
    expect(InventoryInstallsSchema.safeParse(body).success).toBe(true);
    const row = (
      c: string,
      state: string,
      mode: string | null,
      hooks = false,
    ) => ({
      id: id(c),
      appHost: `${c}.test`,
      contentHost: `${c}-c.test`,
      state,
      testHooks: hooks,
      mode,
    });
    expect(body).toEqual({
      installs: [
        row("a", "active", "serving"),
        row("b", "suspended", "paused", true),
        row("c", "deleting", "closed"),
        row("d", "deleted", null),
        row("e", "provisioning", null),
        row("f", "failed", null),
      ],
    });
    for (const i of body.installs as object[])
      expect(
        InventoryInstallsSchema.shape.installs.element.strict().safeParse(i)
          .success,
      ).toBe(true);
    expect(kv.calls.writes).toBe(0);
  });

  it("a hostless install_status row (a signup, no installs row) is listed with null hosts and mode, no HOSTS lookup", async () => {
    const sq = platformDb();
    install(sq, id("a"), { app_host: "a.test", content_host: "a-c.test" });
    lifecycle(sq, id("a"));
    lifecycle(sq, id("g"));
    signup(sq, { install_id: id("g"), status: "creating" });
    const kv = makeKv({ "a.test": id("a") });
    const body = await getJson(
      makeEnv({ PLATFORM_DB: sqliteD1(sq), HOSTS: kv.kv }),
      "/installs",
    );
    expect(InventoryInstallsSchema.safeParse(body).success).toBe(true);
    const installs = body.installs as Record<string, unknown>[];
    expect(installs.map((i) => i.id)).toEqual([id("a"), id("g")]);
    expect(installs[0]).toMatchObject({ appHost: "a.test", mode: "serving" });
    expect(installs[1]).toMatchObject({
      id: id("g"),
      appHost: null,
      contentHost: null,
      mode: null,
    });
    for (const i of installs)
      expect(
        InventoryInstallsSchema.shape.installs.element.safeParse(i).success,
      ).toBe(true);
    // Only the routed host is read.
    expect(kv.calls.keys).toEqual(["a.test"]);
  });

  it("one host null and the other set is refused by the schema, and the listing fails closed", async () => {
    const El = InventoryInstallsSchema.shape.installs.element;
    const base = {
      id: id("a"),
      state: "active",
      testHooks: false,
      mode: null,
    };
    expect(
      El.safeParse({ ...base, appHost: "a.test", contentHost: null }).success,
    ).toBe(false);
    expect(
      El.safeParse({ ...base, appHost: null, contentHost: "c.test" }).success,
    ).toBe(false);
    for (const [app_host, content_host] of [
      ["a.test", null],
      [null, "c.test"],
    ])
      await expect(
        getJson(
          makeEnv({
            PLATFORM_DB: makeDb([
              {
                install_id: id("a"),
                app_host,
                content_host,
                state: "active",
                test_hooks: 0,
              },
            ]).db,
          }),
          "/installs",
        ),
      ).rejects.toThrow("/installs: 500");
  });

  it("an empty table is an empty list", async () => {
    expect(
      await getJson(
        makeEnv({ PLATFORM_DB: sqliteD1(platformDb()) }),
        "/installs",
      ),
    ).toEqual({ installs: [] });
  });

  it("an unknown (NULL) test_hooks reads as true, so prodClean fails closed", async () => {
    const { db } = makeDb([
      {
        install_id: id("a"),
        app_host: "a.test",
        content_host: "c.test",
        state: "active",
        test_hooks: null,
      },
    ]);
    const body = await getJson(makeEnv({ PLATFORM_DB: db }), "/installs");
    expect(
      (body.installs as { testHooks: boolean }[]).map((i) => i.testHooks),
    ).toEqual([true]);
  });

  it("a row the schema refuses is a fixed 500, never a partial list", async () => {
    const { db } = makeDb([
      {
        install_id: "not-an-id",
        app_host: "a.test",
        content_host: "c.test",
        state: "active",
        test_hooks: 0,
      },
    ]);
    await expect(
      getJson(makeEnv({ PLATFORM_DB: db }), "/installs"),
    ).rejects.toThrow("/installs: 500");
  });
});
