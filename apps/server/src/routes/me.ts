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
import {
  caller,
  capOfCaller,
  planOfMember,
  requireUser,
} from "../auth/authz.js";
import { orgCan } from "../auth/policy.js";
import { instanceFeatures, instanceSignIn } from "../auth/sign-in.js";
import { creatorCount, monthOf } from "../billing/creators.js";
import { refreshPlan } from "../billing/store.js";
import { instanceDirectory, readHealth } from "../directory/health.js";
import { emailEnabled } from "../email/send.js";
import { jsonBody } from "../http/body.js";
import { ApiError, appOrigin } from "../http/errors.js";
import { type AppEnv, execCtx } from "../http/middleware.js";
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
  const exp = c.var.sessionExp;
  // Hosted billing: the plan as this request's user load read it (null off
  // hosted billing).
  const plan = planOfMember(user);
  // Every install (parity 2): guests_read_only and the caller's cap reach an
  // Access-only dashboard too, or a guest sees no view-only state.
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
  // Self-serve billing (hosted only): the plan as this request's user load
  // read it. Billing details for the uncapped owner and admins, who also
  // refresh the tier on demand (at most once a minute, after the response).
  if (plan) {
    const details = orgCan(user, "billing.manage", { cap });
    me.instance.billing = {
      tier: plan.tier,
      status: details ? plan.status : null,
      trialEndsAt:
        details && plan.trialEndsAt !== null
          ? new Date(plan.trialEndsAt).toISOString()
          : null,
      graceUntil:
        details && plan.graceUntil !== null
          ? new Date(plan.graceUntil).toISOString()
          : null,
      ...(details
        ? {
            creatorsThisMonth: await creatorCount(c.env, monthOf(Date.now())),
          }
        : {}),
      readOnly: plan.readOnly,
      ...(plan.reason ? { reason: plan.reason } : {}),
    };
    if (details) {
      const run = refreshPlan(c.env, Date.now(), { onDemand: true });
      const ctx = execCtx(c);
      if (ctx) ctx.waitUntil(run);
      else await run;
    }
  }
  // Hosted M1 (#359): in every sign-in mode (Access-only included, parity 1),
  // so the dashboard reads one shape.
  me.instance.hosted = c.env.HOSTED === "1";
  // Hosted: the billing plan's tier when there is one (the same tier as
  // Me.instance.billing.tier; null for free, which has no Tier), else the
  // provisioned TIER. Features follow the same tier (featuresOf). Null off
  // hosted.
  // Read even when the plan rules: an unknown TIER is still logged.
  const provisioned = me.instance.hosted ? hostedTier(c.env.TIER) : null;
  me.instance.tier = !me.instance.hosted
    ? null
    : plan
      ? plan.tier === "free"
        ? null
        : plan.tier
      : provisioned;
  // Owners also see why configured sign-in is off (AuthConfig.problems).
  me.instance.signIn = instanceSignIn(
    c.env,
    orgCan(user, "signin.problems", { cap }),
  );
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
