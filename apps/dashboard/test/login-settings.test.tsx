// #2520: Settings > Login per state, the domain dialogs, the fresh login and
// apply_pending, the invite dialog's rows per reach, and the first-invite
// step, on the PROVISIONAL contract (OA Backend's draft:
// src/api/loginSettings.ts; mocks in src/mockLogin.ts).
import { R } from "@oa/shared";
import { createHandlers } from "@oa/shared/mocks";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { LOGIN_SETTINGS } from "../src/api/loginSettings";
import {
  type LoginScenario,
  loginHandlers,
  mockReach,
  scenarioMethods,
  scenarioSettings,
} from "../src/mockLogin";
import { DOMAIN_AFTER_REAUTH_KEY, joinBody } from "../src/settings/domainJoin";
import { FIRST_INVITE_SEEN_KEY } from "../src/settings/InviteDialog";
import {
  CANT_LINE,
  DOMAIN_OFF,
  reachLine,
  WORKSPACE_ONLY_LINE,
} from "../src/settings/loginCopy";
import { calls, installHarness, lastRedirect, mountHosted } from "./harness";

installHarness();

// Radix Select needs these in jsdom.
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.scrollIntoView ??= () => {};

beforeEach(() => sessionStorage.clear());

const mountLogin = (path: string, scenario: LoginScenario, reauthed = false) =>
  mountHosted(
    path,
    true,
    undefined,
    loginHandlers(scenario, createHandlers({ hosted: true }), () => reauthed),
  );

const SWITCH = { name: "Anyone at your domain" };

describe("Settings > Login, per state", () => {
  it("owner, join off: the methods, invites always on, the switch off, the boxes", async () => {
    mountLogin("/settings/login", "owner-off");
    expect(
      await screen.findByRole("heading", { name: "How people log in" }),
    ).toBeVisible();
    expect(
      screen.getByText(
        "Everyone who can get in may use either. These were set when Acme Artifacts was created.",
      ),
    ).toBeVisible();
    expect(
      screen.getByText(
        '"Continue with Google", with a work or personal Google account.',
      ),
    ).toBeVisible();
    expect(screen.getByText("always on")).toBeVisible();
    expect(await screen.findByRole("switch", SWITCH)).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(
      screen.getByText("Off. Only people you invite can get in."),
    ).toBeVisible();
    expect(screen.getByText("acme.com")).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "Members and guests" }),
    ).toBeVisible();
  });

  it("owner, join on: switch on, the domain line", async () => {
    mountLogin("/settings/login", "owner-on");
    expect(await screen.findByRole("switch", SWITCH)).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(
      screen.getByText(
        "Your own Google Workspace domain, taken from your login.",
      ),
    ).toBeVisible();
  });

  it("admin: read-only, no switch", async () => {
    mountLogin("/settings/login", "admin");
    await screen.findByRole("heading", { name: "Who can get in" });
    expect(screen.queryByRole("switch", SWITCH)).toBeNull();
    expect(screen.getByText("acme.com")).toBeVisible();
  });

  it("Gmail owner (provable null): not available, a locked switch", async () => {
    mountLogin("/settings/login", "gmail");
    expect(
      await screen.findByText(
        "Not available: you log in with a Gmail address, so there is no company domain. Invite people by address instead.",
      ),
    ).toBeVisible();
    expect(screen.getByRole("switch", SWITCH)).toBeDisabled();
  });

  it("Solo (the plan's tier): only How people log in", async () => {
    mountLogin("/settings/login", "solo");
    await screen.findByRole("heading", { name: "How people log in" });
    expect(
      screen.queryByRole("heading", { name: "Who can get in" }),
    ).toBeNull();
    expect(
      screen.queryByRole("heading", { name: "Members and guests" }),
    ).toBeNull();
  });

  it("self-hosted (editable false): set at setup, every domain, the docs link", async () => {
    mountLogin("/settings/login", "selfhost");
    expect(
      await screen.findByText("Set by whoever runs this server."),
    ).toBeVisible();
    expect(screen.getByText("set at setup")).toBeVisible();
    expect(screen.getByText("acme.com")).toBeVisible();
    expect(screen.getByText("acme.org")).toBeVisible();
    expect(screen.getByText("--auth-domains")).toBeVisible();
    expect(screen.getByRole("link", { name: "How" })).toHaveAttribute(
      "href",
      "https://open-artifacts.com/docs/setup/#setup-flags",
    );
    expect(screen.queryByRole("switch", SWITCH)).toBeNull();
  });

  it("codes off: the email code row says off (from signInMethods)", async () => {
    mountLogin("/settings/login", "codes-off");
    await screen.findByRole("heading", { name: "How people log in" });
    const row = document.querySelector("[data-row=email]") as HTMLElement;
    expect(within(row).getByText("off")).toBeVisible();
  });
});

