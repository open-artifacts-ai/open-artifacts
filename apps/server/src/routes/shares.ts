import { isId, ShareInputSchema } from "@oa/shared";
import type { Context } from "hono";
import { requireUser } from "../auth/authz.js";
import { jsonBody } from "../http/body.js";
import { ApiError } from "../http/errors.js";
import { type AppEnv, execCtx } from "../http/middleware.js";
import { deleteShare, listShares, putShare } from "../services/shares.js";
import type { AppType } from "./index.js";

// Literals so Hono infers params; must equal R.shares(id) / R.share(id, email).
const SHARES = "/api/v1/artifacts/:id/shares";
const SHARE = `${SHARES}/:email`;

const idParam = (c: Context<AppEnv>): string => {
  const id = c.req.param("id");
  if (!id || !isId(id)) throw new ApiError("not_found", "Not found");
  return id;
};

export function mountShares(app: AppType): void {
  app.get(SHARES, async (c) => {
    const user = requireUser(c);
    return c.json(await listShares(c.env, user, idParam(c)));
  });

  /**
   * Upsert a share; the result has `emailed`. `emailed:false` after the 3 s
   * send timeout means delivery isn't confirmed: the email may still arrive.
   */
  app.put(SHARES, async (c) => {
    const user = requireUser(c);
    const id = idParam(c);
    const input = await jsonBody(c, ShareInputSchema);
    return c.json(await putShare(c.env, user, id, input, execCtx(c)));
  });

  app.delete(SHARE, async (c) => {
    const user = requireUser(c);
    const id = idParam(c);
    // Hono already decodes the path param.
    await deleteShare(c.env, user, id, c.req.param("email"), execCtx(c));
    return c.body(null, 204);
  });
}
