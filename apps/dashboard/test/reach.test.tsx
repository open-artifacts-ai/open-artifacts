// Backend P6 (#799), Design's copy: the hosting line from AuthProviders.hosted
// (review item 36), a no_access refusal by Access or Google, refused and uncertain
// invites (item 11), and share recipients who can't sign in yet (item 37).
import { type Me, R, viewerPath } from "@oa/shared";
import { fixtures } from "@oa/shared/mocks";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it, vi } from "vitest";
import { orList, signInWith } from "../src/auth/reach";
import { findVisibleToast, installHarness, mountHosted } from "./harness";

vi.mock("../src/viewer/bridge", () => ({
  createBridge: () => ({
    dispose: vi.fn(),
    requestThumbnail: vi.fn(),
    setTheme: vi.fn(),
  }),
}));

installHarness();

// Radix Select needs these in jsdom.
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.scrollIntoView ??= () => {};

const HOSTED = "Hosted by Open Artifacts";
const SELF = "Self-hosted on Cloudflare";

describe("sign-in hosting line", () => {
  it("hosted: Hosted by Open Artifacts", async () => {
    mountHosted("/sign-in");
    expect(await screen.findByText(HOSTED)).toBeVisible();
    expect(screen.queryByText(SELF)).toBeNull();
  });

  it("self-hosted direct mode: Self-hosted on Cloudflare", async () => {
    mountHosted("/sign-in", { selfHosted: true });
    expect(await screen.findByText(SELF)).toBeVisible();
    expect(screen.queryByText(HOSTED)).toBeNull();
  });

  it("an older server (no hosted field): no line", async () => {
    mountHosted("/sign-in", true, undefined, [
      http.get("*/auth/providers", () =>
        HttpResponse.json({
          mode: "direct",
          providers: [
            {
              id: "google",
              start: "/auth/login/google",
              domains: ["example.com"],
            },
          ],
        }),
      ),
    ]);
    await screen.findByRole("link", { name: "Continue with Google" });
    expect(screen.queryByText(HOSTED)).toBeNull();
    expect(screen.queryByText(SELF)).toBeNull();
  });

  // #799's via says which sign-in refused; an older server sends neither.
  it.each([
    [
      "access",
      "Your organization's single sign-on didn't let you in. Ask your admin for access, then try again.",
    ],
    [
      "google",
      "This Google account doesn't have access here yet. Ask an admin to invite you, or sign in with another Google account.",
    ],
    [
      "",
      "You don't have access here yet. Ask an admin to invite you, then try again.",
    ],
    [
      "bogus",
      "You don't have access here yet. Ask an admin to invite you, then try again.",
    ],
  ])("error=no_access&via=%s", async (via, copy) => {
    mountHosted(
      `/sign-in?error=no_access${via ? `&via=${via}` : ""}&next=%2Fmine`,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(copy);
  });
});

it("signInWith uses the email's phrases, in the server's order", () => {
  expect(signInWith(["email", "google"])).toBe(
    "their Google account or a one-time code sent to that address",
  );
  expect(signInWith(["access"])).toBe("your organization's single sign-on");
  // Nothing admits them, or an older server didn't say: no sentence of ours.
  expect(signInWith([])).toBeNull();
  expect(signInWith(undefined)).toBeNull();
});

it("orList joins domains with 'or'", () => {
  expect(orList(["acme.com"])).toBe("acme.com");
  expect(orList(["acme.com", "acme.io"])).toBe("acme.com or acme.io");
  expect(orList(["a.com", "b.com", "c.com"])).toBe("a.com, b.com or c.com");
});

const invite = async (email: string) => {
  fireEvent.click(await screen.findByRole("button", { name: "Add member" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.change(within(dialog).getByLabelText("Email"), {
    target: { value: email },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Add member" }));
  return dialog;
};

describe("invite reachability", () => {
  it("outside_domains: the field error, no toast", async () => {
    // Codes only: outside the domain, nothing admits the address.
    mountHosted("/settings/members", { providers: ["email"] });
    const dialog = await invite("pat@elsewhere.org");
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "pat@elsewhere.org can't sign in here. Only addresses at your sign-in domains can. Use one of those addresses.",
    );
    expect(within(dialog).getByLabelText("Email")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(document.querySelector("[data-sonner-toast]")).toBeNull();
  });

  it("no_sign_in_method: the field error, no toast", async () => {
    mountHosted("/settings/members", true, undefined, [
      http.get("*/auth/providers", () =>
        HttpResponse.json({ mode: "direct", hosted: true, providers: [] }),
      ),
      http.post(`*${R.members}`, () =>
        HttpResponse.json(
          {
            error: {
              code: "invite_unreachable",
              message: "server text",
              details: { field: "email", reason: "no_sign_in_method" },
            },
          },
          { status: 400 },
        ),
      ),
    ]);
    const dialog = await invite("pat@example.com");
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "No sign-in method here fits pat@example.com. Use another address, or ask the owner to add a sign-in method.",
    );
    expect(screen.queryByText("server text")).toBeNull();
    expect(document.querySelector("[data-sonner-toast]")).toBeNull();
  });

  it("uncertain: Invite sent to <email>, the warning inline, no toast", async () => {
    // Google on: outside the domain, only a Workspace secondary domain gets in.
    mountHosted("/settings/members");
    const dialog = await invite("pat@elsewhere.org");
    expect(
      await within(dialog).findByText("Invite sent to pat@elsewhere.org"),
    ).toBeVisible();
    expect(dialog).toHaveTextContent(
      "pat@elsewhere.org is outside example.com, so they may not be able to sign in. If they can't, invite an address at example.com.",
    );
    expect(
      within(dialog).getByRole("textbox", { name: "Sign-in link" }),
    ).toBeVisible();
    expect(screen.queryByText("pat@elsewhere.org can now sign in")).toBeNull();
    expect(document.querySelector("[data-sonner-toast]")).toBeNull();
  });
});

const LANDING = (
  fixtures.artifacts.find((a) => a.title === "Landing page") as { id: string }
).id;
/** Shares with `email`; returns the box that confirms it (success or warning). */
const share = async (email: string) => {
  const input = await screen.findByRole("textbox", { name: "Email" });
  fireEvent.change(input, { target: { value: email } });
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  const title = await screen.findByText(
    new RegExp(`^Shared with ${email.replace(".", "\\.")}\\.?$`),
  );
  const box = title.closest("[data-slot=alert]");
  if (!box) throw new Error(`no box for ${email}`);
  return box as HTMLElement;
};
/** A recipient who can't sign in gets a warning box with no link (Design, #800). */
const noLink = (box: HTMLElement) => {
  expect(within(box).queryByRole("textbox", { name: "Artifact link" })).toBeNull();
  expect(within(box).queryByRole("button", { name: /Copy/ })).toBeNull();
};
const asMember = (m: Me): Me => ({ ...m, user: { ...m.user, role: "member" } });
const PANEL = `${viewerPath(LANDING)}?panel=open&tab=share`;

describe("share box when the recipient can't sign in", () => {
  it("needs_invite, as an org owner: links to Members", async () => {
    mountHosted(PANEL);
    const box = await share("pat@example.com");
    expect(box).toHaveTextContent(
      "Shared with pat@example.com.pat@example.com can't sign in until they're a member. Invite them",
    );
    expect(
      within(box).getByRole("link", { name: "Invite them" }),
    ).toHaveAttribute("href", "/settings/members");
    noLink(box);
  });

  it("needs_invite, as a member: ask an admin", async () => {
    mountHosted(PANEL, true, asMember);
    const box = await share("pat@example.com");
    expect(box).toHaveTextContent(
      "pat@example.com can't sign in until they're a member. Ask an admin to invite them.",
    );
    expect(within(box).queryByRole("link")).toBeNull();
    noLink(box);
  });

  it("outside_domains: share with an address at the domains", async () => {
    // Google only: no guest codes outside the domain.
    mountHosted(PANEL, { providers: ["google"] });
    const box = await share("pat@elsewhere.org");
    expect(box).toHaveTextContent(
      "pat@elsewhere.org can't sign in here, so they can't open this. Share with an address at example.com instead.",
    );
    noLink(box);
  });

  it("no_sign_in_method: share with another address", async () => {
    mountHosted(PANEL, true, undefined, [
      http.put(`*${R.shares(LANDING)}`, async ({ request }) => {
        const { email, role } = (await request.json()) as {
          email: string;
          role: string;
        };
        return HttpResponse.json({
          email,
          role,
          createdAt: "2026-01-04T10:00:00.000Z",
          emailed: false,
          recipient: { canSignIn: false, reason: "no_sign_in_method" },
        });
      }),
      http.get(`*${R.shares(LANDING)}`, () =>
        HttpResponse.json([
          {
            email: "pat@example.com",
            role: "viewer",
            createdAt: "2026-01-04T10:00:00.000Z",
          },
        ]),
      ),
    ]);
    const box = await share("pat@example.com");
    expect(box).toHaveTextContent(
      "No sign-in method here fits pat@example.com, so they can't open this. Share with another address.",
    );
    noLink(box);
  });

  it("a recipient who can sign in gets the success box, its link, and how they sign in", async () => {
    mountHosted(PANEL);
    const box = await share("guest@elsewhere.org");
    expect(box).not.toHaveTextContent("can't sign in");
    expect(
      within(box).getByRole("textbox", { name: "Artifact link" }),
    ).toBeVisible();
    // The mock's signInMethods for an outside guest: codes.
    expect(box).toHaveTextContent(
      "They'll sign in with a one-time code sent to that address.",
    );
  });

  it("removing the person clears the warning box", async () => {
    mountHosted(PANEL);
    await share("pat@example.com");
    fireEvent.click(
      screen.getByRole("button", { name: "Remove pat@example.com" }),
    );
    await waitFor(() =>
      expect(screen.queryByText(/can't sign in until/)).toBeNull(),
    );
  });
});
