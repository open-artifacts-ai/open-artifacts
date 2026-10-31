import { InventoryHealthSchema } from "@oa/shared/provisioning";
import { SCHEDULER_TICK_KEY } from "@oa/shared/provisioning/state";
import { type D1Like, json } from "./http.ts";

// GET /health: the scheduler's dead-man (design v7 5.8). The monitor fails
// when the tick is absent or stale.

export { SCHEDULER_TICK_KEY };
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
