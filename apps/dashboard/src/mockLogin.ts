// Mock-only (#2520): the PROVISIONAL login settings and reach
// (api/loginSettings.ts, OA Backend's draft), on top of the hosted mocks.
// ?mock=login&login=<scenario> (with ?hosted=1):
//   owner-off (default): an owner at acme.com, the join off
//   owner-on: the join on;  admin: the same, as an admin
//   gmail: an owner who logs in with Gmail (provable null)
//   solo: a Solo instance;  selfhost: set at setup (editable false)
//   codes-off: email codes off;  no-google: Google off (nobody new gets in)
//   no-email: the instance sends no email
//   pending: turning the join on answers 409 apply_pending, then applies
//   first-invite: as owner-off, with nobody but the owner yet
//   unproven: turning the join on answers 403 domain_unproven
// Turning the join on answers reauth_required until the page has ?reauthed=1
// (the "login" comes back to the same page with it). An address starting
// "removed" is a removed member (reach says so; invites answer member_removed).
import {
  getResponse,
  type HttpHandler,
  HttpResponse,
  http,
  type RequestHandler,
} from "msw";
import {
  FIRST_INVITE_SEEN,
  type InviteReach,
  LOGIN_SETTINGS,
  type LoginSettings,
  type LoginSettingsPut,
  MEMBERS_REACH,
} from "./api/loginSettings";

export const LOGIN_SCENARIOS = [
  "owner-off",
  "owner-on",
  "admin",
  "gmail",
  "solo",
  "selfhost",
  "codes-off",
  "no-google",
  "no-email",
  "pending",
  "first-invite",
  "unproven",
] as const;
export type LoginScenario = (typeof LOGIN_SCENARIOS)[number];

const DOMAIN = "acme.com";
const GMAIL = new Set(["gmail.com", "googlemail.com"]);

export const scenarioSettings = (s: LoginScenario): LoginSettings => {
  const off: LoginSettings = {
    domains: [DOMAIN],
    autoJoin: false,
    editable: true,
    provable: DOMAIN,
    joined: 0,
    firstInviteSeen: s !== "first-invite" && s !== "gmail",
  };
  switch (s) {
    case "owner-on":
    case "admin":
    case "codes-off":
    case "no-google":
      return { ...off, autoJoin: true, joined: 14 };
    case "gmail":
      return { ...off, domains: [], provable: null };
    case "selfhost":
      return {
        domains: [DOMAIN, "acme.org"],
        autoJoin: true,
        editable: false,
        provable: null,
        joined: 3,
        firstInviteSeen: true,
      };
    default:
      return off;
  }
};

/** The methods the scenario offers (GET /auth/providers). */
export const scenarioMethods = (s: LoginScenario) => ({
  google: s !== "no-google",
  email: s !== "codes-off",
});

export const REMOVED_AT = "2026-11-12T10:00:00.000Z";

/** OA Backend's draft rules for one address. */
export const mockReach = (
  s: LoginSettings,
  methods: { google: boolean; email: boolean },
  email: string,
): InviteReach => {
  const removed = email.startsWith("removed")
    ? { removed: { at: REMOVED_AT } }
    : {};
  return { ...reachWays(s, methods, email), ...removed };
};

const reachWays = (
  s: LoginSettings,
  methods: { google: boolean; email: boolean },
  email: string,
): InviteReach => {
  if (!methods.google) return { ways: [] };
  const host = email.slice(email.lastIndexOf("@") + 1);
  if (GMAIL.has(host)) return { ways: ["google"] };
  if (s.domains.includes(host))
    return { ways: methods.email ? ["google", "email_code"] : ["google"] };
  return {
    ways: methods.email
      ? ["google_workspace", "google_after_code"]
      : ["google_workspace"],
  };
};

const reauthUrl = () => {
  const u = new URL(location.href);
  u.searchParams.set("reauthed", "1");
  return `${u.pathname}${u.search}`;
};

const error = (
  status: number,
  code: string,
  message: string,
  details?: object,
) => HttpResponse.json({ error: { code, message, details } }, { status });

