import {
  MCP_PATH,
  type Me,
  type Member,
  MePatchSchema,
  type NoticeId,
  parseTier,
  planOf,
  R,
  type Tier,
} from "@oa/shared";
import type { Context } from "hono";
import { caller, capOfCaller, requireUser } from "../auth/authz.js";
import { orgCan } from "../auth/policy.js";
import {
  instanceFeatures,
  instanceSignIn,
  showsSignInFields,
} from "../auth/sign-in.js";
import { instanceDirectory, readHealth } from "../directory/health.js";
import { emailEnabled } from "../email/send.js";
import { jsonBody } from "../http/body.js";
import { ApiError, appOrigin } from "../http/errors.js";
import type { AppEnv } from "../http/middleware.js";
import { logWarn } from "../log.js";
import { getSettingsKv, toSettings } from "../services/members.js";
import { dismissNotice, meNotices } from "../services/notices.js";
import { instanceUpdate, RELEASE_KEY } from "../services/release.js";
import { directoryMode, mySharedSpaces, spacesOn } from "../services/spaces.js";
import { getProfile, type Profile, setDisplayName } from "../services/users.js";
import type { AppType } from "./index.js";

/**
 * A hosted install's TIER (trial | team | business), or null. Unset is null
 * quietly; any other value is a provisioning mistake: null and a log line
 * (the event only, never the value).
 */
function hostedTier(raw: string | undefined): Tier | null {
  const t = parseTier(raw);
  if (t === null && (raw ?? "").trim() !== "") logWarn("tier_unknown");
  return t;
}

async function toMe(
  c: Context<AppEnv>,
  user: Member,
  profile: Profile,
): Promise<Me> {
  const kv = await getSettingsKv(c.env);
  const s = toSettings(kv);
  const appUrl = appOrigin(c.env);
  const me: Me = {
    user,
    instance: {
      name: s.name,
      defaultVisibility: s.defaultVisibility,
      appUrl,
      mcpUrl: appUrl + MCP_PATH,
      emailEnabled: emailEnabled(c.env),
      plan: planOf(c.env.PLAN),
      // Hosted tenants are upgraded by the platform: no self-host nudge
      // (review item 39).
      update:
        c.env.HOSTED === "1"
          ? null
          : instanceUpdate(user.role, kv.get(RELEASE_KEY)),
    },
    ...profile,
  };
  const cap = capOfCaller(caller(c));
  // Parity 2: one-time notices of guest shares, Access-only installs only.
  const notices = await meNotices(c.env, user, cap, kv);
  if (notices) me.notices = notices;
  // Hosted M1 (#359): optional, appended last, only on hosted or
  // direct-sign-in installs, so Access-only installs keep today's shape.
  if (!showsSignInFields(c.env)) return me;
  const exp = c.var.sessionExp;
  me.instance.hosted = c.env.HOSTED === "1";
  // Reported only (behaviour follows FEATURES, which provisioning derives
  // from TIER); null off hosted.
  me.instance.tier = me.instance.hosted ? hostedTier(c.env.TIER) : null;
  // Owners also see why configured sign-in is off (AuthConfig.problems).
  me.instance.signIn = instanceSignIn(
    c.env,
    orgCan(user, "signin.problems", { cap }),
  );
  me.instance.features = instanceFeatures(c.env);
  // P3 T13: only while a directory mode is on; health for owners and admins.
  const mode = directoryMode(c.env);
  if (mode !== "off")
    me.instance.directory = instanceDirectory(
      mode,
      await readHealth(c.env),
      orgCan(user, "members.manage", { cap }),
    );
  me.auth = {
    method: c.var.authMethod ?? "access",
    readOnly: cap !== null,
    cap,
    expiresAt: exp === null ? null : new Date(exp).toISOString(),
  };
  // Hosted M1 item 2: the caller's spaces, only with the spaces feature.
  if (spacesOn(c.env)) {
    me.personalSpaceId = user.id;
    me.spaces = await mySharedSpaces(c.env, caller(c));
  }
  return me;
}

export function mountMe(app: AppType): void {
  app.get(R.me, async (c) => {
    const user = requireUser(c);
    return c.json(await toMe(c, user, await getProfile(c.env, user.id)));
  });

  // Session (CSRF-guarded by csrf() in createApp) or PAT; guests included.
  app.patch(R.me, async (c) => {
    const user = requireUser(c);
    const { displayName } = await jsonBody(c, MePatchSchema);
    const { member, profile } = await setDisplayName(
      c.env,
      user.id,
      displayName,
    );
    return c.json(await toMe(c, member, profile));
  });

  // Parity 2: dismiss a notice (R.noticeDismiss). Literal per id, so each
  // has its own gate rule; an unknown id has no route (404).
  const dismiss =
    (id: NoticeId, action: "notices.own" | "notices.manage") =>
    async (c: Context<AppEnv>) => {
      const user = requireUser(c);
      // The gate already refused anyone else (404); belt and braces.
      if (!orgCan(user, action, { cap: capOfCaller(caller(c)) }))
        throw new ApiError("not_found", "Not found");
      await dismissNotice(c.env, user.id, id);
      return c.body(null, 204);
    };
  // The caller's own list, per user: any non-guest member.
  app.post(
    "/api/v1/notices/guest_shares/dismiss",
    dismiss("guest_shares", "notices.own"),
  );
  // The install-wide summary: the uncapped org owner.
  app.post(
    "/api/v1/notices/guest_summary/dismiss",
    dismiss("guest_summary", "notices.manage"),
  );
}
