// The Provisioning API's scheduler duties (design v7 5.8), run on the */2
// tick after the revoke tick and the directory sync.
import { ALERT_KEYS } from "@oa/provisioning-contract/enum-values";
import { alertFor, factsOf, prodcleanReport, stepAlert } from "./alerts.js";
import { alertConditions, signupDailyCap } from "./conditions.js";
import type { ProvapiEnv } from "./env.js";
import { type FleetOptions, fleetDue } from "./fleet.js";
import { type HealthProbe, healthDue } from "./health.js";
import { prune } from "./prune.js";
import { purgeDue } from "./purge.js";
import { type Duty, type DutyOutcome, runDuties } from "./run.js";
import { signupsDue } from "./signups.js";
import { type SweepDeps, sweep } from "./sweep.js";

export { SCHEDULER_TICK_KEY } from "@oa/provisioning-contract/state";
export type { ProvapiEnv } from "./env.js";
export { writeTick } from "./run.js";

/**
 * Each duty's budget: 115 s together, inside the 2 minutes. Ticks may still
 * overlap (a slow D1 call); every duty's writes are guarded for that.
 */
export const DUTY_TIMEOUT_MS = {
  sweep: 20_000,
  signups: 5_000,
  purge: 10_000,
  health: 20_000,
  fleet: 25_000,
  alerts: 30_000,
  prune: 5_000,
} as const satisfies Record<Duty["name"], number>;

/** The scheduler opens and clears every alert here, and only here. */
export async function alertsTick(env: ProvapiEnv, now: number): Promise<void> {
  const c = await alertConditions(
    env.PLATFORM_DB,
    env.PROVISIONER,
    { now, signupDailyCap: signupDailyCap(env.SIGNUP_DAILY_CAP) },
    {
      versionMetadata: env.CF_VERSION_METADATA,
      fleetCanary: env.FLEET_CANARY,
      fleetSmoke: env.FLEET_SMOKE,
    },
  );
  for (const k of ALERT_KEYS) {
    const cond = c[k];
    const report =
      k === "prodclean_failed" && cond.open
        ? await prodcleanReport(env.PLATFORM_DB)
        : undefined;
    const facts = {
      ...factsOf(cond.rows),
      ...(cond.daysLeft === undefined ? {} : { daysLeft: cond.daysLeft }),
      ...(report === undefined ? {} : { report }),
    };
    // stepAlert never throws: one key's failure never stops the next.
    await stepAlert(env, alertFor(k, env.OA_ENV, facts), cond.open, now);
  }
}

export interface ProvapiOptions extends SweepDeps {
  /** Tests only: per-duty budgets. */
  timeoutMs?: Partial<Record<Duty["name"], number>>;
  /** Tests only: the /healthz request (default publicRouteProbe). */
  healthProbe?: HealthProbe;
  /** Tests only: the fleet duty's probe and its timeout. */
  fleet?: FleetOptions;
}

/**
 * Sweep, signups, purge, health, fleet, alerts, prune: in that order, so the
 * alerts read the tick's own sweep, purge, health and fleet writes. Never throws.
 */
export function provapiTick(
  env: ProvapiEnv,
  now: number,
  o: ProvapiOptions = {},
): Promise<Record<string, DutyOutcome>> {
  const t = { ...DUTY_TIMEOUT_MS, ...o.timeoutMs };
  const sweepDeps: SweepDeps = o.settleFailed
    ? { settleFailed: o.settleFailed }
    : {};
  return runDuties([
    {
      name: "sweep",
      timeoutMs: t.sweep,
      run: () => sweep(env, now, sweepDeps),
    },
    {
      name: "signups",
      timeoutMs: t.signups,
      run: () => signupsDue(env, now),
    },
    { name: "purge", timeoutMs: t.purge, run: () => purgeDue(env, now) },
    {
      name: "health",
      timeoutMs: t.health,
      run: async () => {
        await healthDue(env, now, {
          budgetMs: t.health,
          ...(o.healthProbe ? { probe: o.healthProbe } : {}),
        });
      },
    },
    {
      name: "fleet",
      timeoutMs: t.fleet,
      run: () => fleetDue(env, now, o.fleet),
    },
    { name: "alerts", timeoutMs: t.alerts, run: () => alertsTick(env, now) },
    { name: "prune", timeoutMs: t.prune, run: () => prune(env, now) },
  ]);
}