describe("Settings tabs", () => {
  it("Login sits right after Members for an owner", async () => {
    mountLogin("/settings/profile", "owner-on");
    const nav = await screen.findByRole("navigation", {
      name: "Settings sections",
    });
    await within(nav).findByRole("link", { name: "Login" });
    const labels = within(nav)
      .getAllByRole("link")
      .map((a) => a.textContent);
    expect(labels.indexOf("Login")).toBe(
      labels.findIndex((l) => l?.startsWith("Members")) + 1,
    );
  });

  it("a server without the route (404): no Login tab", async () => {
    mountHosted("/settings/profile");
    const nav = await screen.findByRole("navigation", {
      name: "Settings sections",
    });
    await within(nav).findByRole("link", { name: /Members/ });
    expect(within(nav).queryByRole("link", { name: "Login" })).toBeNull();
  });
});

describe("the domain join", () => {
  it("turning on: the dialog, then a fresh login with the PUT kept", async () => {
    mountLogin("/settings/login", "owner-off");
    fireEvent.click(await screen.findByRole("switch", SWITCH));
    const d = await screen.findByRole("alertdialog", {
      name: "Let anyone at acme.com join?",
    });
    expect(d).toHaveTextContent(
      "Anyone with an acme.com Google account can log in and becomes a member, without an invite. You are told each time someone joins. You can turn this off at any time.",
    );
    expect(d).toHaveTextContent(
      "Anyone in this Google Workspace can join. At a university or a shared mail provider, that can be many people.",
    );
    expect(d).toHaveTextContent("You will log in again to confirm it is you.");
    fireEvent.click(
      within(d).getByRole("button", { name: "Log in again and turn on" }),
    );
    await waitFor(() => expect(lastRedirect).toHaveBeenCalled());
    expect(lastRedirect.mock.calls[0]?.[0]).toMatch(/reauthed=1/);
    expect(
      JSON.parse(sessionStorage.getItem(DOMAIN_AFTER_REAUTH_KEY) ?? "{}").body,
    ).toEqual({ autoJoin: true, domains: ["acme.com"] });
  });

  it("back from the login: sent again, once, and on", async () => {
    sessionStorage.setItem(
      DOMAIN_AFTER_REAUTH_KEY,
      JSON.stringify({
        at: Date.now(),
        body: { autoJoin: true, domains: ["acme.com"] },
      }),
    );
    const puts = calls("PUT");
    mountLogin("/settings/login", "owner-off", true);
    await waitFor(() =>
      expect(screen.getByRole("switch", SWITCH)).toHaveAttribute(
        "aria-checked",
        "true",
      ),
    );
    expect(puts.filter((c) => c.path === LOGIN_SETTINGS)).toHaveLength(1);
    expect(sessionStorage.getItem(DOMAIN_AFTER_REAUTH_KEY)).toBeNull();
  });

  it("apply_pending: Saving, then Saved once the settings show it", async () => {
    mountLogin("/settings/login", "pending", true);
    fireEvent.click(await screen.findByRole("switch", SWITCH));
    fireEvent.click(
      await screen.findByRole("button", { name: "Log in again and turn on" }),
    );
    expect(
      await screen.findByText("Saving. This takes about a minute."),
    ).toBeVisible();
    expect(await screen.findByText("Saved.")).toBeVisible();
    expect(screen.getByRole("switch", SWITCH)).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("turning off: the dialog, then off", async () => {
    mountLogin("/settings/login", "owner-on");
    fireEvent.click(await screen.findByRole("switch", SWITCH));
    const d = await screen.findByRole("alertdialog", {
      name: "Stop letting acme.com join by itself?",
    });
    // No joined count in the draft: that sentence waits for it.
    expect(d).toHaveTextContent(
      "New people at acme.com will need an invite. Remove anyone in Members.",
    );
    fireEvent.click(within(d).getByRole("button", { name: "Turn off" }));
    expect(
      await screen.findByText("Off. Only people you invite can get in."),
    ).toBeVisible();
  });

  it("the turn-off count, once the API has one", () => {
    expect(DOMAIN_OFF.body("acme.com", 14)).toBe(
      "New people at acme.com will need an invite. The 14 members who already joined keep their access. Remove anyone in Members.",
    );
    expect(DOMAIN_OFF.body("acme.com", 1)).toContain(
      "The 1 member who already joined keeps their access.",
    );
  });

  it("turning on adds the provable domain once", () => {
    const s = scenarioSettings("gmail");
    expect(joinBody({ ...s, provable: "acme.com" }, true).domains).toEqual([
      "acme.com",
    ]);
    expect(joinBody(scenarioSettings("owner-on"), false)).toEqual({
      autoJoin: false,
      domains: ["acme.com"],
    });
  });
});

describe("invite rows, per reach (OA Backend's mapping)", () => {
  const on = scenarioSettings("owner-on");
  const both = scenarioMethods("owner-on");
  const noCodes = scenarioMethods("codes-off");
  const noGoogle = scenarioMethods("no-google");
  it.each([
    [
      "pat@acme.com",
      both,
      "At your domain. Logs in with Google or an email code.",
    ],
    ["pat@acme.com", noCodes, "At your domain. Logs in with Google."],
    ["lee@gmail.com", both, "Logs in with Google."],
    [
      "sam@globex.io",
      both,
      "Outside your domain. Logs in with their own Google account or an email code.",
    ],
    ["sam@globex.io", noCodes, WORKSPACE_ONLY_LINE],
    ["sam@globex.io", noGoogle, CANT_LINE],
  ])("%s", (email, methods, line) => {
    expect(reachLine(email, mockReach(on, methods, email).ways)).toBe(line);
  });
  it("gmail with codes: Google or an email code", () => {
    expect(reachLine("lee@gmail.com", ["google", "email_code"])).toBe(
      "Logs in with Google or an email code.",
    );
  });
});

const openInvite = async (name = "Invite people") => {
  fireEvent.click(await screen.findByRole("button", { name }));
  return screen.findByRole("dialog");
};
const list = (dialog: HTMLElement, value: string) =>
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Email" }), {
    target: { value },
  });

