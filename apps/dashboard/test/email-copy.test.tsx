// #167: invite and share copy follows Me.instance.emailEnabled before submit
// and the response's `emailed` after.
import { R, viewerPath } from "@oa/shared";
import { createHandlers, fixtures } from "@oa/shared/mocks";
import { fireEvent, screen, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it, vi } from "vitest";
import { installHarness, mount, server } from "./harness";

vi.mock("../src/viewer/bridge", () => ({
  createBridge: () => ({
    dispose: vi.fn(),
    requestThumbnail: vi.fn(),
    setTheme: vi.fn(),
    setArtifact: vi.fn(),
  }),
}));

installHarness();

// Radix Select needs these in jsdom.
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.scrollIntoView ??= () => {};

type Mode = "disabled" | "sent" | "failed";
const MODES: Mode[] = ["disabled", "sent", "failed"];
const INSTANCE = fixtures.me.instance.name;
const FAILED = "The email didn't send. Copy the link and share it yourself.";

/** Email on/off for the instance, and what invite/share responses report. */
const serve = (mode: Mode) => {
  if (mode === "disabled") return; // the harness's default handlers
  // Email on; the shared mocks answer every invite and share with emailed:false.
  server.use(...createHandlers({ emailEnabled: true }));
  if (mode === "failed") return;
  server.use(
    http.post(`*${R.members}`, async ({ request }) => {
      const { email, role } = (await request.json()) as {
        email: string;
        role: string;
      };
      return HttpResponse.json(
        {
          id: "u_new",
          email,
          name: null,
          role,
          lastSeenAt: null,
          emailed: true,
        },
        { status: 201 },
      );
    }),
    http.put("*/api/v1/artifacts/:id/shares", async ({ request }) => {
      const { email, role } = (await request.json()) as {
        email: string;
        role: string;
      };
      return HttpResponse.json({
        email,
        role,
        createdAt: new Date().toISOString(),
        emailed: true,
      });
    }),
  );
};

describe("Add member dialog", () => {
  const open = async () => {
    mount("/settings/members");
    fireEvent.click(await screen.findByRole("button", { name: "Add member" }));
    return screen.findByRole("dialog");
  };
  const add = async (dialog: HTMLElement) => {
    fireEvent.change(within(dialog).getByLabelText("Email"), {
      target: { value: "new@example.com" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add member" }));
    await screen.findByRole("button", { name: "Done" });
    return screen.getByRole("dialog");
  };

  for (const mode of MODES)
    it(`${mode}: description, confirmation and link`, async () => {
      serve(mode);
      const dialog = await open();
      if (mode === "disabled")
        expect(dialog).toHaveTextContent(
          "Open Artifacts doesn't send invitations. Add their email here, then send them the sign-in link yourself.",
        );
      else
        expect(dialog).toHaveTextContent(
          `We'll email them a link to ${INSTANCE}. They'll sign in with a one-time code.`,
        );
      const done = await add(dialog);
      if (mode === "sent") {
        expect(
          within(done).getByRole("heading", {
            name: "Invitation sent to new@example.com",
          }),
        ).toBeInTheDocument();
        expect(done).toHaveTextContent(
          `They can also sign in at ${location.origin} with a one-time code.`,
        );
      } else {
        expect(
          within(done).getByRole("heading", {
            name: "new@example.com can now sign in",
          }),
        ).toBeInTheDocument();
        expect(done).toHaveTextContent(
          `Send them this link. They'll sign in at ${location.origin} with a one-time code sent to that address.`,
        );
      }
      if (mode === "failed") expect(done).toHaveTextContent(FAILED);
      else expect(done).not.toHaveTextContent(FAILED);
      expect(
        within(done).getByRole("textbox", { name: "Sign-in link" }),
      ).toHaveValue(location.origin);
    });
});

describe("Share panel", () => {
  const ID = (
    fixtures.artifacts.find((a) => a.title === "Landing page") as {
      id: string;
    }
  ).id;
  const NO_EMAIL = "No email is sent. Copy the link and share it yourself.";
  const WILL_EMAIL =
    "We'll email them a link. You can also copy it and send it yourself.";
  const EMAILED =
    "We emailed them a link. They'll sign in with a one-time code.";
  const SEND_LINK =
    "Send them this link. They'll sign in with a one-time code sent to that address, then see the artifact.";

  for (const mode of MODES)
    it(`${mode}: hint and confirmation`, async () => {
      serve(mode);
      mount(`${viewerPath(ID)}?panel=open&tab=share`);
      expect(
        await screen.findByText(mode === "disabled" ? NO_EMAIL : WILL_EMAIL),
      ).toBeInTheDocument();
      fireEvent.change(await screen.findByRole("textbox", { name: "Email" }), {
        target: { value: "eve@example.com" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
      await screen.findByText("Shared with eve@example.com");
      expect(
        screen.getByText(mode === "sent" ? EMAILED : SEND_LINK),
      ).toBeInTheDocument();
      // emailed:false is also what members and re-shares get, so never "didn't send".
      expect(screen.queryByText(FAILED)).toBeNull();
      expect(
        screen.getByRole("textbox", { name: "Artifact link" }),
      ).toHaveValue(location.origin + viewerPath(ID));
    });
});
