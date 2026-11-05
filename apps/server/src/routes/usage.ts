import { R } from "@oa/shared";
import { requireUser } from "../auth/authz.js";
import { authConfig } from "../auth/config.js";
import { orgCan } from "../auth/policy.js";
import { ApiError } from "../http/errors.js";
import { getUsage } from "../services/usage.js";
import type { AppType } from "./index.js";

export function mountUsage(app: AppType): void {
  app.get(R.usage, async (c) => {
    // P3 T19: usage_off (hosted) makes the route absent; the policy gate
    // (offWhen) refuses first, this keeps the handler safe on its own.
    if (authConfig(c.env).features.includes("usage_off"))
      throw new ApiError("not_found", "Not found");
    const user = requireUser(c);
    if (!orgCan(user, "usage.read"))
      throw new ApiError("not_found", "Not found");
    return c.json(await getUsage(c.env));
  });
}
