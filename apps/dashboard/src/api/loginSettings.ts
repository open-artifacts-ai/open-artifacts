// PROVISIONAL (TODO: OA Backend's #2520 contract, from its API draft; the
// shared schemas follow slice 1). Swap these for @oa/shared's when they land.
//
// GET /api/v1/settings/login -> LoginSettings (owners and admins; 404 on a
//     server without #2520: the Login tab hides, Members keeps its dialog)
// PUT /api/v1/settings/login { autoJoin, domains } -> LoginSettings, owner
//     only. 401 reauth_required { reauthUrl } (a fresh login, as passkeys);
//     403 domain_unproven { domain }; 409 apply_pending (a hosted redeploy,
//     about a minute).
// GET /api/v1/members/reach?email= -> InviteReach (owners and admins).
// POST R.members also returns { reach: InviteReach }, and takes role "guest".
//
// domain_unproven and apply_pending aren't in @oa/shared's ERROR_CODES yet,
// so the client reads them as "internal": until they are, putFailure tells
// them apart by status.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { ApiClientError, api } from "./client";

export const LOGIN_SETTINGS = "/api/v1/settings/login";
export const MEMBERS_REACH = "/api/v1/members/reach";

export const LoginWaySchema = z.enum([
  "google",
  "google_workspace",
  "google_after_code",
  "email_code",
]);
export type LoginWay = z.infer<typeof LoginWaySchema>;

/** How an address can log in here; [] means it can't. */
export const InviteReachSchema = z.object({ ways: z.array(LoginWaySchema) });
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

/** Why a PUT failed, by the draft's codes (or, until shared has them, its statuses). */
export const putFailure = (
  e: unknown,
): "reauth" | "pending" | "unproven" | "other" => {
  if (!(e instanceof ApiClientError)) return "other";
  if (e.code === "reauth_required") return "reauth";
  if ((e.code as string) === "apply_pending" || e.status === 409)
    return "pending";
  if (
    (e.code as string) === "domain_unproven" ||
    (e.status === 403 &&
      typeof (e.details as { domain?: unknown } | undefined)?.domain ===
        "string")
  )
    return "unproven";
  return "other";
};

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
