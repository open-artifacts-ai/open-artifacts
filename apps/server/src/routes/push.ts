import {
  PushSubscribeBodySchema,
  PushSubscriptionPatchBodySchema,
  R,
} from "@oa/shared";
import type { Context } from "hono";
import { interactiveSession, requireUser } from "../auth/authz.js";
import { jsonBody } from "../http/body.js";
import { ApiError } from "../http/errors.js";
import type { AppEnv } from "../http/middleware.js";
import {
  addSubscription,
  listSubscriptions,
  patchSubscription,
  removeSubscription,
} from "../services/push.js";
import { pushOn } from "../services/web-push.js";
import type { AppType } from "./index.js";

/**
 * #2512 S5: browser push. With no VAPID key pair on the instance every route
 * answers 404 push_unavailable. Reading is any signed-in person's own; changing
 * a subscription takes a person in a browser (never a token, a grant or an
 * agent).
 */
function pushUser(c: Context<AppEnv>, write: boolean) {
  const user = requireUser(c);
  if (!pushOn(c.env))
    throw new ApiError("push_unavailable", "Push notifications are off");
  if (write && !interactiveSession(c))
    throw new ApiError("not_found", "Not found");
  return user;
}

export function mountPush(app: AppType): void {
  app.get(R.mePushKey, (c) => {
    pushUser(c, false);
    return c.json({ publicKey: (c.env.VAPID_PUBLIC_KEY ?? "").trim() });
  });

  app.get(R.mePushSubscriptions, async (c) => {
    const user = pushUser(c, false);
    return c.json(await listSubscriptions(c.env, user.id));
  });

  app.post(R.mePushSubscriptions, async (c) => {
    const user = pushUser(c, true);
    const body = await jsonBody(c, PushSubscribeBodySchema);
    return c.json({ id: await addSubscription(c.env, user.id, body) }, 201);
  });

  app.patch("/api/v1/me/push/subscriptions/:id", async (c) => {
    const user = pushUser(c, true);
    const body = await jsonBody(c, PushSubscriptionPatchBodySchema);
    const r = await patchSubscription(c.env, user.id, c.req.param("id"), body);
    if (!r) throw new ApiError("not_found", "Not found");
    return c.json(r);
  });

  app.delete("/api/v1/me/push/subscriptions/:id", async (c) => {
    const user = pushUser(c, true);
    if (!(await removeSubscription(c.env, user.id, c.req.param("id"))))
      throw new ApiError("not_found", "Not found");
    return c.body(null, 204);
  });
}
