import {
  GroupMappingPutSchema,
  R,
  SpaceCreateSchema,
  SpaceMemberPutSchema,
  SpaceMembersQuerySchema,
  SpacePatchSchema,
  SpacesQuerySchema,
} from "@oa/shared";
import type { Context } from "hono";
import { caller, capOfCaller, requireUser } from "../auth/authz.js";
import { type OrgAction, orgCan } from "../auth/policy.js";
import { jsonBody } from "../http/body.js";
import { ApiError } from "../http/errors.js";
import { type AppEnv, execCtx } from "../http/middleware.js";
import {
  createSpace,
  deleteOrgMapping,
  deleteRestrictedGroup,
  deleteSpace,
  deleteSpaceMapping,
  deleteSpaceMember,
  getSpace,
  listOrgMappings,
  listRestrictedGroups,
  listSpaceMappings,
  listSpaceMembers,
  listSpaces,
  patchSpace,
  putOrgMapping,
  putRestrictedGroup,
  putSpaceMapping,
  putSpaceMember,
  requireSpaces,
  selfAddSpace,
  setMemberRestricted,
} from "../services/spaces.js";
import type { AppType } from "./index.js";

// The spaces API (P3 T9; contract hosted/spaces.ts). Every route is 404
// without the `spaces` feature. The route policy gate admits signed-in
// callers (and org admins on the admin-only routes); the services apply the
// per-space rules: 404 for no access, the contract's 403s, audit, revocation.
// Literal paths so Hono infers the params; each equals its R.* builder.
const SPACE = "/api/v1/spaces/:id";
const MEMBER = "/api/v1/spaces/:id/members/:userId";
const MAPPING = "/api/v1/spaces/:id/mappings/:groupId";
const ORG_MAPPING = "/api/v1/directory/org-mappings/:groupId";
const RESTRICTED = "/api/v1/directory/restricted-groups/:groupId";
const MEMBER_RESTRICTED = "/api/v1/members/:id/restricted";

/** A query string against a strict schema; 400 bad_request otherwise. */
function query<T>(
  c: Context<AppEnv>,
  schema: {
    safeParse(
      x: unknown,
    ):
      | { success: true; data: T }
      | { success: false; error: { issues: unknown } };
  },
): T {
  const r = schema.safeParse(c.req.query());
  if (!r.success)
    throw new ApiError("bad_request", "Invalid query", r.error.issues);
  return r.data;
}

/** The spaces feature, then a signed-in caller. */
function spacesCaller(c: Context<AppEnv>) {
  requireSpaces(c.env);
  requireUser(c);
  return caller(c);
}

/** Org owner or admin for `action` (a cap drops it), else 404. */
function orgAdmin(c: Context<AppEnv>, action: OrgAction) {
  requireSpaces(c.env);
  const user = requireUser(c);
  if (!orgCan(user, action, { cap: capOfCaller(caller(c)) }))
    throw new ApiError("not_found", "Not found");
  return user;
}

/** ?cursor&limit for the Every-space mappings page (limit 1..200, default 50). */
function pageOf(c: Context<AppEnv>): { cursor?: string; limit: number } {
  const raw = c.req.query("limit");
  const limit = raw === undefined ? 50 : Number(raw);
  if (!/^\d+$/.test(raw ?? "50") || limit < 1 || limit > 200)
    throw new ApiError("bad_request", "Invalid limit", {
      path: "limit",
      reason: "invalid",
    });
  return { cursor: c.req.query("cursor"), limit };
}

