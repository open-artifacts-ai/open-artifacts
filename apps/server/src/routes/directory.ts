import { DirectoryGroupsQuerySchema, R } from "@oa/shared";
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
  disconnectDirectory,
  finishConnect,
  refuseConnect,
  startConnect,
} from "../directory/connect.js";
import { lookupGroups } from "../directory/groups.js";
import type { Env } from "../env.js";
import { ApiError } from "../http/errors.js";
import { type AppEnv, execCtx } from "../http/middleware.js";
import { userActor } from "../services/audit.js";
import { SYNC_DO_NAME } from "../services/directory.js";
import { directoryMode } from "../services/spaces.js";
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

  // Disconnect (org owner or admin): revoke, wipe, stop sync; memberships
  // stay frozen. Idempotent. Works without a transport too (the wipe still
  // runs; the revoke is then audited revoke_failed).
  const disconnect = (c: Context<AppEnv>) => {
    const user = requireUser(c);
    if (
      !orgCan(user, "directory.disconnect", { cap: capOfCaller(caller(c)) })
    )
      throw notFound();
    return disconnectDirectory(c.env, userActor(user.id), {
      showProblem: manages(c),
    });
  };
  app.post(R.directoryDisconnect, async (c) => c.json(await disconnect(c)));
  app.delete(R.directory, async (c) => {
    await disconnect(c);
    return c.body(null, 204);
  });

  // P3 T13. Live group lookup for the mapping pickers (org owner, admin),
  // RL_DIRECTORY per caller (unbound: unlimited, as in the test pool).
  app.get(R.directoryGroups, async (c) => {
    const user = requireUser(c);
    if (!orgCan(user, "org.mappings", { cap: capOfCaller(caller(c)) }))
      throw notFound();
    const rl = c.env.RL_DIRECTORY;
    if (rl && !(await rl.limit({ key: `dir:${user.id}` })).success)
      throw new ApiError(
        "rate_limited",
        "Too many group lookups; wait a minute",
      );
    const q = DirectoryGroupsQuerySchema.safeParse(c.req.query());
    if (!q.success) throw new ApiError("bad_request", "Invalid query");
    return c.json(await lookupGroups(c.env, q.data));
  });

  // "Sync now" and a held sweep's confirmation (org owner): 202 SyncStatus.
  app.post(R.directorySync, async (c) => {
    if (!manages(c) || !c.env.DIRECTORY_SYNC) throw notFound();
    return c.json(await syncStub(c.env).kick("manual"), 202);
  });

  app.post("/api/v1/directory/held/:groupId/confirm", async (c) => {
    if (!manages(c) || !c.env.DIRECTORY_SYNC) throw notFound();
    // Frozen (or off): group sync is stopped, so a confirm can't apply.
    if (directoryMode(c.env) !== "google")
      throw new ApiError(
        "directory_sync_off",
        "Directory sync is off or frozen",
      );
    const status = await syncStub(c.env).confirmHeld(
      c.req.param("groupId"),
      userActor(requireUser(c).id),
    );
    if (!status)
      throw new ApiError(
        "conflict",
        "This group has no held sweep to confirm; it can't be read from Google",
      );
    return c.json(status, 202);
  });
}

const syncStub = (env: Env) => {
  const ns = env.DIRECTORY_SYNC as NonNullable<Env["DIRECTORY_SYNC"]>;
  return ns.get(ns.idFromName(SYNC_DO_NAME));
};
