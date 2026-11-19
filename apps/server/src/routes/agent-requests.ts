import {
  AgentRequestsSwitchSchema,
  AllowBodySchema,
  AllowChallengeBodySchema,
  ListenAddBodySchema,
  ListenShortenBodySchema,
  R,
} from "@oa/shared";
import type { Context } from "hono";
import { interactiveSession, requireUser } from "../auth/authz.js";
import { jsonBody } from "../http/body.js";
import { ApiError } from "../http/errors.js";
import type { AppEnv } from "../http/middleware.js";
import {
  addListens,
  agentRequestsOn,
  allow,
  allowChallenge,
  askHistory,
  listHeld,
  listListens,
  notNow,
  removeListen,
  setAgentRequests,
  shortenListen,
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

  app.post(`${R.agentAskHeld}/:id/allow`, async (c) => {
    const user = member(c);
    const id = idOf(c);
    const body = await jsonBody(c, AllowBodySchema);
    return c.json(await allow(c.env, user.id, id, body));
  });

  app.post(`${R.agentAskHeld}/:id/allow/challenge`, async (c) => {
    const user = member(c);
    const id = idOf(c);
    const body = await jsonBody(c, AllowChallengeBodySchema);
    return c.json(
      await allowChallenge(c.env, user.id, id, body.until, body.level),
    );
  });

  app.post(`${R.agentAskHeld}/:id/not-now`, async (c) => {
    const user = member(c);
    await notNow(c.env, user.id, idOf(c));
    return c.body(null, 204);
  });

  // #2577 S2: the switch. Reading is any signed-in person's; saving is a browser session only.
  app.get(R.agentRequests, async (c) => {
    const user = requireUser(c);
    return c.json({ on: await agentRequestsOn(c.env, user.id) });
  });
  app.put(R.agentRequests, async (c) => {
    const user = member(c);
    const body = await jsonBody(c, AgentRequestsSwitchSchema);
    return c.json({ on: await setAgentRequests(c.env, user.id, body.on) });
  });

  // #2577 S2: the "listens to" list.
  app.get(R.agentListens, async (c) => {
    const user = member(c);
    return c.json(await listListens(c.env, user.id));
  });
  app.post(R.agentListens, async (c) => {
    const user = member(c);
    const body = await jsonBody(c, ListenAddBodySchema);
    return c.json(await addListens(c.env, user.id, body));
  });
  app.get(R.agentAskHistory, async (c) => {
    const user = member(c);
    return c.json(await askHistory(c.env, user.id));
  });
  app.patch(`${R.agentListens}/:id`, async (c) => {
    const user = member(c);
    const body = await jsonBody(c, ListenShortenBodySchema);
    return c.json(await shortenListen(c.env, user.id, idOf(c), body.until));
  });
  app.delete(`${R.agentListens}/:id`, async (c) => {
    const user = member(c);
    await removeListen(c.env, user.id, idOf(c));
    return c.body(null, 204);
  });
}
