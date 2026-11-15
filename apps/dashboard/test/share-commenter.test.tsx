// #2590: a share to someone outside the instance offers only "Can comment"
// and "Can view", starting at Can comment; members keep Viewer and Editor;
// a commenter reads "Can comment" wherever a share's role shows.
// PROVISIONAL: the shared mocks take viewer | editor only until OA Comments'
// contract lands, so these tests answer the share routes themselves.
import { viewerPath } from "@oa/shared";
import { fixtures } from "@oa/shared/mocks";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it, vi } from "vitest";
import {
  OUTSIDER_DEFAULT,
  outsideDomains,
  roleLabel,
  roleOptions,
} from "../src/viewer/panels/shareRoles";
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

describe("roles", () => {
  it("an outsider: Can comment first and by default, then Can view", () => {
    expect(OUTSIDER_DEFAULT).toBe("commenter");
    expect(roleOptions(true).map((o) => o.label)).toEqual([
      "Can comment",
      "Can view",
    ]);
    expect(roleOptions(false).map((o) => o.label)).toEqual([
      "Viewer",
      "Editor",
    ]);
  });
  it("a commenter reads Can comment everywhere; an outsider's viewer, Can view", () => {
    expect(roleLabel("commenter", false)).toBe("Can comment");
    expect(roleLabel("commenter", true)).toBe("Can comment");
    expect(roleLabel("viewer", true)).toBe("Can view");
    expect(roleLabel("viewer", false)).toBe("Viewer");
    expect(roleLabel("editor", false)).toBe("Editor");
  });
  it("a stored role outside the list stays listed (an outsider's old Editor)", () => {
    expect(roleOptions(true, "editor").map((o) => o.value)).toEqual([
      "commenter",
      "viewer",
      "editor",
    ]);
  });
  it("outside means at none of the login domains; unknown without them", () => {
    expect(outsideDomains("sam@gmail.com", ["example.com"])).toBe(true);
    expect(outsideDomains("Maya@Example.com", ["example.com"])).toBe(false);
    expect(outsideDomains("sam@gmail.com", [])).toBeNull();
    expect(outsideDomains("not an email", ["example.com"])).toBeNull();
  });
});

describe("the Share panel", () => {
  const routes = () => {
    let list: object[] = [];
    const puts: unknown[] = [];
    const handlers = [
      http.get("*/api/v1/artifacts/:id/shares", () => HttpResponse.json(list)),
      http.put("*/api/v1/artifacts/:id/shares", async ({ request }) => {
        const b = (await request.json()) as { email: string; role: string };
        puts.push(b);
        const row = {
          ...b,
          createdAt: "2026-11-15T00:00:00.000Z",
          guest: !b.email.endsWith("@example.com"),
        };
        list = [
          ...list.filter((x) => (x as { email: string }).email !== b.email),
          row,
        ];
        return HttpResponse.json({ ...row, emailed: false });
      }),
    ];
    return { puts, handlers };
  };
  const invite = (email: string) =>
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: email },
    });
  const options = async (name: string) => {
    fireEvent.keyDown(screen.getByRole("combobox", { name }), {
      key: "Enter",
    });
    const out = (await screen.findAllByRole("option")).map(
      (o) => o.textContent,
    );
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    return out;
  };

  it("an outside address starts at Can comment and offers only Can comment and Can view; a member's keeps Viewer and Editor", async () => {
    const { puts, handlers } = routes();
    // The hosted mocks list example.com as the login domain; these routes
    // sit ahead of them.
    mountHosted(panel, true, undefined, handlers);
    await screen.findByRole("combobox", { name: "Invite role" });
    invite("maya@example.com");
    expect(
      screen.getByRole("combobox", { name: "Invite role" }),
    ).toHaveTextContent("Viewer");
    expect(await options("Invite role")).toEqual(["Viewer", "Editor"]);
    invite("sam@gmail.com");
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "Invite role" }),
      ).toHaveTextContent("Can comment"),
    );
    expect(await options("Invite role")).toEqual(["Can comment", "Can view"]);
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() =>
      expect(puts).toEqual([{ email: "sam@gmail.com", role: "commenter" }]),
    );
    const row = await screen.findByRole("combobox", {
      name: "Role for sam@gmail.com",
    });
    expect(row).toHaveTextContent("Can comment");
    expect(await options("Role for sam@gmail.com")).toEqual([
      "Can comment",
      "Can view",
    ]);
    // No caption for an outsider's commenter row.
    expect(screen.queryByText(/Guest ·/)).toBeNull();
  });
});
