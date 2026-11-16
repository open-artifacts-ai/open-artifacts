import { OnboardingPatchSchema, R } from "@oa/shared";
import type { Context } from "hono";
import { caller, capOfCaller, requireUser } from "../auth/authz.js";
import { orgCan } from "../auth/policy.js";
import { jsonBody } from "../http/body.js";
import { ApiError } from "../http/errors.js";
import type { AppEnv } from "../http/middleware.js";
import { getOnboarding, setOnboarding } from "../services/onboarding.js";
import type { AppType } from "./index.js";

/** The caller's own checklist (#2632): any non-guest member; a guest gets 403. */
function member(c: Context<AppEnv>) {
  const user = requireUser(c);
  if (
    !orgCan(user, "onboarding.own", {
      cap: capOfCaller(caller(c)),
      read: c.req.method === "GET",
    })
  )
    throw new ApiError("members_only", "The checklist is for members");
  return user;
}

export function mountOnboarding(app: AppType): void {
  app.get(R.onboarding, async (c) => {
    const user = member(c);
    return c.json(await getOnboarding(c.env, user));
  });

  app.put(R.onboarding, async (c) => {
    const user = member(c);
    const patch = await jsonBody(c, OnboardingPatchSchema);
    return c.json(await setOnboarding(c.env, user, patch));
  });
}