describe("the invite dialog", () => {
  it("Invite people: each address with its line and pill; the header and Join as", async () => {
    mountLogin("/settings/members", "owner-on");
    const d = await openInvite();
    expect(
      within(d).getByRole("heading", { name: "Invite people" }),
    ).toBeVisible();
    expect(d).toHaveTextContent(
      "They get an email with a link. Only the addresses you list can use it. An invite lasts 30 days.",
    );
    list(d, "pat@acme.com, sam@globex.io ");
    expect(
      await within(d).findByText(
        "At your domain. Logs in with Google or an email code.",
      ),
    ).toBeVisible();
    expect(
      await within(d).findByText(
        "Outside your domain. Logs in with their own Google account or an email code.",
      ),
    ).toBeVisible();
    expect(within(d).getAllByText("member")).toHaveLength(2);
    expect(within(d).getByText("Join as")).toBeVisible();
    expect(
      within(d).getByText(
        "Members see team pages and can publish. Choose Guest to share single pages only.",
      ),
    ).toBeVisible();
    expect(
      within(d).getByText("You can make a member an admin after they join."),
    ).toBeVisible();
    expect(
      within(d).getByRole("button", { name: "Send 2 invites" }),
    ).toBeEnabled();
    expect(d).not.toHaveTextContent("may not be able to log in");
  });

  it("Join as offers Member and Guest only", async () => {
    mountLogin("/settings/members", "owner-on");
    const d = await openInvite();
    fireEvent.click(within(d).getByRole("combobox", { name: "Join as" }));
    const opts = (await screen.findAllByRole("option")).map(
      (o) => o.textContent,
    );
    expect(opts).toEqual(["Member", "Guest"]);
  });

  it("no Google route: that row can't log in and is held; the rest send", async () => {
    mountLogin("/settings/members", "no-google");
    const posts = calls("POST");
    const d = await openInvite();
    list(d, "sam@globex.io ");
    expect(await within(d).findByText(CANT_LINE)).toBeVisible();
    expect(within(d).getByText("can't log in")).toBeVisible();
    expect(
      within(d).getByRole("button", { name: "Send 0 invites" }),
    ).toBeDisabled();
    expect(posts.filter((c) => c.path === R.members)).toHaveLength(0);
  });

  it("codes off, outside: Google only if Workspace, still sendable", async () => {
    mountLogin("/settings/members", "codes-off");
    const posts = calls("POST");
    const d = await openInvite();
    list(d, "sam@globex.io ");
    expect(await within(d).findByText(WORKSPACE_ONLY_LINE)).toBeVisible();
    fireEvent.click(within(d).getByRole("button", { name: "Send 1 invite" }));
    await waitFor(() =>
      expect(
        posts.filter((c) => c.path === R.members).map((c) => c.body),
      ).toEqual([{ email: "sam@globex.io", role: "member" }]),
    );
  });

  it("a removed member: Restore in the row, as before", async () => {
    mountLogin("/settings/members", "owner-on");
    const posts = calls("POST");
    const d = await openInvite();
    list(d, "removed@acme.com ");
    fireEvent.click(
      await within(d).findByRole("button", { name: "Send 1 invite" }),
    );
    fireEvent.click(
      await within(d).findByRole("button", {
        name: "Restore removed@acme.com",
      }),
    );
    await waitFor(() =>
      expect(posts.map((c) => c.path)).toContain(R.memberRestore("u_removed")),
    );
  });

  it("Join as Guest: the pills say guest and the invite asks for a guest", async () => {
    mountLogin("/settings/members", "owner-on");
    const posts = calls("POST");
    const d = await openInvite();
    list(d, "sam@globex.io ");
    await within(d).findByText(/Outside your domain/);
    fireEvent.click(within(d).getByRole("combobox", { name: "Join as" }));
    fireEvent.click(await screen.findByRole("option", { name: "Guest" }));
    expect(await within(d).findByText("guest")).toBeVisible();
    fireEvent.click(within(d).getByRole("button", { name: "Send 1 invite" }));
    await waitFor(() =>
      expect(
        posts.filter((c) => c.path === R.members).map((c) => c.body),
      ).toEqual([{ email: "sam@globex.io", role: "guest" }]),
    );
  });

  it("no email sending: today's header, and the 30 days under it", async () => {
    mountLogin("/settings/members", "no-email");
    const d = await openInvite();
    expect(d).toHaveTextContent(
      "Open Artifacts doesn't send invitations. Add their email here, then send them the login link yourself.",
    );
    expect(within(d).getByText("An invite lasts 30 days.")).toBeVisible();
  });

  it("a bad address stays in the box with the error", async () => {
    mountLogin("/settings/members", "owner-on");
    const d = await openInvite();
    list(d, "pat@acme.com nope ");
    expect(
      await within(d).findByText("Enter a valid email address (ASCII only)."),
    ).toBeVisible();
    expect(within(d).getByRole("textbox", { name: "Email" })).toHaveValue(
      "nope",
    );
  });

  it("an older server: Add member, today's one-address dialog", async () => {
    mountHosted("/settings/members");
    const d = await openInvite("Add member");
    expect(
      within(d).getByRole("heading", { name: "Add a member" }),
    ).toBeVisible();
    expect(within(d).queryByText("Join as")).toBeNull();
  });
});

