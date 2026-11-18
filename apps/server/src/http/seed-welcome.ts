import type { Member } from "@oa/shared";
import type { Context } from "hono";
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
  if (ctx) ctx.waitUntil(run);
  else return run;
}
