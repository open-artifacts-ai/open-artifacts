import {
  ALERT_CONDITIONS,
  ALERT_KEYS,
  type AlertKey,
  type AlertRow,
  type Attention,
  alertParams,
  HealthSchema,
  type InstallState,
  InstallStateSchema,
  JobKindSchema,
  RPC_ALERT_KEYS,
  SQL_ALERT_KEYS,
  ServingModeSchema,
  WORLD_CAPS,
  type World,
} from "@oa/shared/provisioning";
import type { Env } from "../env.js";
import {
  type JobRow,
  jobItemOf,
  mismatchOf,
  STATUS_SELECT,
  type StatusRow,
  summaryOf,
} from "../model.js";
import { releases, tokenStatus } from "../services/cache.js";
import type { HandlerArgs } from "./handlers.js";
import type { RouteResult } from "./invoke.js";

// R27 GET /world (design v7 9A.5): the state of the world in one call. Reads
// only D1 and the two cached ProvisionerRpc calls. `attention` runs the C2
// alert-condition queries, the same SQL the scheduler runs (no second copy
// of the rules), then adds open alerts no row covered and install_status
// rows in failed, failing health or mismatch that no row covered.

/** The scheduler's tick is stale after this (the monitor's dead-man). */
export const SCHEDULER_STALE_MS = 10 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

/**
 * The API does not know the scheduler's SIGNUP_DAILY_CAP; 0 keeps the
 * `signup_cap` query shut here, and an open one still shows from
 * platform_state (W4 concern).
 */
const SIGNUP_DAILY_CAP = 0;

const zeroes = <K extends string>(keys: readonly K[]) =>
  Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;

const jobKind = (k: string | null) => {
  const r = JobKindSchema.safeParse(k);
  return r.success ? r.data : null;
};

export async function world(a: HandlerArgs): Promise<RouteResult> {
  const { env } = a;
  const now = Date.now();
  const db = env.PLATFORM_DB;

  const [counts, items, jobCounts, recent, state, prodClean] = await db.batch<
    Record<string, unknown>
  >([
    db.prepare(
      "SELECT state, serving_mode, health, COUNT(*) AS n FROM install_status GROUP BY state, serving_mode, health",
    ),
    db.prepare(
      `${STATUS_SELECT} ORDER BY st.created_at DESC, st.install_id DESC LIMIT ${WORLD_CAPS.installs}`,
    ),
    db
      .prepare(
        `SELECT
  (SELECT COUNT(*) FROM jobs WHERE status IN ('queued', 'running')) AS active,
  (SELECT COUNT(*) FROM jobs WHERE status = 'failed' AND COALESCE(finished_at, updated_at) > ?1) AS failed24h`,
      )
      .bind(now - DAY_MS),
    db.prepare(
      `SELECT * FROM jobs ORDER BY created_at DESC, id DESC LIMIT ${WORLD_CAPS.recentJobs}`,
    ),
    db.prepare("SELECT key, value FROM platform_state"),
    db.prepare(
      "SELECT at, ok, code FROM prodclean_reports ORDER BY id DESC LIMIT 1",
    ),
  ]);

  const byState = zeroes(InstallStateSchema.options);
  const byServingMode = zeroes(ServingModeSchema.options);
  const byHealth = zeroes(HealthSchema.options);
  let total = 0;
  for (const r of (counts?.results ?? []) as {
    state: InstallState;
    serving_mode: string | null;
    health: string;
    n: number;
  }[]) {
    total += r.n;
    byState[r.state] += r.n;
    byServingMode[ServingModeSchema.catch("unmapped").parse(r.serving_mode)] +=
      r.n;
    byHealth[HealthSchema.catch("unknown").parse(r.health)] += r.n;
  }

  const kv = new Map(
    ((state?.results ?? []) as { key: string; value: number }[]).map((r) => [
      r.key,
      r.value,
    ]),
  );
  const openedAt = (k: AlertKey) => kv.get(`${k}_opened_at`) ?? null;

  const [rel, token] = await Promise.all([releases(env), tokenStatus(env)]);
  const attention = await attentionOf(env, now, openedAt, token.status);
  const tickAt = kv.get("scheduler_tick_at") ?? null;
  const pc = prodClean?.results[0] as
    | { at: number; ok: number; code: string }
    | undefined;
  const j = jobCounts?.results[0] as { active: number; failed24h: number };

  const body: World = {
    env: env.OA_ENV,
    at: now,
    installs: {
      total,
      byState,
      byServingMode,
      byHealth,
      items: ((items?.results ?? []) as StatusRow[]).map((r) =>
        summaryOf(env, r),
      ),
    },
    jobs: {
      active: j.active,
      failed24h: j.failed24h,
      recent: ((recent?.results ?? []) as JobRow[]).map(jobItemOf),
    },
    attention: attention.items,
    truncated: total > WORLD_CAPS.installs || attention.truncated,
    releases: {
      latest: rel.find((r) => r.latest)?.version ?? null,
      installable: rel.filter((r) => r.installable).length,
    },
    provisioningToken: { status: token.status, daysLeft: token.daysLeft },
    scheduler: {
      tickAt,
      stale: tickAt === null || now - tickAt > SCHEDULER_STALE_MS,
    },
    prodClean: pc ? { at: pc.at, ok: pc.ok === 1, code: pc.code } : null,
    signups: env.SIGNUPS_ENABLED,
  };
  return { status: 200, body, headers: {} };
}

