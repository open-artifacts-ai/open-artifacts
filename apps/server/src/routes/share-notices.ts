import { R } from "@oa/shared";
import type { Context } from "hono";
import { z } from "zod";
import { interactiveSession, requireUser } from "../auth/authz.js";
import { jsonBody } from "../http/body.js";
import { ApiError } from "../http/errors.js";
import type { AppEnv } from "../http/middleware.js";
import { getShareNotices, setShareNotices } from "../services/follows.js";
import type { AppType } from "./index.js";

/** The body's envelope; setShareNotices validates `agents` itself (the /bus page calls it too). */
const Body = z.strictObject({ agents: z.unknown() });

/**
 * #1292: the caller's own "agents that get share notices". The gate allows
 * callers who may connect agents (mcp.connect). Changing it takes a person
 * in a browser: never a PAT, an OAuth grant or a machine token, so no agent
 * can pick where share notices go. Reading it is the gate's rule alone.
 */
function browserUser(c: Context<AppEnv>) {
  const user = requireUser(c);
  if (!interactiveSession(c)) throw new ApiError("not_found", "Not found");
  return user;
}

export function mountShareNotices(app: AppType): void {
  app.get(R.shareNotices, async (c) => {
    const user = requireUser(c);
    return c.json({ agents: await getShareNotices(c.env, user.id) });
  });

  app.put(R.shareNotices, async (c) => {
    const user = browserUser(c);
    const { agents } = await jsonBody(c, Body);
    return c.json({ agents: await setShareNotices(c.env, user.id, agents) });
  });
}
