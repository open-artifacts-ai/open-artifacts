// PROVISIONAL (TODO: OA Backend's #2520 contract). Settings > Login, the
// domain join, the first-invite step and the invite dialog's per-address rows
// read these. The paths, fields and errors below are the dashboard's guess
// until OA Backend sends the real shape; swap this file when it lands.
//
// GET   LOGIN_SETTINGS  -> LoginSettings (owners and admins; 403 otherwise;
//                          404 on a server without #2520: the Login tab hides)
// PATCH LOGIN_SETTINGS  { domainJoin?, firstInviteDone? } -> LoginSettings
//                          owner only (403 forbidden); turning the domain on
//                          needs a fresh login: 401 reauth_required
//                          { reauthUrl } (same-origin, returns to `next`).
// POST  MEMBERS_REACH   { emails } -> { items: ReachRow[] }, one per address,
//                          in order; today's reachOf, extended.
// POST  R.members       { email, role: "member" | "guest" } (guest is new).
import { SignInProviderIdSchema } from "@oa/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { ApiClientError, api } from "./client";

export const LOGIN_SETTINGS = "/api/v1/login-settings";
export const MEMBERS_REACH = "/api/v1/members/reach";
/** At most this many addresses per reach call (and per dialog). */
export const REACH_MAX = 50;

export const LoginSettingsSchema = z.object({
  /** team: hosted Team or Business; solo: hosted Solo (only methods show); self_hosted: set at setup. */
  scope: z.enum(["team", "solo", "self_hosted"]),
  /** The methods this instance offers, set when it was created. */
  methods: z.object({ google: z.boolean(), email: z.boolean() }),
  domain: z.object({
    /** The owner's Google Workspace domain (hosted), or AUTH_DOMAINS' first (self-hosted); null when there is none. */
    name: z.string().nullable(),
    /** Anyone at `name` who logs in with Google joins as a member. */
    enabled: z.boolean(),
    /** Why the owner can't turn it on: they log in with Gmail, with an email code, or `name` is a shared mail host. */
    unavailable: z.enum(["gmail", "email_code", "shared_host"]).nullable(),
    /** Members who joined by the domain (the turn-off dialog's count). */
    joined: z.number().int().nonnegative(),
  }),
  /** ask: the owner hasn't seen the first-invite step yet. */
  firstInvite: z.enum(["ask", "done"]),
});
export type LoginSettings = z.infer<typeof LoginSettingsSchema>;

export type LoginSettingsPatch = {
  domainJoin?: boolean;
  firstInviteDone?: true;
};

export const ReachRowSchema = z.object({
  email: z.string(),
  /** Offered methods that admit the address, in SIGN_IN_METHOD_ORDER (today's Reach.methods). */
  methods: z.array(SignInProviderIdSchema),
  /**
   * domain: at the instance's domain; outside: another company's Google
   * Workspace; gmail: a Google consumer address; code_first: a plain mail
   * host, so an email code the first time.
   */
  kind: z.enum(["domain", "outside", "gmail", "code_first"]),
  /** codes_off: it needs an email code the first time and codes are off. */
  blocked: z.enum(["codes_off"]).nullable(),
  /** A removed member: inviting again restores them. */
  removed: z.object({ userId: z.string(), at: z.string() }).nullable(),
});
export type ReachRow = z.infer<typeof ReachRowSchema>;
const ReachResultSchema = z.object({ items: z.array(ReachRowSchema) });

export const qkLogin = ["login-settings"] as const;

/** 404: this server has no #2520 yet. */
export const absent = (e: unknown) =>
  e instanceof ApiClientError && e.status === 404;

export const useLoginSettings = (enabled = true) =>
  useQuery({
    queryKey: qkLogin,
    queryFn: ({ signal }) =>
      api.get(LOGIN_SETTINGS, LoginSettingsSchema, signal),
    enabled,
    staleTime: 30_000,
  });

export const usePatchLoginSettings = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: LoginSettingsPatch) =>
      api.send("PATCH", LOGIN_SETTINGS, body, LoginSettingsSchema),
    onSuccess: (s) => qc.setQueryData(qkLogin, s),
  });
};

/** Per-address reach, for the addresses listed in the invite dialog. */
export const useReach = (emails: string[], enabled: boolean) =>
  useQuery({
    queryKey: ["members-reach", emails],
    queryFn: ({ signal }) =>
      api
        .send("POST", MEMBERS_REACH, { emails }, ReachResultSchema, signal)
        .then((r) => r.items),
    enabled: enabled && emails.length > 0,
    placeholderData: (prev) => prev,
    staleTime: 30_000,
  });
