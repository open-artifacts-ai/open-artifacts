// #2520: Settings > Login per state, the domain dialogs and the fresh login,
// the invite dialog's rows per case, and the first-invite step, on the
// PROVISIONAL contract (src/api/loginSettings.ts, mocks in src/mockLogin.ts).
import { R } from "@oa/shared";
import { createHandlers } from "@oa/shared/mocks";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LOGIN_SETTINGS } from "../src/api/loginSettings";
import {
  type LoginScenario,
  loginHandlers,
  mockReach,
  REMOVED_AT,
  scenarioSettings,
} from "../src/mockLogin";
import { DOMAIN_AFTER_REAUTH_KEY } from "../src/settings/domainJoin";
import {
  CODES_OFF_LINE,
  DOMAIN_OFF,
  reachLine,
} from "../src/settings/loginCopy";
import { calls, installHarness, lastRedirect, mountHosted } from "./harness";

installHarness();

// Radix Select needs these in jsdom.
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.scrollIntoView ??= () => {};

const mountLogin = (path: string, scenario: LoginScenario, reauthed = false) =>
  mountHosted(
    path,
    true,
    undefined,
    loginHandlers(scenario, createHandlers({ hosted: true }), () => reauthed),
  );

const SWITCH = { name: "Anyone at your domain" };

