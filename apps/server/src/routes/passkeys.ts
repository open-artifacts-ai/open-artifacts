import {
  PasskeyRegisterBeginBodySchema,
  PasskeyRegisterBodySchema,
  PasskeyRemoveBodySchema,
  PasskeySettingsPatchSchema,
  R,
} from "@oa/shared";
import type { Context } from "hono";
import { interactiveSession, requireUser } from "../auth/authz.js";
import { requireFreshReauth } from "../auth/reauth.js";
import { jsonBody } from "../http/body.js";
import { ApiError } from "../http/errors.js";
import { type AppEnv, execCtx } from "../http/middleware.js";
import {
  cancelRemoval,
  getPasskeySettings,
  listPasskeys,
  putPasskeySettings,
  registerAuthChallenge,
  registerBegin,
  registerFinish,
  removeChallenge,
  removePasskey,
  settingsChallenge,
} from "../services/passkeys.js";
import type { AppType } from "./index.js";

// #2263: passkeys and the "ask for a passkey to approve" settings. Browser
// sessions only: a token, an MCP grant or any Authorization header gets 403.

function member(c: Context<AppEnv>) {
  const user = requireUser(c);
  if (!interactiveSession(c))
    throw new ApiError(
      "forbidden",
      "Use the web app, logged in in your browser",
    );
  return user;
}

const idOf = (c: Context<AppEnv>) => {
  const id = c.req.param("id") ?? "";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id))
    throw new ApiError("not_found", "Not found");
  return id;
};

export function mountPasskeys(app: AppType): void {
  app.get(R.passkeys, async (c) => {
    const user = member(c);
    return c.json(await listPasskeys(c.env, user.id));
  });

  // Registered before the :id routes: "settings" is a path, not an id.
  app.get(R.passkeySettings, async (c) => {
    const user = member(c);
    return c.json(await getPasskeySettings(c.env, user.id));
  });

  app.post(R.passkeySettingsChallenge, async (c) => {
    const user = member(c);
    const body = await jsonBody(c, PasskeySettingsPatchSchema);
    return c.json(await settingsChallenge(c.env, user.id, body));
  });

  app.patch(R.passkeySettings, async (c) => {
    const user = member(c);
    const body = await jsonBody(c, PasskeySettingsPatchSchema);
    return c.json(await putPasskeySettings(c.env, user.id, body));
  });

  app.post(R.passkeyRegisterChallenge, async (c) => {
    const user = member(c);
    requireFreshReauth(c);
    return c.json(await registerAuthChallenge(c.env, user.id));
  });

  app.post(R.passkeyRegisterBegin, async (c) => {
    const user = member(c);
    requireFreshReauth(c);
    const body = await c.req.json().catch(() => undefined);
    const parsed = PasskeyRegisterBeginBodySchema.safeParse(body);
    if (!parsed.success)
      throw new ApiError("bad_request", "Invalid request body");
    return c.json(await registerBegin(c.env, user, parsed.data?.assertion));
  });

  app.post(R.passkeyRegisterFinish, async (c) => {
    const user = member(c);
    requireFreshReauth(c);
    const body = await jsonBody(c, PasskeyRegisterBodySchema);
    const out = await registerFinish(
      c.env,
      user,
      body.credential,
      body.label,
      execCtx(c),
    );
    return c.json(out, 201);
  });

  app.post("/api/v1/passkeys/:id/challenge", async (c) => {
    const user = member(c);
    return c.json(await removeChallenge(c.env, user.id, idOf(c)));
  });

  app.post("/api/v1/passkeys/:id/cancel-removal", async (c) => {
    const user = member(c);
    await cancelRemoval(c.env, user.id, idOf(c));
    return c.body(null, 204);
  });

  app.delete("/api/v1/passkeys/:id", async (c) => {
    const user = member(c);
    const id = idOf(c);
    const body = await c.req.json().catch(() => undefined);
    const parsed = PasskeyRemoveBodySchema.safeParse(body);
    if (!parsed.success)
      throw new ApiError("bad_request", "Invalid request body");
    const assertion = parsed.data?.assertion;
    const how =
      assertion !== undefined && assertion !== null
        ? { assertion }
        : (requireFreshReauth(c), { reauth: true as const });
    const out = await removePasskey(c.env, user, id, how, execCtx(c));
    // 202: a re-auth alone only schedules it, 24 h out; the member is emailed and can cancel.
    if (out.removesAt) return c.json(out, 202);
    return c.body(null, 204);
  });
}
