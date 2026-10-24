import {
  type Member,
  MemberInviteSchema,
  MemberPatchSchema,
  R,
} from "@oa/shared";
import type { Context } from "hono";
import { requireUser } from "../auth/authz.js";
import { orgCan } from "../auth/policy.js";
import { jsonBody } from "../http/body.js";
import { ApiError } from "../http/errors.js";
import { type AppEnv, execCtx } from "../http/middleware.js";
import { resetIdentity } from "../services/identity.js";
import {
  inviteMember,
  listMembers,
  patchMember,
  removeMember,
} from "../services/members.js";
import type { AppType } from "./index.js";

/** Owner/admin only: 401 anonymous, 404 for everyone else (route hidden). */
export function requireManager(c: Context<AppEnv>): Member {
  const user = requireUser(c);
  if (!orgCan(user, "members.manage"))
    throw new ApiError("not_found", "Not found");
  return user;
}

// Literal so Hono infers the :id param; must equal R.member(id).
const MEMBER = "/api/v1/members/:id";

export function mountMembers(app: AppType): void {
  app.get(R.members, async (c) => {
    requireManager(c);
    return c.json(await listMembers(c.env));
  });

  /**
   * Invite; 201 with `emailed`. `emailed:false` after the 3 s send timeout
   * means delivery isn't confirmed: the email may still arrive.
   */
  app.post(R.members, async (c) => {
    const inviter = requireManager(c);
    const input = await jsonBody(c, MemberInviteSchema);
    return c.json(await inviteMember(c.env, inviter, input), 201);
  });

  app.patch(MEMBER, async (c) => {
    requireManager(c);
    const patch = await jsonBody(c, MemberPatchSchema);
    return c.json(
      await patchMember(c.env, c.req.param("id"), patch, execCtx(c)),
    );
  });

  app.delete(MEMBER, async (c) => {
    requireManager(c);
    await removeMember(c.env, c.req.param("id"), execCtx(c));
    return c.body(null, 204);
  });

  // Literal so Hono infers :id; must equal R.memberIdentity(id, "google").
  // Clears an identity_conflict: the member's next Google sign-in links afresh.
  app.delete("/api/v1/members/:id/identities/google", async (c) => {
    const actor = requireManager(c);
    await resetIdentity(c.env, actor, c.req.param("id"), execCtx(c));
    return c.body(null, 204);
  });
}