describe("Settings > Login, per state", () => {
  it("owner, domain off: the methods, invites always on, the switch off, the boxes", async () => {
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
    expect(
      screen.getByText(
        "Shown so you know what your people will see. Changing them is not part of this first version.",
      ),
    ).toBeVisible();
    expect(screen.getByText("always on")).toBeVisible();
    expect(screen.getByRole("switch", SWITCH)).toHaveAttribute(
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
    expect(
      screen.getByText(
        "Sees only the pages shared with them, and can comment there. Free. Becomes a guest when you share a page with their address.",
      ),
    ).toBeVisible();
  });

  it("owner, domain on: switch on, the domain line", async () => {
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

  it("Gmail owner: not available, a locked switch", async () => {
    mountLogin("/settings/login", "gmail");
    expect(
      await screen.findByText(
        "Not available: you log in with a Gmail address, so there is no company domain. Invite people by address instead.",
      ),
    ).toBeVisible();
    expect(screen.getByRole("switch", SWITCH)).toBeDisabled();
  });

  it("Solo: only How people log in", async () => {
    mountLogin("/settings/login", "solo");
    await screen.findByRole("heading", { name: "How people log in" });
    expect(
      screen.queryByRole("heading", { name: "Who can get in" }),
    ).toBeNull();
    expect(
      screen.queryByRole("heading", { name: "Members and guests" }),
    ).toBeNull();
  });

  it("self-hosted: set at setup, the flag and the docs link, no switch", async () => {
    mountLogin("/settings/login", "selfhost");
    expect(
      await screen.findByText("Set by whoever runs this server."),
    ).toBeVisible();
    expect(screen.getByText("set at setup")).toBeVisible();
    expect(screen.getByText("--auth-domains")).toBeVisible();
    expect(screen.getByRole("link", { name: "How" })).toHaveAttribute(
      "href",
      "https://open-artifacts.com/docs/setup/#setup-flags",
    );
    expect(screen.queryByRole("switch", SWITCH)).toBeNull();
  });

  it("codes off: the email code row says off", async () => {
    mountLogin("/settings/login", "codes-off");
    await screen.findByRole("heading", { name: "How people log in" });
    const row = document.querySelector("[data-row=email]") as HTMLElement;
    expect(within(row).getByText("off")).toBeVisible();
  });
});

describe("Settings tabs", () => {
  it("Login sits between Members and Spaces for an owner", async () => {
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
  it("turning on: the dialog, then a fresh login that resumes it", async () => {
    sessionStorage.clear();
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
    expect(within(d).getByRole("button", { name: "Cancel" })).toBeVisible();
    fireEvent.click(
      within(d).getByRole("button", { name: "Log in again and turn on" }),
    );
    await waitFor(() => expect(lastRedirect).toHaveBeenCalled());
    expect(lastRedirect.mock.calls[0]?.[0]).toMatch(/reauthed=1/);
    expect(sessionStorage.getItem(DOMAIN_AFTER_REAUTH_KEY)).not.toBeNull();
  });

  it("back from the login: sent again, once, and on", async () => {
    sessionStorage.setItem(
      DOMAIN_AFTER_REAUTH_KEY,
      JSON.stringify({ at: Date.now(), body: { domainJoin: true } }),
    );
    const patches = calls("PATCH");
    mountLogin("/settings/login", "owner-off", true);
    await waitFor(() =>
      expect(screen.getByRole("switch", SWITCH)).toHaveAttribute(
        "aria-checked",
        "true",
      ),
    );
    expect(patches.filter((c) => c.path === LOGIN_SETTINGS)).toHaveLength(1);
    expect(sessionStorage.getItem(DOMAIN_AFTER_REAUTH_KEY)).toBeNull();
  });

  it("turning off: the count, then off", async () => {
    mountLogin("/settings/login", "owner-on");
    fireEvent.click(await screen.findByRole("switch", SWITCH));
    const d = await screen.findByRole("alertdialog", {
      name: "Stop letting acme.com join by itself?",
    });
    expect(d).toHaveTextContent(
      "New people at acme.com will need an invite. The 14 members who already joined keep their access. Remove anyone in Members.",
    );
    fireEvent.click(within(d).getByRole("button", { name: "Turn off" }));
    expect(
      await screen.findByText("Off. Only people you invite can get in."),
    ).toBeVisible();
  });

  it("the turn-off count reads right for 1 and 0", () => {
    expect(DOMAIN_OFF.body("acme.com", 1)).toBe(
      "New people at acme.com will need an invite. The 1 member who already joined keeps their access. Remove anyone in Members.",
    );
    expect(DOMAIN_OFF.body("acme.com", 0)).toBe(
      "New people at acme.com will need an invite. Remove anyone in Members.",
    );
  });
});

describe("invite rows, per case", () => {
  const on = scenarioSettings("owner-on");
  const off = scenarioSettings("codes-off");
  it.each([
    [
      "pat@acme.com",
      on,
      "At your domain. Logs in with Google or an email code.",
    ],
    [
      "sam@globex.io",
      on,
      "Outside your domain. Logs in with their own Google account or an email code.",
    ],
    ["lee@gmail.com", on, "Logs in with Google or an email code."],
    [
      "kim@outlook.com",
      on,
      "Logs in with an email code the first time. After that, Google works too if they have an account for this address.",
    ],
    ["kim@outlook.com", off, CODES_OFF_LINE],
    [
      "removed@acme.com",
      on,
      "Removed on Nov 12. Inviting them again lets them back in.",
    ],
  ])("%s", (email, s, line) => {
    expect(reachLine(mockReach(s, email))).toBe(line);
  });
  it("the removed date is the server's", () => {
    expect(REMOVED_AT.startsWith("2026-11-12")).toBe(true);
  });
});

const openInvite = async () => {
  fireEvent.click(await screen.findByRole("button", { name: "Add member" }));
  return screen.findByRole("dialog");
};
const list = (dialog: HTMLElement, value: string) =>
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Email" }), {
    target: { value },
  });

describe("the invite dialog", () => {
  it("lists each address with its line and pill; the header and Join as", async () => {
    mountLogin("/settings/members", "owner-on");
    const d = await openInvite();
    expect(d).toHaveTextContent(
      "They get an email with a link. Only the addresses you list can use it. An invite lasts 30 days.",
    );
    list(d, "pat@acme.com, lee@gmail.com ");
    expect(
      await within(d).findByText(
        "At your domain. Logs in with Google or an email code.",
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
      within(d).getByRole("button", { name: "Send 2 invites" }),
    ).toBeEnabled();
    expect(d).not.toHaveTextContent("may not be able to log in");
  });

  it("codes off: that row can't log in and is held; the rest send", async () => {
    mountLogin("/settings/members", "codes-off");
    const posts = calls("POST");
    const d = await openInvite();
    list(d, "pat@acme.com kim@outlook.com ");
    expect(await within(d).findByText(CODES_OFF_LINE)).toBeVisible();
    expect(within(d).getByText("can't log in")).toBeVisible();
    fireEvent.click(within(d).getByRole("button", { name: "Send 1 invite" }));
    await waitFor(() =>
      expect(
        posts.filter((c) => c.path === R.members).map((c) => c.body),
      ).toEqual([{ email: "pat@acme.com", role: "member" }]),
    );
    // The held row stays, with its line.
    expect(await within(d).findByText(CODES_OFF_LINE)).toBeVisible();
  });

  it("removed: the pill and line; sending restores them", async () => {
    mountLogin("/settings/members", "removed");
    const posts = calls("POST");
    const d = await openInvite();
    list(d, "removed@acme.com ");
    expect(
      await within(d).findByText(
        "Removed on Nov 12. Inviting them again lets them back in.",
      ),
    ).toBeVisible();
    expect(within(d).getByText("removed")).toBeVisible();
    fireEvent.click(within(d).getByRole("button", { name: "Send 1 invite" }));
    await waitFor(() =>
      expect(posts.map((c) => c.path)).toContain(R.memberRestore("u_removed")),
    );
    expect(posts.some((c) => c.path === R.members)).toBe(false);
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

  it("an older server: today's one-address dialog", async () => {
    mountHosted("/settings/members");
    const d = await openInvite();
    expect(
      within(d).getByRole("heading", { name: "Add a member" }),
    ).toBeVisible();
    expect(within(d).queryByText("Join as")).toBeNull();
    expect(within(d).getByRole("button", { name: "Add member" })).toBeVisible();
  });
});

describe("the first-invite step", () => {
  it("owner: invite-only by default; Skip records it and goes on", async () => {
    mountLogin("/settings/members", "owner-off");
    const patches = calls("PATCH");
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
    expect(
      within(d).getByRole("radio", {
        name: /Anyone at acme.com, and people I invite/,
      }),
    ).toBeEnabled();
    fireEvent.click(within(d).getByRole("button", { name: "Skip for now" }));
    expect(
      await screen.findByRole("heading", { name: "Add a member" }),
    ).toBeVisible();
    await waitFor(() =>
      expect(patches.map((c) => c.body)).toEqual([{ firstInviteDone: true }]),
    );
  });

  it("Continue with the domain: a fresh login first", async () => {
    sessionStorage.clear();
    mountLogin("/settings/members", "owner-off");
    const d = await openInvite();
    fireEvent.click(
      within(d).getByRole("radio", {
        name: /Anyone at acme.com, and people I invite/,
      }),
    );
    fireEvent.click(within(d).getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(lastRedirect).toHaveBeenCalled());
    expect(
      JSON.parse(sessionStorage.getItem(DOMAIN_AFTER_REAUTH_KEY) ?? "{}").body,
    ).toEqual({ domainJoin: true, firstInviteDone: true });
  });

  it("Gmail owner: the domain option is disabled", async () => {
    mountLogin("/settings/members", "gmail");
    const d = await openInvite();
    const r = within(d).getByRole("radio", {
      name: /Anyone at my company's domain/,
    });
    expect(r).toBeDisabled();
    expect(d).toHaveTextContent(
      "Needs a company address. You log in with Gmail.",
    );
  });

  it("admin: no step", async () => {
    mountLogin("/settings/members", "admin");
    const d = await openInvite();
    expect(
      within(d).getByRole("heading", { name: "Add a member" }),
    ).toBeVisible();
  });
});
