// The Provisioning API duties on the */2 tick (design v7 5.8): the dead-man
// tick first, then each duty in its own try with its own time budget, so one
// failing or hanging duty never stops the others. Failures log one fixed
// line, `provapi <duty> failed <category>`, never error text.
import {
  CfError,
  ProvisionRefused,
  provisionErrorCode,
} from "@oa/provision/jobs";
import { type DutyCategory, DutyFailure, Stall, within } from "./env.js";
import { raiseState } from "./state.js";

/**
 * The monitor's dead-man key (0006). TODO(contract): C2 exports no constant
 * for it, nor for the 10-minute stale threshold the monitor and R27 use.
 */
export const SCHEDULER_TICK_KEY = "scheduler_tick_at";

/** Writes scheduler_tick_at = now (monotonic: a late tick never lowers it). */
export async function writeTick(db: D1Database, now: number): Promise<void> {
  await raiseState(db, SCHEDULER_TICK_KEY, now);
}

export const DUTY_NAMES = [
  "sweep",
  "purge",
  "health",
  "alerts",
  "prune",
] as const;
export type DutyName = (typeof DUTY_NAMES)[number];

export interface Duty {
  name: DutyName;
  /** Past this the duty counts as failed (timeout) and the next one starts. */
  timeoutMs: number;
  run(): Promise<void>;
}

export type DutyOutcome =
  | "ok"
  | DutyCategory
  | ReturnType<typeof provisionErrorCode>;

/** A fixed category for anything a duty threw. */
export function dutyCategory(e: unknown): DutyOutcome {
  if (e instanceof Stall) return "timeout";
  if (e instanceof DutyFailure) return e.category;
  if (e instanceof ProvisionRefused || e instanceof CfError)
    return provisionErrorCode(e);
  return "exception";
}

/** Runs each duty in order, each bounded and isolated. Never throws. */
export async function runDuties(
  duties: readonly Duty[],
): Promise<Record<string, DutyOutcome>> {
  const out: Record<string, DutyOutcome> = {};
  for (const d of duties) {
    try {
      // The duty is called inside the try: a synchronous throw is caught too.
      await within(Promise.resolve().then(d.run), d.timeoutMs);
      out[d.name] = "ok";
    } catch (e) {
      const cat = dutyCategory(e);
      out[d.name] = cat;
      console.error("provapi", d.name, "failed", cat);
    }
  }
  return out;
}
