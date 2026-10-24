import { R } from "@oa/shared";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { caller, capOfCaller, requireUser } from "../auth/authz.js";
import { orgCan } from "../auth/policy.js";
import {
  afterConsent,
  cancelConnect,
  clearDirCookie,
  connectClient,
  dirCookieName,
  directoryStatus,
  finishConnect,
  refuseConnect,
  startConnect,
} from "../directory/connect.js";
import { ApiError } from "../http/errors.js";
import { type AppEnv, execCtx } from "../http/middleware.js";
import type { AppType } from "./index.js";

// Directory connection routes (P3 T12). T13 adds sync, groups and held
// sweeps, and serves R.directory from DirectorySync.

const notFound = () => new ApiError("not_found", "Not found");

const redirect = (location: string, cookie?: string) =>
  new Response(null, {
    status: 302,
    headers: {
      location,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      ...(cookie ? { "set-cookie": cookie } : {}),
    },
  });

/** The org owner may manage the directory (a cap drops it). */
const manages = (c: Context<AppEnv>) =>
  orgCan(requireUser(c), "directory.manage", { cap: capOfCaller(caller(c)) });

export function mountDirectory(app: AppType): void {
  app.get(R.directory, async (c) => {
    const user = requireUser(c);
    if (!orgCan(user, "members.manage", { cap: capOfCaller(caller(c)) }))
      throw notFound();
    return c.json(await directoryStatus(c.env, { showProblem: manages(c) }));
  });

  // 404 without a transport (HOSTED=1 with direct config, or none) or with
  // directory sync off.
  app.get(R.directoryConnect, async (c) => {
    const client = connectClient(c.env);
    if (!client || !manages(c)) throw notFound();
    const { location, cookie } = await startConnect(
      c.env,
      client,
      requireUser(c),
    );
    return redirect(location, cookie);
  });

  app.get(R.directoryCallback, async (c) => {
    const client = connectClient(c.env);
    if (!client) throw notFound();
    const user = requireUser(c);
    const clear = clearDirCookie(c.env);
    if (!manages(c))
      return redirect(
        await refuseConnect(c.env, user, "failed", "not_owner"),
        clear,
      );
    const q = c.req.query();
    return redirect(
      await finishConnect(
        c.env,
        client,
        user,
        {
          code: q.code,
          state: q.state,
          error: q.error,
          bstate: q.bstate,
        },
        getCookie(c, dirCookieName(c.env)),
      ),
      clear,
    );
  });

  // Only the owner who connected, still the org owner (the route policy and
  // manages): anyone else 404. Expired: 409 conflict (afterConsent).
  app.post(R.directoryConfirm, async (c) => {
    const client = connectClient(c.env);
    if (!client || !manages(c)) throw notFound();
    return c.json(
      await afterConsent(c.env, client, requireUser(c), execCtx(c)),
    );
  });

  app.post(R.directoryCancel, async (c) => {
    if (!manages(c)) throw notFound();
    await cancelConnect(c.env, requireUser(c));
    return c.body(null, 204);
  });
}
