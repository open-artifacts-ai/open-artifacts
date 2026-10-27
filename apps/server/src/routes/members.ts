import {
  type Member,
  MemberInviteSchema,
  MemberPatchSchema,
  MembersQuerySchema,
  R,
  TransferInputSchema,
} from "@oa/shared";
import type { Context } from "hono";
import { caller, capOfCaller, requireUser } from "../auth/authz.js";
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
import {
  requireSpaces,
  transferPersonal,
  transferSummary,
} from "../services/spaces.js";
import type { AppType } from "./index.js";

/** Owner/admin only: 401 anonymous, 404 for everyone else (route hidden). */
export function requireManager(c: Context<AppEnv>): Member {
  const user = requireUser(c);
  // Under the caller's cap: a capped admin (e.g. a code session) is 404.
  if (!orgCan(user, "members.manage", { cap: capOfCaller(caller(c)) }))
    throw new ApiError("not_found", "Not found");
  return user;
}

/** An uncapped org owner or admin with spaces on (P3 T10), else 404. */
function requireDeparted(c: Context<AppEnv>): Member {
  requireSpaces(c.env);
  const user = requireUser(c);
  if (!orgCan(user, "transfer.departed", { cap: capOfCaller(caller(c)) }))
    throw new ApiError("not_found", "Not found");
  return user;
}

// Literal so Hono infers the :id param; must equal R.member(id).
const MEMBER = "/api/v1/members/:id";

export function mountMembers(app: AppType): void {
  app.get(R.members, async (c) => {
    requireManager(c);
    const q = MembersQuerySchema.safeParse(c.req.query());
    if (!q.success)
      throw new ApiError("bad_request", "Invalid query", q.error.issues);
    return c.json(await listMembers(c.env, q.data.status));
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
    const actor = requireManager(c);
    const patch = await jsonBody(c, MemberPatchSchema);
    return c.json(
      await patchMember(c.env, c.req.param("id"), patch, actor, execCtx(c)),
    );
  });

  app.delete(MEMBER, async (c) => {
    const actor = requireManager(c);
    await removeMember(c.env, c.req.param("id"), actor, execCtx(c));
    return c.body(null, 204);
  });

  // A departed member's personal artifacts (P3 T10). Literal so Hono infers
  // :id; must equal R.memberTransfer(id).
  app.get("/api/v1/members/:id/transfer", async (c) => {
    requireDeparted(c);
    return c.json(await transferSummary(c.env, c.req.param("id")));
  });

  app.post("/api/v1/members/:id/transfer", async (c) => {
    const actor = requireDeparted(c);
    const input = await jsonBody(c, TransferInputSchema);
    return c.json(
      await transferPersonal(
        c.env,
        actor,
        c.req.param("id"),
        input,
        execCtx(c),
      ),
    );
  });

  // Literal so Hono infers :id; must equal R.memberIdentity(id, "google").
  // Clears an identity_conflict: the member's next Google sign-in links afresh.
  app.delete("/api/v1/members/:id/identities/google", async (c) => {
    const actor = requireManager(c);
    await resetIdentity(c.env, actor, c.req.param("id"), execCtx(c));
    return c.body(null, 204);
  });
}