export const loginHandlers = (
  scenario: LoginScenario,
  hosted: RequestHandler[],
  /** The page came back from the login (?reauthed=1). */
  reauthed: () => boolean,
): HttpHandler[] => {
  let settings = scenarioSettings(scenario);
  const methods = scenarioMethods(scenario);
  let pendingOnce = scenario === "pending";
  return [
    http.get(`*${LOGIN_SETTINGS}`, () => HttpResponse.json(settings)),
    http.put(`*${LOGIN_SETTINGS}`, async ({ request }) => {
      const body = (await request.json()) as LoginSettingsPut;
      if (body.autoJoin && !settings.autoJoin && !reauthed())
        return error(401, "reauth_required", "Log in again to continue.", {
          reauthUrl: reauthUrl(),
        });
      if (body.autoJoin && scenario === "unproven")
        return error(403, "domain_unproven", "Domain not proven.", {
          domain: DOMAIN,
        });
      settings = { ...settings, ...body };
      if (pendingOnce) {
        // Accepted, applied by a redeploy: the next GET has it.
        pendingOnce = false;
        return error(
          409,
          "apply_pending",
          "Applying. This takes about a minute.",
        );
      }
      return HttpResponse.json(settings);
    }),
    http.post(`*${FIRST_INVITE_SEEN}`, () => {
      settings = { ...settings, firstInviteSeen: true };
      return new HttpResponse(null, { status: 204 });
    }),
    http.get(`*${MEMBERS_REACH}`, ({ request }) => {
      const email = new URL(request.url).searchParams.get("email") ?? "";
      return HttpResponse.json(mockReach(settings, methods, email));
    }),
    http.get("*/auth/providers", async ({ request }) => {
      const res = await getResponse(hosted, request);
      const body = (await res?.json()) as {
        providers: { id: string }[];
      };
      return HttpResponse.json({
        ...body,
        providers: body.providers.filter(
          (p) =>
            (p.id !== "google" || methods.google) &&
            (p.id !== "email" || methods.email),
        ),
      });
    }),
    // Guests (new in #2520), and the removed address.
    http.post("*/api/v1/members", async ({ request }) => {
      const { email, role } = (await request.clone().json()) as {
        email: string;
        role: string;
      };
      if (email.startsWith("removed"))
        return error(
          409,
          "member_removed",
          "This person was removed. Restore them instead.",
          { userId: "u_removed" },
        );
      if (role !== "guest") return undefined;
      return HttpResponse.json(
        {
          id: `u_${email}`,
          email,
          name: null,
          role,
          lastSeenAt: null,
          emailed: true,
          reach: mockReach(settings, methods, email),
        },
        { status: 201 },
      );
    }),
    http.post("*/api/v1/members/u_removed/restore", () =>
      HttpResponse.json({
        id: "u_removed",
        email: "removed@acme.com",
        name: null,
        role: "member",
        lastSeenAt: null,
      }),
    ),
    http.get("*/api/v1/members", async ({ request }) => {
      if (
        scenario !== "first-invite" ||
        new URL(request.url).searchParams.get("status")
      )
        return undefined;
      const res = await getResponse(hosted, request);
      const body = (await res?.json()) as { role: string }[];
      return HttpResponse.json(body.filter((m) => m.role === "owner"));
    }),
    http.get("*/api/v1/me", async ({ request }) => {
      const res = await getResponse(hosted, request);
      const me = (await res?.json()) as {
        user: { email: string };
        instance: { billing?: object };
      };
      return HttpResponse.json({
        ...me,
        user: {
          ...me.user,
          ...(scenario === "admin" ? { role: "admin" } : {}),
          ...(scenario === "gmail" ? { email: "ada.lovelace@gmail.com" } : {}),
        },
        instance: {
          ...me.instance,
          emailEnabled: scenario !== "no-email",
          ...(scenario === "solo" && me.instance.billing
            ? { billing: { ...me.instance.billing, tier: "solo" } }
            : {}),
        },
      });
    }),
  ];
};

/** A server without #2520: both routes 404, so the Login tab hides. */
export const loginAbsentHandlers = (): HttpHandler[] =>
  [LOGIN_SETTINGS, MEMBERS_REACH].map((p) =>
    http.all(`*${p}`, () => error(404, "not_found", "Not found")),
  );