describe("the first-invite step (client-side)", () => {
  beforeEach(() => localStorage.removeItem(FIRST_INVITE_SEEN_KEY));
  // The hosted mocks already have other members: the step is for nobody yet.
  const alone = async (scenario: LoginScenario) => {
    const { http, HttpResponse } = await import("msw");
    const hosted = createHandlers({ hosted: true });
    mountHosted("/settings/members", true, undefined, [
      ...loginHandlers(scenario, hosted, () => false),
      http.get(`*${R.members}`, ({ request }) =>
        new URL(request.url).searchParams.get("status")
          ? undefined
          : HttpResponse.json([
              {
                id: "AdaLvlc0Mm1nN2oP",
                email: "ada@example.com",
                name: "Ada Lovelace",
                role: "owner",
                lastSeenAt: null,
                status: "active",
              },
            ]),
      ),
    ]);
  };

  it("first invite, join off, provable: asks; Skip goes on and isn't asked again", async () => {
    await alone("owner-off");
    const d = await openInvite();
    expect(
      within(d).getByRole("heading", {
        name: "Who should be able to join Acme Artifacts?",
      }),
    ).toBeVisible();
    expect(d).toHaveTextContent(
      "You can change this any time in Settings, Login.",
    );
    expect(
      within(d).getByRole("radio", { name: /Only people I invite/ }),
    ).toBeChecked();
    fireEvent.click(within(d).getByRole("button", { name: "Skip for now" }));
    expect(
      await screen.findByRole("heading", { name: "Invite people" }),
    ).toBeVisible();
    expect(localStorage.getItem(FIRST_INVITE_SEEN_KEY)).toBe("1");
  });

  it("Continue with the domain: a fresh login first", async () => {
    await alone("owner-off");
    const d = await openInvite();
    fireEvent.click(
      within(d).getByRole("radio", {
        name: /Anyone at acme.com, and people I invite/,
      }),
    );
    fireEvent.click(within(d).getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(lastRedirect).toHaveBeenCalled());
  });

  it("Gmail owner (no provable domain): no step", async () => {
    await alone("gmail");
    const d = await openInvite();
    expect(
      within(d).getByRole("heading", { name: "Invite people" }),
    ).toBeVisible();
  });

  it("someone already invited: no step", async () => {
    mountLogin("/settings/members", "owner-off");
    const d = await openInvite();
    expect(
      within(d).getByRole("heading", { name: "Invite people" }),
    ).toBeVisible();
  });
});
