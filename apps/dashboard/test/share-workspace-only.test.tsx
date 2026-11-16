// #2590: a share whose address can open the page only if it's a Google
// account (reason workspace_only, PROVISIONAL): a note, not an error. The
// share is saved and keeps its picker; owners and admins also see where to
// turn on login codes.
import { viewerPath } from "@oa/shared";
import { fixtures } from "@oa/shared/mocks";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it, vi } from "vitest";
import { installHarness, mountHosted } from "./harness";

vi.mock("../src/viewer/bridge", () => ({
  createBridge: () => ({
    dispose: vi.fn(),
    requestThumbnail: vi.fn(),
    setTheme: vi.fn(),
    setArtifact: vi.fn(),
  }),
}));

installHarness();

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.scrollIntoView ??= () => {};

const OWNED = (
  fixtures.artifacts.find((a) => a.title === "Landing page") as { id: string }
).id;
const panel = `${viewerPath(OWNED)}?panel=open&tab=share`;
const NOTE =
  "sam@gmail.com can open this only if that address is a Google account. If it isn't, share with their Gmail or Google Workspace address.";

const routes = () => {
  let list: object[] = [];
  return [
    http.get("*/api/v1/artifacts/:id/shares", () => HttpResponse.json(list)),
    http.put("*/api/v1/artifacts/:id/shares", async ({ request }) => {
      const b = (await request.json()) as { email: string; role: string };
      const row = {
        ...b,
        createdAt: "2026-11-15T00:00:00.000Z",
        guest: true,
      };
      list = [row];
      return HttpResponse.json({
        ...row,
        emailed: false,
        recipient: { canSignIn: false, reason: "workspace_only" },
      });
    }),
  ];
};

const share = async () => {
  await screen.findByRole("combobox", { name: "Invite role" });
  fireEvent.change(screen.getByLabelText("Email"), {
    target: { value: "sam@gmail.com" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  return (await screen.findByText(NOTE)).closest(
    "[data-slot=alert]",
  ) as HTMLElement;
};

describe("workspace_only", () => {
  it("an admin: the note, where to turn on codes, the link to send; the row stays", async () => {
    mountHosted(panel, true, undefined, routes());
    const box = await share();
    // A note: not a warning, not an error.
    expect(box).toHaveAttribute("role", "status");
    expect(within(box).getByText("Shared with sam@gmail.com")).toBeVisible();
    expect(box).toHaveTextContent("Or turn on login codes in Settings, Login.");
    expect(
      within(box).getByRole("link", { name: "Settings, Login" }),
    ).toHaveAttribute("href", "/settings/login");
    expect(
      within(box).getByRole("textbox", { name: "Artifact link" }),
    ).toBeVisible();
    // Saved, with its picker.
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "Role for sam@gmail.com" }),
      ).toHaveTextContent("Can comment"),
    );
  });

  it("a member: the note only, no Settings line", async () => {
    mountHosted(
      panel,
      true,
      (m) => ({ ...m, user: { ...m.user, role: "member" } }),
      routes(),
    );
    const box = await share();
    expect(box).toHaveTextContent(NOTE);
    expect(box).not.toHaveTextContent(/turn on login codes/);
    expect(
      within(box).queryByRole("link", { name: "Settings, Login" }),
    ).toBeNull();
    expect(
      screen.getByRole("combobox", { name: "Role for sam@gmail.com" }),
    ).toBeVisible();
  });
});
