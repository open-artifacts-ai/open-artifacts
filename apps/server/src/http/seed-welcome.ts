import type { Member } from "@oa/shared";
import type { Context } from "hono";
import { noteMemberFirst } from "../services/analytics.js";
import { seedWelcome } from "../services/onboarding.js";
import { type AppEnv, execCtx } from "./middleware.js";

/**
 * #2632: seeds the person's Welcome after the sign-in answers, never before
 * it (publishing a page must not slow the redirect). Runs after the response
 * through the request's waitUntil; where there is none (a direct app.fetch in
 * tests) it is awaited. Never throws.
 */
export function seedWelcomeAfter(
  c: Context<AppEnv>,
  user: Member,
): Promise<void> | void {
  const run = seedWelcome(c.env, user);
  const ctx = execCtx(c);
  // #2879: the member's first sign-in is the funnel's first step (a no-op unless analytics is on).
  void noteMemberFirst(c.env, user.id, "signed_up", ctx);
  if (ctx) ctx.waitUntil(run);
  else return run;
}
