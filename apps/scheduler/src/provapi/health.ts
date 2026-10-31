// Health (design v7 5.8): once an hour, gated on the */2 tick (the crons
// stay pinned), each routed install's /healthz (HealthProbe). Writes only
// install_lifecycle.health and health_at; C2's unreachable_after_route
// query reads them.
import { isInstallId } from "@oa/provision/names";
import type { Health } from "@oa/shared/provisioning";
import { d1, lanes, type ProvapiEnv, within } from "./env.js";
import { claimState } from "./state.js";

/** TODO(contract): no exported health interval. */
export const HEALTH_INTERVAL_MS = 60 * 60_000;
/** TODO(contract): no gate key in 0006's key list. */
export const HEALTH_GATE_KEY = "health_checked_at";
export const HEALTH_CONCURRENCY = 3;
export const HEALTH_TIMEOUT_MS = 10_000;

/**
 * The rows checked. TODO(contract): "mapped row" is not defined (serving_mode
 * serving, paused or closed?); through the public route the paused and
 * closed pages answer instead of the install, so only serving rows are
 * checked. Unmapped and null rows never are.
 */
export const HEALTH_MODES = ["serving"] as const;
const MAPPED = `SELECT l.install_id AS id, i.app_host AS app_host FROM install_lifecycle l JOIN installs i ON i.id = l.install_id WHERE l.serving_mode IN (${HEALTH_MODES.map((m) => `'${m}'`).join(", ")}) ORDER BY l.install_id`;
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
 * ok iff 200 and the JSON says ok: true for this install. TODO(contract):
 * the provisioner's check is private in C3 wfp.ts (it also wants plan and
 * version); no shared helper.
 */
export async function healthOf(
  probe: HealthProbe,
  id: string,
  appHost: string,
  timeoutMs: number,
): Promise<Health> {
  try {
    return await within(
      (async (): Promise<Health> => {
        const res = await probe(id, appHost);
        if (res.status !== 200) {
          await res.body?.cancel();
          return "failing";
        }
        const j = (await res.json()) as { ok?: unknown; installId?: unknown };
        return j?.ok === true && j.installId === id ? "ok" : "failing";
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
  }: { timeoutMs?: number; probe?: HealthProbe } = {},
): Promise<boolean> {
  const db = env.PLATFORM_DB;
  if (
    !(await d1(claimState(db, HEALTH_GATE_KEY, now, now - HEALTH_INTERVAL_MS)))
  )
    return false;
  const { results } = await d1(
    db.prepare(MAPPED).all<{ id: unknown; app_host: unknown }>(),
  );
  const rows = results.filter(
    (r): r is { id: string; app_host: string } =>
      typeof r.id === "string" &&
      isInstallId(r.id) &&
      typeof r.app_host === "string" &&
      r.app_host !== "",
  );
  let failing = 0;
  await lanes(rows, HEALTH_CONCURRENCY, async (r) => {
    const h = await healthOf(probe, r.id, r.app_host, timeoutMs);
    if (h === "failing") failing++;
    try {
      await db.prepare(WRITE).bind(r.id, h, now).run();
    } catch {
      console.error("provapi health db_error", r.id);
    }
  });
  console.log(
    "provapi health checked",
    `mapped=${rows.length}`,
    `failing=${failing}`,
  );
  return true;
}
