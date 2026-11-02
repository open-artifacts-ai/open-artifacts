import { InventoryHealthSchema } from "@oa/shared/provisioning";
import { describe, expect, it } from "vitest";
import {
  insert,
  platformDb,
} from "../../../packages/provision/test/platform-db.ts";
import { HEALTH_SQL, SCHEDULER_TICK_KEY } from "../src/health.ts";
import { REQUIRED_TABLES, SCHEMA_SQL } from "../src/schema.ts";
import { getJson, makeDb, makeEnv, NOW, sqliteD1 } from "./support.ts";

describe("GET /health", () => {
  it("returns the scheduler tick from platform_state", async () => {
    const sq = platformDb();
    insert(sq, "platform_state", {
      key: SCHEDULER_TICK_KEY,
      value: NOW,
      updated_at: NOW,
    });
    insert(sq, "platform_state", {
      key: "job_failed_opened_at",
      value: 1,
      updated_at: 1,
    });
    const body = await getJson(
      makeEnv({ PLATFORM_DB: sqliteD1(sq) }),
      "/health",
    );
    expect(body).toEqual({ schedulerTickAt: NOW });
    expect(InventoryHealthSchema.strict().safeParse(body).success).toBe(true);
  });

  it("an absent row is null", async () => {
    const body = await getJson(
      makeEnv({ PLATFORM_DB: sqliteD1(platformDb()) }),
      "/health",
    );
    expect(body).toEqual({ schedulerTickAt: null });
    expect(InventoryHealthSchema.strict().safeParse(body).success).toBe(true);
  });

  it("binds the key; reads nothing else", async () => {
    const { db, sqls, binds } = makeDb([]);
    await getJson(makeEnv({ PLATFORM_DB: db }), "/health");
    expect(sqls).toEqual([SCHEMA_SQL, HEALTH_SQL]);
    expect(binds).toEqual([[...REQUIRED_TABLES], ["scheduler_tick_at"]]);
  });
});
