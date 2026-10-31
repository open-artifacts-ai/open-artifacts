import { InventoryHealthSchema } from "@oa/shared/provisioning";
import { type D1Like, json } from "./http.ts";

// GET /health: the scheduler's dead-man (design v7 5.8). The monitor fails
// when the tick is absent or stale.

// TODO(contract): the key is only named in 0006's comment; no @oa/shared
// constant.
export const SCHEDULER_TICK_KEY = "scheduler_tick_at";
export const HEALTH_SQL = "SELECT value FROM platform_state WHERE key = ?1";

export async function health(db: D1Like): Promise<Response> {
  const { results } = await db
    .prepare(HEALTH_SQL)
    .bind(SCHEDULER_TICK_KEY)
    .all();
  const v = (results?.[0] as { value?: unknown } | undefined)?.value;
  return json(
    InventoryHealthSchema.parse({
      schedulerTickAt: typeof v === "number" ? v : null,
    }),
  );
}
