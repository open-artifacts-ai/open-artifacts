import { AllowBodySchema, AllowChallengeBodySchema, R } from "@oa/shared";
import type { Context } from "hono";
import { interactiveSession, requireUser } from "../auth/authz.js";
import { jsonBody } from "../http/body.js";
import { ApiError } from "../http/errors.js";
import type { AppEnv } from "../http/middleware.js";
import {
  allow,
  allowChallenge,
  listHeld,
  notNow,
} from "../services/agent-requests.js";
import type { AppType } from "./index.js";

// #2577: the receiver's side of asking someone else's agent. A browser session
// of the receiver only: a token, an MCP grant, a bus token or any Authorization
// header is 403, and there is no tool for it.

function member(c: Context<AppEnv>) {
  const user = requireUser(c);
  if (!interactiveSession(c))
    throw new ApiError(
      "forbidden",
      "Use the web app in your browser while logged in",
    );
  return user;
}

const idOf = (c: Context<AppEnv>) => {
  const id = c.req.param("id") ?? "";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id))
    throw new ApiError("not_found", "Not found");
  return id;
};

export function mountAgentRequests(app: AppType): void {
  app.get(R.agentAskHeld, async (c) => {
    const user = member(c);
    return c.json(await listHeld(c.env, user.id));
  });

  app.post(R.agentAskHeldAllow(":id"), async (c) => {
    const user = member(c);
    const id = idOf(c);
    const body = await jsonBody(c, AllowBodySchema);
    return c.json(await allow(c.env, user.id, id, body));
  });

  app.post(R.agentAskHeldAllowChallenge(":id"), async (c) => {
    const user = member(c);
    const id = idOf(c);
    const body = await jsonBody(c, AllowChallengeBodySchema);
    return c.json(await allowChallenge(c.env, user.id, id, body.until));
  });

  app.post(R.agentAskHeldNotNow(":id"), async (c) => {
    const user = member(c);
    await notNow(c.env, user.id, idOf(c));
    return c.body(null, 204);
  });
}
