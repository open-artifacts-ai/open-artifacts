// Health (design v7 5.8): once an hour, gated on the */2 tick (the crons
// stay pinned), each routed install's /healthz (HealthProbe). Writes only
// install_lifecycle.health and health_at; C2's unreachable_after_route
// query reads them. A round that would outrun the duty's budget stops
// starting probes and gives the gate back, so the next */2 tick checks the
// rows this round has not (health_at before the round's start).
import { isInstallId } from "@oa/provision/names";
import type { Health } from "@oa/shared/provisioning/enums";
import {
  HEALTH_GATE_KEY,
  HEALTH_INTERVAL_MS,
  HEALTH_ROUND_KEY,
} from "@oa/shared/provisioning/state";
import { DutyFailure, d1, lanes, type ProvapiEnv, within } from "./env.js";
import { claimState, getState, raiseState, unclaimState } from "./state.js";

// HEALTH_GATE_KEY: the hourly gate (HEALTH_INTERVAL_MS). HEALTH_ROUND_KEY:
// while a round is cut short, its start, so the next tick checks only the
// rows not yet checked in it.
export const HEALTH_CONCURRENCY = 3;
export const HEALTH_TIMEOUT_MS = 10_000;
/** The default round budget (index.ts passes the duty's own). */
export const HEALTH_BUDGET_MS = 40_000;
/** Kept back from the budget for the D1 writes after the probes. */
export const HEALTH_BUDGET_SLACK_MS = 2_000;

/**
 * The rows checked. TODO(contract): "mapped row" is not defined (serving_mode
 * serving, paused or closed?); through the public route the paused and
 * closed pages answer instead of the install, so only serving rows are
 * checked. Unmapped and null rows never are.
 */
export const HEALTH_MODES = ["serving"] as const;
const MAPPED = `SELECT l.install_id AS id, i.app_host AS app_host, i.test_hooks AS test_hooks FROM install_lifecycle l JOIN installs i ON i.id = l.install_id WHERE l.serving_mode IN (${HEALTH_MODES.map((m) => `'${m}'`).join(", ")}) AND (l.health_at IS NULL OR l.health_at < ?1) ORDER BY l.health_at IS NOT NULL, l.health_at, l.install_id`;
const WRITE =
  "UPDATE install_lifecycle SET health = ?2, health_at = ?3 WHERE install_id = ?1";

/** One /healthz request for an install; resolves with the raw reply. */
export type HealthProbe = (id: string, appHost: string) => Promise<Response>;

/**
 * The public route: a plain request to https://<app_host>/healthz through
 * the dispatch Worker, with no platform authority. TODO(contract): the plan
 * asked for DISPATCHER.get(script).fetch, but this Worker's tripwire
 * (test/node/dispatcher-source.test.ts) allows only .scheduled( on a
 * dispatch stub, a security rule for the Manager to change or keep. A
 * routeless fetch to a same-account zone host is unverified (design v7 14).
 */
export const publicRouteProbe: HealthProbe = (_id, appHost) =>
  fetch(`https://${appHost}/healthz`, { redirect: "manual" });

/**
 * ok iff 200 and the JSON says ok: true for this install, with testHooks
 * on exactly when the install's test_hooks is (design v7 5 step 7: installId
 * and testHooks must match; /healthz omits testHooks when off). TODO(contract):
 * the provisioner's check is private in C3 wfp.ts (it also wants plan and
 * version); no shared helper.
 */
export async function healthOf(
  probe: HealthProbe,
  id: string,
  appHost: string,
  timeoutMs: number,
  testHooks = false,
): Promise<Health> {
  try {
    return await within(
      (async (): Promise<Health> => {
        const res = await probe(id, appHost);
        if (res.status !== 200) {
          await res.body?.cancel();
          return "failing";
        }
        const j = (await res.json()) as {
          ok?: unknown;
          installId?: unknown;
          testHooks?: unknown;
        };
        return j?.ok === true &&
          j.installId === id &&
          (j.testHooks === true) === testHooks
          ? "ok"
          : "failing";
      })(),
      timeoutMs,
    );
  } catch {
    return "failing";
  }
}

/** True when this tick ran the checks (it won the hourly gate). */
export async function healthDue(
  env: ProvapiEnv,
  now: number,
  {
    timeoutMs = HEALTH_TIMEOUT_MS,
    probe = publicRouteProbe,
    budgetMs = HEALTH_BUDGET_MS,
    clock = Date.now,
  }: {
    timeoutMs?: number;
    probe?: HealthProbe;
    /** The duty's budget: no probe starts that could end past it. */
    budgetMs?: number;
    /** Tests only: elapsed time (default Date.now). */
    clock?: () => number;
  } = {},
): Promise<boolean> {
  const db = env.PLATFORM_DB;
  const started = clock();
  const prev = await d1(getState(db, HEALTH_GATE_KEY));
  if (
    !(await d1(claimState(db, HEALTH_GATE_KEY, now, now - HEALTH_INTERVAL_MS)))
  )
    return false;
  let round: number;
  let results: { id: unknown; app_host: unknown; test_hooks: unknown }[];
  try {
    round = (await getState(db, HEALTH_ROUND_KEY)) ?? now;
    ({ results } = await db
      .prepare(MAPPED)
      .bind(round)
      .all<{ id: unknown; app_host: unknown; test_hooks: unknown }>());
  } catch {
    // Nothing was checked: give the hour back, so the next tick runs it.
    await unclaimState(db, HEALTH_GATE_KEY, now, prev).catch(() => {});
    throw new DutyFailure("db_error");
  }
  const rows = results.filter(
    (r): r is { id: string; app_host: string; test_hooks: unknown } =>
      typeof r.id === "string" &&
      isInstallId(r.id) &&
      typeof r.app_host === "string" &&
      r.app_host !== "",
  );
  let failing = 0;
  let left = 0;
  await lanes(rows, HEALTH_CONCURRENCY, async (r) => {
    // A probe that could end past the budget waits for the next tick.
    if (clock() - started + timeoutMs > budgetMs - HEALTH_BUDGET_SLACK_MS) {
      left++;
      return;
    }
    const h = await healthOf(
      probe,
      r.id,
      r.app_host,
      timeoutMs,
      r.test_hooks === 1,
    );
    if (h === "failing") failing++;
    try {
      await db.prepare(WRITE).bind(r.id, h, now).run();
    } catch {
      console.error("provapi health db_error", r.id);
    }
  });
  if (left > 0) {
    // Cut short: keep the round's start and give the hour back, so the next
    // */2 tick checks the rest.
    await d1(raiseState(db, HEALTH_ROUND_KEY, round, now));
    await d1(unclaimState(db, HEALTH_GATE_KEY, now, prev));
    console.log(
      "provapi health checked",
      `mapped=${rows.length - left}`,
      `failing=${failing}`,
      `left=${left}`,
    );
    return true;
  }
  await d1(unclaimState(db, HEALTH_ROUND_KEY, round, null));
  console.log(
    "provapi health checked",
    `mapped=${rows.length}`,
    `failing=${failing}`,
  );
  return true;
}
