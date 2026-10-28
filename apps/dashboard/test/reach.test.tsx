// Backend P6 (#799), Design's copy: the hosting line from AuthProviders.hosted
// (review item 36), an Access no_access refusal, refused and uncertain
// invites (item 11), and share recipients who can't sign in yet (item 37).
import { type Me, R, viewerPath } from "@oa/shared";
import { fixtures } from "@oa/shared/mocks";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it, vi } from "vitest";
import { orList } from "../src/auth/reach";
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

  it("error=no_access: the single sign-on copy", async () => {
    mountHosted("/sign-in?error=no_access&next=%2Fmine");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Your organization's single sign-on didn't let you in. Ask your admin for access, then try again.",
    );
  });
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

  it("uncertain: the invite is sent, with a warning toast", async () => {
    // Google on: outside the domain, only a Workspace secondary domain gets in.
    mountHosted("/settings/members");
    await invite("pat@elsewhere.org");
    await findVisibleToast(
      "Invite sent. pat@elsewhere.org is outside example.com, so they may not be able to sign in. If they can't, invite an address at example.com.",
    );
    expect(
      await screen.findByText("pat@elsewhere.org can now sign in"),
    ).toBeVisible();
  });
});

const LANDING = (
  fixtures.artifacts.find((a) => a.title === "Landing page") as { id: string }
).id;
const share = async (email: string) => {
  const input = await screen.findByRole("textbox", { name: "Email" });
  fireEvent.change(input, { target: { value: email } });
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  await screen.findByText(`Shared with ${email}`);
  const row = screen
    .getByRole("button", { name: `Remove ${email}` })
    .closest("li");
  if (!row) throw new Error(`no row for ${email}`);
  return row as HTMLElement;
};
const asMember = (m: Me): Me => ({ ...m, user: { ...m.user, role: "member" } });
const PANEL = `${viewerPath(LANDING)}?panel=open&tab=share`;

describe("share recipient notes", () => {
  it("needs_invite, as an org owner: links to Members", async () => {
    mountHosted(PANEL);
    const row = await share("pat@example.com");
    expect(row).toHaveTextContent(
      "pat@example.com can't sign in until they're a member. Invite them",
    );
    expect(
      within(row).getByRole("link", { name: "Invite them" }),
    ).toHaveAttribute("href", "/settings/members");
  });

  it("needs_invite, as a member: ask an admin", async () => {
    mountHosted(PANEL, true, asMember);
    const row = await share("pat@example.com");
    expect(row).toHaveTextContent(
      "pat@example.com can't sign in until they're a member. Ask an admin to invite them.",
    );
    expect(within(row).queryByRole("link")).toBeNull();
  });

  it("outside_domains: share with an address at the domains", async () => {
    // Google only: no guest codes outside the domain.
    mountHosted(PANEL, { providers: ["google"] });
    const row = await share("pat@elsewhere.org");
    expect(row).toHaveTextContent(
      "pat@elsewhere.org can't sign in here, so they can't open this. Share with an address at example.com instead.",
    );
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
    const row = await share("pat@example.com");
    expect(row).toHaveTextContent(
      "No sign-in method here fits pat@example.com, so they can't open this. Share with another address.",
    );
  });

  it("a recipient who can sign in gets no note; removing clears one", async () => {
    mountHosted(PANEL);
    const ok = await share("guest@elsewhere.org");
    expect(within(ok).queryByRole("alert")).toBeNull();
    expect(ok).not.toHaveTextContent("can't sign in");
    const row = await share("pat@example.com");
    expect(row).toHaveTextContent("can't sign in until they're a member");
    fireEvent.click(
      within(row).getByRole("button", { name: "Remove pat@example.com" }),
    );
    await waitFor(() =>
      expect(screen.queryByText(/can't sign in until/)).toBeNull(),
    );
  });
});
