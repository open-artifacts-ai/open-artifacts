// The first-run "Get started" checklist's state, install-wide, in the
// settings table: one row per flag, written once (the first time is kept).
// The dashboard derives each step from real data (a connection, an artifact,
// an invited member); the server keeps only what data cannot say: that the
// owner hid the list, and that every step was once done (so removing a
// member later never brings it back).

import type { Onboarding, OnboardingPatch } from "@oa/shared";
import { stmt } from "../db/stmt.js";
import type { Env } from "../env.js";

export const DISMISSED_KEY = "onboarding:dismissed";
export const COMPLETED_KEY = "onboarding:completed";

const SET = `insert into settings (key, value) values (?1, ?2)
  on conflict (key) do nothing`;

export async function getOnboarding(env: Env): Promise<Onboarding> {
  const { results } = await stmt(
    env.DB,
    "select key from settings where key in (?1, ?2)",
  )
    .bind(DISMISSED_KEY, COMPLETED_KEY)
    .all<{ key: string }>();
  const keys = new Set(results.map((r) => r.key));
  return {
    dismissed: keys.has(DISMISSED_KEY),
    completed: keys.has(COMPLETED_KEY),
  };
}

/** Turns on the flags in `patch`; the route checks who may. */
export async function setOnboarding(
  env: Env,
  patch: OnboardingPatch,
): Promise<Onboarding> {
  const now = String(Date.now());
  const writes = [
    patch.dismissed ? stmt(env.DB, SET).bind(DISMISSED_KEY, now) : null,
    patch.completed ? stmt(env.DB, SET).bind(COMPLETED_KEY, now) : null,
  ].filter((s) => s !== null);
  if (writes.length) await env.DB.batch(writes);
  return getOnboarding(env);
}
