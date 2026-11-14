// PROVISIONAL (TODO: OA Backend's #2520 contract, from its API draft; the
// shared schemas follow slice 1). Swap these for @oa/shared's when they land.
//
// GET /api/v1/settings/login -> LoginSettings (owners and admins; 404 on a
//     server without #2520: the Login tab hides, Members keeps its dialog)
// PUT /api/v1/settings/login { autoJoin, domains } -> LoginSettings (with
//     applying: true while a hosted redeploy applies it, about a minute),
//     owner only. 401 reauth_required { reauthUrl } (a fresh login, as
//     passkeys); 403 domain_unproven { domain }; 409 apply_pending (refused:
//     an earlier change is still applying).
// GET /api/v1/members/reach?email= -> InviteReach (owners and admins).
// POST /api/v1/settings/login/first-invite-seen -> 204 (Skip or Continue).
// POST R.members also returns { reach: InviteReach }, takes role "guest", and
//     answers 400 no_way_in for an address with no way in.

import { DomainUnprovenDetailsSchema } from "@oa/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { ApiClientError, api } from "./client";

export const LOGIN_SETTINGS = "/api/v1/settings/login";
export const MEMBERS_REACH = "/api/v1/members/reach";
export const FIRST_INVITE_SEEN = "/api/v1/settings/login/first-invite-seen";

export const LoginWaySchema = z.enum([
  "google",
  "google_workspace",
  "google_after_code",
  "email_code",
]);
export type LoginWay = z.infer<typeof LoginWaySchema>;

/** How an address can log in here; [] means it can't. */
export const InviteReachSchema = z.object({
  ways: z.array(LoginWaySchema),
  /** A removed member: inviting again lets them back in. */
  removed: z.object({ at: z.string() }).optional(),
});
export type InviteReach = z.infer<typeof InviteReachSchema>;

export const LoginSettingsSchema = z.object({
  /** The login domains. */
  domains: z.array(z.string()),
  /** Anyone at the domains who logs in with Google joins as a member. */
  autoJoin: z.boolean(),
  /** False on self-host: set at setup (--auth-domains). */
  editable: z.boolean(),
  /** The owner's provable domain (their token's hd); null for a Gmail owner. */
  provable: z.string().nullable(),
  /** Members who joined by the domain (the turn-off dialog). */
  joined: z.number().int().nonnegative(),
  /** The owner answered the first-invite step (Skip or Continue). */
  firstInviteSeen: z.boolean(),
  /** An accepted change is still being applied (a hosted redeploy, about a minute). */
  applying: z.boolean().optional(),
});
export type LoginSettings = z.infer<typeof LoginSettingsSchema>;
export type LoginSettingsPut = { autoJoin: boolean; domains: string[] };

export const qkLogin = ["settings-login"] as const;

export const useLoginSettings = (enabled = true) =>
  useQuery({
    queryKey: qkLogin,
    queryFn: ({ signal }) =>
      api.get(LOGIN_SETTINGS, LoginSettingsSchema, signal),
    enabled,
    staleTime: 30_000,
  });

export const putLoginSettings = (body: LoginSettingsPut) =>
  api.send("PUT", LOGIN_SETTINGS, body, LoginSettingsSchema);

export const useSetLoginSettings = () => {
  const qc = useQueryClient();
  return (s: LoginSettings) => qc.setQueryData(qkLogin, s);
};

export type PutFailure =
  | { why: "reauth"; url: unknown }
  | { why: "pending" }
  | { why: "unproven"; domain: string | null }
  | { why: "other" };

/** Why a PUT failed, by its code. */
export const putFailure = (e: unknown): PutFailure => {
  if (!(e instanceof ApiClientError)) return { why: "other" };
  if (e.code === "reauth_required")
    return {
      why: "reauth",
      url: (e.details as { reauthUrl?: unknown } | undefined)?.reauthUrl,
    };
  if (e.code === "apply_pending") return { why: "pending" };
  if (e.code === "domain_unproven") {
    const d = DomainUnprovenDetailsSchema.safeParse(e.details);
    return { why: "unproven", domain: d.success ? d.data.domain : null };
  }
  return { why: "other" };
};

/** Skip or Continue on the first-invite step: never asked again. */
export const markFirstInviteSeen = () =>
  api.send("POST", FIRST_INVITE_SEEN, undefined);

/** Reach for one listed address, while the dialog is open. */
export const reachQuery = (email: string) => ({
  queryKey: ["members-reach", email] as const,
  queryFn: ({ signal }: { signal: AbortSignal }) =>
    api.get(
      `${MEMBERS_REACH}?email=${encodeURIComponent(email)}`,
      InviteReachSchema,
      signal,
    ),
  staleTime: 30_000,
});
