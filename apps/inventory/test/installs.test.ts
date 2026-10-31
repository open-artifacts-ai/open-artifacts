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
import { INSTALLS_SQL } from "../src/installs.ts";
import { getJson, makeDb, makeEnv, makeKv, sqliteD1 } from "./support.ts";

const id = (c: string) => `i${c.repeat(11)}`;

describe("GET /installs", () => {
  it("reads install_status, only the five columns it maps", async () => {
    const { db, sqls } = makeDb([]);
    await getJson(makeEnv({ PLATFORM_DB: db }), "/installs");
    expect(sqls).toEqual([INSTALLS_SQL]);
    expect(INSTALLS_SQL).toBe(
      "SELECT install_id, app_host, content_host, state, test_hooks FROM install_status WHERE app_host IS NOT NULL AND content_host IS NOT NULL ORDER BY install_id",
    );
  });

  it("all six states and every mode, on the real view; hostless rows dropped", async () => {
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
    // A signup with no installs row yet: no hosts, left out.
    lifecycle(sq, id("g"));
    signup(sq, { install_id: id("g"), status: "creating" });

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

  it("an empty table is an empty list", async () => {
    expect(
      await getJson(
        makeEnv({ PLATFORM_DB: sqliteD1(platformDb()) }),
        "/installs",
      ),
    ).toEqual({ installs: [] });
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
