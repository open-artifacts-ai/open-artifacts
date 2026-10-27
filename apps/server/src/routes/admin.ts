import { R } from "@oa/shared";
import { caller, capOfCaller, requireUser } from "../auth/authz.js";
import { authConfig } from "../auth/config.js";
import { orgCan } from "../auth/policy.js";
import { stmt } from "../db/stmt.js";
import type { Env } from "../env.js";
import { ApiError } from "../http/errors.js";
import { logInfo } from "../log.js";
import { audit, userActor } from "../services/audit.js";
import {
  BROKER_CHECK_COOLDOWN_MS,
  type BrokerCheck,
  type BrokerCheckResult,
  checkBrokers,
} from "../services/broker-check.js";
import type { AppType } from "./index.js";

// Instance administration (org owner).

/**
 * RL_AUTH units one check spends. RL_AUTH allows 20 a minute per key, so an
 * install gets 2 checks a minute: each check costs every broker a slot in
 * its per-IP bucket, which installs behind a binding or props may share.
 */
export const BROKER_CHECK_RL_UNITS = 10;

/** What the audit row keeps of one result: no body, code or URL. */
const summary = (r: BrokerCheckResult) => ({
  ok: r.ok,
  status: r.status,
  transport: r.transport,
  ...(r.skipped ? { skipped: r.skipped } : {}),
  ...(r.error ? { error: r.error } : {}),
});

/** A summary read back from the audit row, as a cached result. */
function cachedOf(v: unknown): BrokerCheckResult | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  if (typeof r.ok !== "boolean" || typeof r.status !== "number") return null;
  return {
    ok: r.ok,
    status: r.status,
    ms: 0,
    transport: (r.transport ?? null) as BrokerCheckResult["transport"],
    ...(r.skipped === "no_broker" ? { skipped: "no_broker" as const } : {}),
    ...(typeof r.error === "string"
      ? { error: r.error as BrokerCheckResult["error"] }
      : {}),
    cached: true,
  };
}

/** The last check's result when it ran within the cooldown (this install's D1). */
async function recent(env: Env): Promise<BrokerCheck | null> {
  const row = await stmt(
    env.DB,
    "select detail from audit_events where at > ?1 and action = 'auth.broker_check' order by at desc limit 1",
  )
    .bind(Date.now() - BROKER_CHECK_COOLDOWN_MS)
    .first<{ detail: string }>();
  if (!row) return null;
  try {
    const d = JSON.parse(row.detail) as Record<string, unknown>;
    const auth = cachedOf(d.auth);
    const directory = cachedOf(d.directory);
    return auth && directory ? { auth, directory } : null;
  } catch {
    return null;
  }
}

export function mountAdmin(app: AppType): void {
  // Proves the install reaches its brokers (services/broker-check.ts). The
  // org owner only, by any credential that reaches /api/v1 (session or
  // PAT): anyone else, admins included, gets 404. Within 30 s of the last
  // check, its result again (cached: true, no broker call, no audit row).
  // Else RL_AUTH per install, BROKER_CHECK_RL_UNITS a check (429 over it);
  // unbound (the test pool, dev): unlimited.
  app.post(R.adminBrokerCheck, async (c) => {
    const user = requireUser(c);
    if (!orgCan(user, "broker.check", { cap: capOfCaller(caller(c)) }))
      throw new ApiError("not_found", "Not found");
    const last = await recent(c.env);
    if (last) return c.json(last);
    const rl = c.env.RL_AUTH;
    if (rl) {
      const key = `broker-check:${authConfig(c.env).installKey}`;
      for (let i = 0; i < BROKER_CHECK_RL_UNITS; i++)
        if (!(await rl.limit({ key })).success)
          throw new ApiError(
            "rate_limited",
            "Too many broker checks; wait a minute",
          );
    }
    const out = await checkBrokers(c.env);
    await audit(
      c.env,
      "auth.broker_check",
      { type: "directory", id: "brokers" },
      userActor(user.id),
      {
        detail: { auth: summary(out.auth), directory: summary(out.directory) },
      },
    ).run();
    logInfo("broker_check", {
      auth_ok: out.auth.ok,
      auth_status: out.auth.status,
      auth_transport: out.auth.transport,
      directory_ok: out.directory.ok,
      directory_status: out.directory.status,
      directory_transport: out.directory.transport,
    });
    return c.json(out);
  });
}
