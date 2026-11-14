// #2479: activation events to PostHog, server-side, hosted only.
//
// One event the first time each activation step happens (the callers hold the
// "wrote the first-time row" signal, so an event fires once). Sent only when
// the instance is hosted AND a POSTHOG_KEY secret is bound: a self-hosted
// instance has no key and makes no call. No browser script anywhere.
//
// The payload is fixed: the instance id as the distinct id, plus
// { instance_id, plan, time }. Never a title, comment text, email or name.
// Best effort: a failed or slow send never fails or delays the user's action,
// and only a warning code is logged (never the payload or the error text).

import { WELCOME_TITLE } from "@oa/shared";
import { billingOn, readPlan } from "../billing/plan.js";
import type { Env } from "../env.js";
import { logWarn } from "../log.js";
import { SELF_TEST, WELCOME_KEY } from "./onboarding.js";

const WELCOME_TITLE_SQL = `title = ?4`;

export type ActivationEvent =
  | "agent_connected"
  | "agent_named"
  | "first_page_published"
  | "agent_replied_to_mention"
  | "first_ask_answered";

/** Default PostHog capture host; POSTHOG_HOST overrides it (EU cloud, a proxy). */
export const POSTHOG_DEFAULT_HOST = "https://us.i.posthog.com";
const SEND_TIMEOUT_MS = 3000;

type Ctx = Pick<ExecutionContext, "waitUntil">;

/** The install id, or null; trimmed like /healthz. */
const installId = (env: Env): string | null => env.INSTALL_ID?.trim() || null;

/**
 * Whether events would be sent: hosted, a key, and an install id. Cheap and
 * synchronous: callers gate their own D1 work on it so a self-hosted instance
 * (or a hosted one before the key exists) pays nothing.
 */
export const analyticsOn = (env: Env): boolean =>
  billingOn(env) && !!env.POSTHOG_KEY?.trim() && installId(env) !== null;

/** The capture URL for the configured host. */
function captureUrl(env: Env): string {
  const host = env.POSTHOG_HOST?.trim() || POSTHOG_DEFAULT_HOST;
  return `${host.replace(/\/+$/, "")}/capture/`;
}

/** Sends one event now; never throws. Exported for the unit tests. */
export async function sendActivation(
  env: Env,
  event: ActivationEvent,
  now = Date.now(),
): Promise<void> {
  if (!analyticsOn(env)) return;
  try {
    const id = installId(env) as string;
    const plan = (await readPlan(env, now).catch(() => null))?.tier ?? null;
    const res = await fetch(captureUrl(env), {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      body: JSON.stringify({
        api_key: env.POSTHOG_KEY?.trim(),
        event,
        distinct_id: id,
        properties: {
          instance_id: id,
          plan,
          time: new Date(now).toISOString(),
          // No location is derived from this server's IP.
          $geoip_disable: true,
        },
      }),
    });
    if (!res.ok)
      logWarn("analytics_send_failed", { code: `http_${res.status}` });
  } catch (e) {
    logWarn("analytics_send_failed", {
      code: e instanceof Error ? e.name : "error",
    });
  }
}

/** Sends the event after the response when there is a ctx, else awaits it; never throws. */
export async function activation(
  env: Env,
  event: ActivationEvent,
  ctx?: Ctx,
): Promise<void> {
  if (!analyticsOn(env)) return;
  const p = sendActivation(env, event);
  // Never awaited: a slow PostHog must not delay the caller (sendActivation never rejects).
  if (ctx) ctx.waitUntil(p);
  else void p;
}

/**
 * Instance-wide first times that no per-user row records (a connection, a
 * published page): one settings row each, written once; true for the call that
 * wrote it. A per-isolate memo skips D1 once an event is known recorded.
 */
const recorded = new Set<ActivationEvent>();
export const resetAnalyticsMemo = () => recorded.clear();

export const firstKey = (event: ActivationEvent) => `analytics:first:${event}`;

/**
 * Records an instance-wide first time and sends its event, once. Touches
 * nothing (no D1, no call) unless analytics is on. Never throws.
 */
export async function noteInstanceFirst(
  env: Env,
  event: "agent_connected" | "first_page_published",
  ctx?: Ctx,
): Promise<void> {
  if (!analyticsOn(env) || recorded.has(event)) return;
  // The D1 claim and the send run after the response, never inline.
  const p = claimFirst(env, event, ctx);
  if (ctx) ctx.waitUntil(p);
  else void p;
}

async function claimFirst(
  env: Env,
  event: "agent_connected" | "first_page_published",
  ctx?: Ctx,
): Promise<void> {
  try {
    // first_page_published counts the checklist's firstArtifact: not the
    // provisioner's self-test, not the seeded Welcome (by id once recorded; by
    // its title while the seed is still being written).
    const gate =
      event === "first_page_published"
        ? `where exists (select 1 from artifacts where deleted_at is null and not ${SELF_TEST}
             and id <> coalesce((select json_extract(value, '$.artifactId') from settings where key = ?3), '')
             and not (${WELCOME_TITLE_SQL} and coalesce((select json_extract(value, '$.artifactId') from settings where key = ?3), '') = ''
               and exists (select 1 from settings where key = ?3)))`
        : "where ?3 is not null and ?4 is not null";
    const r = await env.DB.prepare(
      `insert into settings (key, value) select ?1, ?2 ${gate}
       on conflict (key) do nothing`,
    )
      .bind(firstKey(event), String(Date.now()), WELCOME_KEY, WELCOME_TITLE)
      .run();
    if (r.meta.changes === 0 && event === "first_page_published") return;
    recorded.add(event);
    if (r.meta.changes > 0) await activation(env, event, ctx);
  } catch (e) {
    logWarn("analytics_first_failed", {
      code: e instanceof Error ? e.name : "error",
    });
  }
}