export function mountSpaces(app: AppType): void {
  app.get(R.spaces, async (c) => {
    const who = spacesCaller(c);
    return c.json(await listSpaces(c.env, who, query(c, SpacesQuerySchema)));
  });

  app.post(R.spaces, async (c) => {
    const who = spacesCaller(c);
    const input = await jsonBody(c, SpaceCreateSchema);
    return c.json(await createSpace(c.env, who, input), 201);
  });

  app.get(SPACE, async (c) => {
    const who = spacesCaller(c);
    return c.json(await getSpace(c.env, who, c.req.param("id")));
  });

  app.patch(SPACE, async (c) => {
    const who = spacesCaller(c);
    const patch = await jsonBody(c, SpacePatchSchema);
    return c.json(
      await patchSpace(c.env, who, c.req.param("id"), patch, execCtx(c)),
    );
  });

  app.delete(SPACE, async (c) => {
    const who = spacesCaller(c);
    await deleteSpace(c.env, who, c.req.param("id"));
    return c.body(null, 204);
  });

  app.get(`${SPACE}/members`, async (c) => {
    const who = spacesCaller(c);
    return c.json(
      await listSpaceMembers(
        c.env,
        who,
        c.req.param("id"),
        query(c, SpaceMembersQuerySchema),
      ),
    );
  });

  app.post(`${SPACE}/members/self`, async (c) => {
    orgAdmin(c, "space.adminSelfAdd");
    const { role } = await jsonBody(c, SpaceMemberPutSchema);
    return c.json(
      await selfAddSpace(c.env, caller(c), c.req.param("id"), role, execCtx(c)),
      201,
    );
  });

  app.put(MEMBER, async (c) => {
    const who = spacesCaller(c);
    const { role } = await jsonBody(c, SpaceMemberPutSchema);
    return c.json(
      await putSpaceMember(
        c.env,
        who,
        c.req.param("id"),
        c.req.param("userId"),
        role,
        execCtx(c),
      ),
    );
  });

  app.delete(MEMBER, async (c) => {
    const who = spacesCaller(c);
    await deleteSpaceMember(
      c.env,
      who,
      c.req.param("id"),
      c.req.param("userId"),
      execCtx(c),
    );
    return c.body(null, 204);
  });

  app.get(`${SPACE}/mappings`, async (c) => {
    const who = spacesCaller(c);
    return c.json(await listSpaceMappings(c.env, who, c.req.param("id")));
  });

  app.put(MAPPING, async (c) => {
    const who = spacesCaller(c);
    const { role } = await jsonBody(c, GroupMappingPutSchema);
    return c.json(
      await putSpaceMapping(
        c.env,
        who,
        c.req.param("id"),
        c.req.param("groupId"),
        role,
        execCtx(c),
      ),
    );
  });

  app.delete(MAPPING, async (c) => {
    const who = spacesCaller(c);
    await deleteSpaceMapping(
      c.env,
      who,
      c.req.param("id"),
      c.req.param("groupId"),
      execCtx(c),
    );
    return c.body(null, 204);
  });

  app.get(R.orgMappings, async (c) => {
    orgAdmin(c, "org.mappings");
    const { cursor, limit } = pageOf(c);
    return c.json(await listOrgMappings(c.env, cursor, limit));
  });

  app.put(ORG_MAPPING, async (c) => {
    const user = orgAdmin(c, "org.mappings");
    const { role } = await jsonBody(c, GroupMappingPutSchema);
    return c.json(
      await putOrgMapping(
        c.env,
        user,
        c.req.param("groupId"),
        role,
        execCtx(c),
      ),
    );
  });

  app.delete(ORG_MAPPING, async (c) => {
    const user = orgAdmin(c, "org.mappings");
    await deleteOrgMapping(c.env, user, c.req.param("groupId"), execCtx(c));
    return c.body(null, 204);
  });

  app.get(R.restrictedGroups, async (c) => {
    orgAdmin(c, "restricted.groups");
    return c.json(await listRestrictedGroups(c.env));
  });

  app.put(RESTRICTED, async (c) => {
    const user = orgAdmin(c, "restricted.groups");
    return c.json(
      await putRestrictedGroup(c.env, user, c.req.param("groupId"), execCtx(c)),
    );
  });

  app.delete(RESTRICTED, async (c) => {
    const user = orgAdmin(c, "restricted.groups");
    await deleteRestrictedGroup(c.env, user, c.req.param("groupId"));
    return c.body(null, 204);
  });

  for (const method of ["put", "delete"] as const)
    app[method](MEMBER_RESTRICTED, async (c) => {
      const user = orgAdmin(c, "restricted.member");
      return c.json(
        await setMemberRestricted(
          c.env,
          user,
          c.req.param("id"),
          method === "put",
          execCtx(c),
        ),
      );
    });
}
