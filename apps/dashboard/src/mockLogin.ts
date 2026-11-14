// Mock-only (#2520): the PROVISIONAL login settings and per-address reach
// (api/loginSettings.ts), on top of the hosted mocks.
// ?mock=login&login=<scenario> (with ?hosted=1):
//   owner-off (default): an owner with a Workspace domain, the join off, first invite not asked
//   owner-on: the join on, 14 joined;  admin: the same, as an admin
//   gmail: an owner who logs in with Gmail;  solo: a Solo instance
//   selfhost: set at setup;  codes-off: email codes off (plain mail hosts can't get in)
//   removed: as owner-on; any address starting "removed" is a removed member
// Turning the join on answers reauth_required until the page has ?reauthed=1
// (the "login" comes back to the same page with it).
import {
  getResponse,
  type HttpHandler,
  HttpResponse,
  http,
  type RequestHandler,
} from "msw";
import {
  LOGIN_SETTINGS,
  type LoginSettings,
  MEMBERS_REACH,
  type ReachRow,
} from "./api/loginSettings";

export const LOGIN_SCENARIOS = [
  "owner-off",
  "owner-on",
  "admin",
  "gmail",
  "solo",
  "selfhost",
  "codes-off",
  "removed",
] as const;
export type LoginScenario = (typeof LOGIN_SCENARIOS)[number];

const DOMAIN = "acme.com";
const GMAIL = new Set(["gmail.com", "googlemail.com"]);
/** Plain mail hosts: no Google account behind the address, as a rule. */
const PLAIN = new Set([
  "outlook.com",
  "hotmail.com",
  "yahoo.com",
  "icloud.com",
  "proton.me",
  "fastmail.com",
]);
export const REMOVED_AT = "2026-11-12T10:00:00.000Z";

export const scenarioSettings = (s: LoginScenario): LoginSettings => {
  const on = {
    name: DOMAIN,
    enabled: true,
    unavailable: null,
    joined: 14,
  } as const;
  const base: LoginSettings = {
    scope: "team",
    methods: { google: true, email: true },
    domain: { ...on },
    firstInvite: "done",
  };
  switch (s) {
    case "owner-off":
      return {
        ...base,
        domain: { ...on, enabled: false, joined: 0 },
        firstInvite: "ask",
      };
    case "gmail":
      return {
        ...base,
        domain: { name: null, enabled: false, unavailable: "gmail", joined: 0 },
        firstInvite: "ask",
      };
    case "solo":
      return {
        ...base,
        scope: "solo",
        domain: { name: null, enabled: false, unavailable: null, joined: 0 },
        firstInvite: "ask",
      };
    case "selfhost":
      return { ...base, scope: "self_hosted" };
    case "codes-off":
      return { ...base, methods: { google: true, email: false } };
    default:
      return base;
  }
};

/** What the server would say about `email` (today's reachOf, extended). */
export const mockReach = (s: LoginSettings, email: string): ReachRow => {
  const host = email.slice(email.lastIndexOf("@") + 1);
  const kind: ReachRow["kind"] =
    s.domain.name && host === s.domain.name
      ? "domain"
      : GMAIL.has(host)
        ? "gmail"
        : PLAIN.has(host)
          ? "code_first"
          : "outside";
  const methods: ReachRow["methods"] = [
    ...(s.methods.google && kind !== "code_first" ? (["google"] as const) : []),
    ...(s.methods.email ? (["email"] as const) : []),
  ];
  return {
    email,
    methods,
    kind,
    blocked: kind === "code_first" && !s.methods.email ? "codes_off" : null,
    removed: email.startsWith("removed")
      ? { userId: "u_removed", at: REMOVED_AT }
      : null,
  };
};

const reauthUrl = () => {
  const u = new URL(location.href);
  u.searchParams.set("reauthed", "1");
  return `${u.pathname}${u.search}`;
};

export const loginHandlers = (
  scenario: LoginScenario,
  hosted: RequestHandler[],
  /** The page came back from the login (?reauthed=1). */
  reauthed: () => boolean,
): HttpHandler[] => {
  let settings = scenarioSettings(scenario);
  return [
    http.get(`*${LOGIN_SETTINGS}`, () => HttpResponse.json(settings)),
    http.patch(`*${LOGIN_SETTINGS}`, async ({ request }) => {
      const body = (await request.json()) as {
        domainJoin?: boolean;
        firstInviteDone?: boolean;
      };
      if (body.domainJoin === true && !reauthed())
        return HttpResponse.json(
          {
            error: {
              code: "reauth_required",
              message: "Log in again to continue.",
              details: { reauthUrl: reauthUrl() },
            },
          },
          { status: 401 },
        );
      settings = {
        ...settings,
        domain:
          body.domainJoin === undefined
            ? settings.domain
            : { ...settings.domain, enabled: body.domainJoin },
        firstInvite: body.firstInviteDone ? "done" : settings.firstInvite,
      };
      return HttpResponse.json(settings);
    }),
    http.post(`*${MEMBERS_REACH}`, async ({ request }) => {
      const { emails } = (await request.json()) as { emails: string[] };
      return HttpResponse.json({
        items: emails.map((e) => mockReach(settings, e)),
      });
    }),
    // Guests (new in #2520) and restores of the removed address.
    http.post("*/api/v1/members", async ({ request }) => {
      const { email, role } = (await request.clone().json()) as {
        email: string;
        role: string;
      };
      if (role !== "guest") return undefined;
      return HttpResponse.json(
        {
          id: `u_${email}`,
          email,
          name: null,
          role,
          lastSeenAt: null,
          emailed: true,
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
    http.get("*/api/v1/me", async ({ request }) => {
      const res = await getResponse(hosted, request);
      const me = (await res?.json()) as {
        user: { email: string };
        instance: object;
      };
      return HttpResponse.json({
        ...me,
        user: {
          ...me.user,
          ...(scenario === "admin" ? { role: "admin" } : {}),
          ...(scenario === "gmail" ? { email: "ada.lovelace@gmail.com" } : {}),
        },
        instance: { ...me.instance, emailEnabled: true },
      });
    }),
  ];
};

/** A server without #2520: both routes 404, so the Login tab hides. */
export const loginAbsentHandlers = (): HttpHandler[] =>
  [LOGIN_SETTINGS, MEMBERS_REACH].map((p) =>
    http.all(`*${p}`, () =>
      HttpResponse.json(
        { error: { code: "not_found", message: "Not found" } },
        { status: 404 },
      ),
    ),
  );