/** Every C2 alert-condition row, with its key, in ALERT_KEYS order. */
export async function alertRows(
  env: Env,
  now: number,
): Promise<[AlertKey, AlertRow][]> {
  const db = env.PLATFORM_DB;
  const res = await db.batch<AlertRow>(
    SQL_ALERT_KEYS.map((k) =>
      db
        .prepare(ALERT_CONDITIONS[k].sql)
        .bind(...alertParams(k, { now, signupDailyCap: SIGNUP_DAILY_CAP })),
    ),
  );
  return SQL_ALERT_KEYS.flatMap((k, i) =>
    (res[i]?.results ?? []).map((r): [AlertKey, AlertRow] => [k, r]),
  );
}

async function attentionOf(
  env: Env,
  now: number,
  openedAt: (k: AlertKey) => number | null,
  token: "active" | "expiring" | "invalid",
): Promise<{ items: Attention[]; truncated: boolean }> {
  const rows = await alertRows(env, now);
  // Every install an item may name: the candidates below and the rows' own.
  const named = [...new Set(rows.flatMap(([, r]) => r.install_id ?? []))];
  const installs = new Map(
    (
      await env.PLATFORM_DB.prepare(
        `${STATUS_SELECT} WHERE st.state = 'failed' OR st.health = 'failing' OR st.serving_mode IS NOT NULL
  OR st.install_id IN (SELECT value FROM json_each(?))`,
      )
        .bind(JSON.stringify(named))
        .all<StatusRow>()
    ).results.map((r) => [r.install_id, r]),
  );
  const out: Attention[] = [];
  const covered = new Set<string>();
  const keys = new Set<string>();
  const item = (
    kind: Attention["kind"],
    installId: string | null,
    o: Partial<Attention> & { since: number },
  ): Attention => {
    const r = installId ? installs.get(installId) : undefined;
    return {
      kind,
      open: (ALERT_KEYS as readonly string[]).includes(kind)
        ? openedAt(kind as AlertKey) !== null
        : false,
      installId,
      slug: r?.slug ?? null,
      state: r?.state ?? null,
      jobId: null,
      jobKind: null,
      code: null,
      message: null,
      ...o,
    };
  };

  for (const [k, r] of rows) {
    keys.add(k);
    if (r.install_id) covered.add(r.install_id);
    out.push(
      item(k, r.install_id, {
        jobId: r.job_id,
        jobKind: jobKind(r.job_kind),
        code: r.code,
        message: r.message === null ? null : r.message.slice(0, 200),
        since: r.since,
      }),
    );
  }
  // The token alerts come from tokenStatus(), not D1 (C2 RPC_ALERT_KEYS).
  for (const k of RPC_ALERT_KEYS)
    if (k === `token_${token}`) {
      keys.add(k);
      out.push(item(k, null, { code: token, since: openedAt(k) ?? now }));
    }
  // An open alert no row covered (the scheduler opened it and has not
  // cleared it yet): one item, no install.
  for (const k of ALERT_KEYS) {
    const at = openedAt(k);
    if (at !== null && !keys.has(k)) out.push(item(k, null, { since: at }));
  }
  for (const r of installs.values()) {
    if (covered.has(r.install_id)) continue;
    const m = mismatchOf(r);
    if (r.state === "failed")
      out.push(item("install_failed", r.install_id, { since: r.updated_at }));
    else if (r.health === "failing")
      out.push(
        item("health_failing", r.install_id, {
          code: "health_failing",
          since: r.health_at ?? r.updated_at,
        }),
      );
    else if (m)
      out.push(
        item("mismatch", r.install_id, {
          code: "mismatch",
          message: m,
          since: r.updated_at,
        }),
      );
  }
  out.sort((x, y) => y.since - x.since);
  return {
    items: out.slice(0, WORLD_CAPS.attention),
    truncated: out.length > WORLD_CAPS.attention,
  };
}
