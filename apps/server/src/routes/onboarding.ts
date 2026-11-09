import { OnboardingPatchSchema, R } from "@oa/shared";
import type { Context } from "hono";
import { caller, capOfCaller, requireUser } from "../auth/authz.js";
import { orgCan } from "../auth/policy.js";
import { jsonBody } from "../http/body.js";
import { ApiError } from "../http/errors.js";
import type { AppEnv } from "../http/middleware.js";
import { getOnboarding, setOnboarding } from "../services/onboarding.js";
import type { AppType } from "./index.js";

function owner(c: Context<AppEnv>) {
  const user = requireUser(c);
  // The gate already refused anyone else (404); belt and braces.
  if (!orgCan(user, "onboarding.manage", { cap: capOfCaller(caller(c)) }))
    throw new ApiError("not_found", "Not found");
  return user;
}

export function mountOnboarding(app: AppType): void {
  app.get(R.onboarding, async (c) => {
    owner(c);
    return c.json(await getOnboarding(c.env));
  });

  app.put(R.onboarding, async (c) => {
    owner(c);
    const patch = await jsonBody(c, OnboardingPatchSchema);
    return c.json(await setOnboarding(c.env, patch));
  });
}
