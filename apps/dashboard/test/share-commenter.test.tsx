// #2590: a share to someone outside the instance offers only "Can comment"
// and "Can view", starting at Can comment; members keep Can comment and Can edit;
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
  outsideAddress,
  outsideLine,
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
      "Can comment",
      "Can edit",
    ]);
  });
  it("a commenter reads Can comment everywhere; an outsider's viewer, Can view", () => {
    expect(roleLabel("commenter", false)).toBe("Can comment");
    expect(roleLabel("commenter", true)).toBe("Can comment");
    expect(roleLabel("viewer", true)).toBe("Can view");
    expect(roleLabel("viewer", false)).toBe("Can comment");
    expect(roleLabel("editor", false)).toBe("Can edit");
  });
  it("a member viewer reads Can view when page comments are off", () => {
    expect(roleLabel("viewer", false, false)).toBe("Can view");
    expect(roleOptions(false, "viewer", false)).toEqual([
      { value: "viewer", label: "Can view" },
      { value: "editor", label: "Can edit" },
    ]);
  });
  it("a stored role outside the list stays listed (an outsider's old Editor)", () => {
    expect(roleOptions(true, "editor").map((o) => o.value)).toEqual([
      "commenter",
      "viewer",
      "editor",
    ]);
  });
  it("with login domains: outside means at none of them", () => {
    expect(outsideAddress("sam@gmail.com", ["example.com"], null)).toBe(true);
    expect(outsideAddress("Maya@Example.com", ["example.com"], null)).toBe(
      false,
    );
  });
  it("with none: outside unless a known member; can't tell when members can't be listed", () => {
    const known = new Set(["dan@example.com"]);
    expect(outsideAddress("Dan@example.com", [], known)).toBe(false);
    expect(outsideAddress("sam@gmail.com", [], known)).toBe(true);
    // Members can't be listed (not an owner or admin): can't tell.
    expect(outsideAddress("dan@example.com", [], null)).toBeNull();
    expect(outsideAddress("sam@gmail.com", [], null)).toBeNull();
  });
  it("an address still being typed is neither", () => {
    expect(outsideAddress("sam@gm", [], null)).toBeNull();
    expect(outsideAddress("sam", ["example.com"], null)).toBeNull();
  });
  it("the line under an outside address, word for word, by how they can log in", () => {
    expect(outsideLine("sam@gmail.com", { google: true, codes: true })).toBe(
      "Outside your team. sam@gmail.com opens this page with their Google account or a code we email them. They see only what you share. Free.",
    );
    expect(outsideLine("sam@gmail.com", { google: true, codes: false })).toBe(
      "Outside your team. sam@gmail.com opens this page with their Google account. They see only what you share. Free.",
    );
    expect(outsideLine("sam@gmail.com", { google: false, codes: true })).toBe(
      "Outside your team. sam@gmail.com opens this page with a code we email them. They see only what you share. Free.",
    );
    expect(outsideLine("sam@gmail.com", { google: false, codes: false })).toBe(
      null,
    );
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

  it.each([true, false])(
    "labels saved member and outside shares when comments are %s",
    async (comments) => {
      const artifact = fixtures.artifacts.find((a) => a.id === OWNED);
      const shares = [
        { email: "maya@example.com", role: "viewer" },
        { email: "sam@outside.test", role: "commenter", guest: true },
        { email: "lee@outside.test", role: "commenter", guest: true },
      ];
      mountHosted(panel, true, undefined, [
        http.get("*/api/v1/artifacts/:id", () =>
          HttpResponse.json({ ...artifact, comments }),
        ),
        http.get("*/api/v1/artifacts/:id/shares", () =>
          HttpResponse.json(
            shares.map((s) => ({
              ...s,
              createdAt: "2026-11-26T00:00:00.000Z",
            })),
          ),
        ),
      ]);
      for (const share of shares) {
        const row = await screen.findByRole("combobox", {
          name: `Role for ${share.email}`,
        });
        expect(row).toHaveTextContent(
          share.guest || comments ? "Can comment" : "Can view",
        );
      }
      expect(await options("Role for maya@example.com")).toEqual([
        comments ? "Can comment" : "Can view",
        "Can edit",
      ]);
    },
  );

  it("an outside address starts at Can comment and offers only Can comment and Can view; a member's keeps Can comment and Can edit", async () => {
    const { puts, handlers } = routes();
    // The hosted mocks list example.com as the login domain; these routes
    // sit ahead of them.
    // Email on: codes work, so the line names them.
    mountHosted(
      panel,
      true,
      (m) => ({ ...m, instance: { ...m.instance, emailEnabled: true } }),
      handlers,
    );
    await screen.findByRole("combobox", { name: "Invite role" });
    invite("maya@example.com");
    expect(
      screen.getByRole("combobox", { name: "Invite role" }),
    ).toHaveTextContent("Can comment");
    expect(await options("Invite role")).toEqual(["Can comment", "Can edit"]);
    expect(screen.queryByText(/^Outside your team/)).toBeNull();
    invite("sam@gmail.com");
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "Invite role" }),
      ).toHaveTextContent("Can comment"),
    );
    expect(await options("Invite role")).toEqual(["Can comment", "Can view"]);
    // The hosted mocks offer Google and codes.
    expect(
      screen.getByText(
        "Outside your team. sam@gmail.com opens this page with their Google account or a code we email them. They see only what you share. Free.",
      ),
    ).toBeVisible();
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

describe("an instance with no login domains (codes only)", () => {
  it("a known member keeps Can comment and Can edit; anyone else is outside, with the codes line", async () => {
    mountHosted(panel, { providers: ["email"] }, (m) => ({
      ...m,
      instance: { ...m.instance, emailEnabled: true },
    }));
    await screen.findByRole("combobox", { name: "Invite role" });
    // dan@example.com is a member in the hosted mocks.
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "dan@example.com" },
    });
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "Invite role" }),
      ).toHaveTextContent("Can comment"),
    );
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "sam@gmail.com" },
    });
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "Invite role" }),
      ).toHaveTextContent("Can comment"),
    );
    expect(
      screen.getByText(
        "Outside your team. sam@gmail.com opens this page with a code we email them. They see only what you share. Free.",
      ),
    ).toBeVisible();
  });
});

describe("a member who can't list members, codes only", () => {
  it("a teammate's address keeps Can comment and Can edit (the saved row shows the server's answer)", async () => {
    // Not an owner or admin: GET members is not theirs to read.
    mountHosted(panel, { providers: ["email"] }, (m) => ({
      ...m,
      user: { ...m.user, role: "member" },
    }));
    await screen.findByRole("combobox", { name: "Invite role" });
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "dan@example.com" },
    });
    expect(
      screen.getByRole("combobox", { name: "Invite role" }),
    ).toHaveTextContent("Can comment");
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Invite role" }), {
      key: "Enter",
    });
    expect(
      (await screen.findAllByRole("option")).map((o) => o.textContent),
    ).toEqual(["Can comment", "Can edit"]);
    expect(screen.queryByText(/^Outside your team/)).toBeNull();
  });
});

describe("the stored role, not the one picked", () => {
  it("an outsider picked as Editor and stored as commenter: the row says Can comment, with no Editor note", async () => {
    let list: object[] = [];
    const puts: unknown[] = [];
    const server = [
      http.get("*/api/v1/artifacts/:id/shares", () => HttpResponse.json(list)),
      http.put("*/api/v1/artifacts/:id/shares", async ({ request }) => {
        const b = (await request.json()) as { email: string; role: string };
        puts.push(b);
        // OA Comments: the server clamps an outsider's editor to commenter
        // and answers with what it stored.
        const row = {
          email: b.email,
          role: "commenter",
          createdAt: "2026-11-15T00:00:00.000Z",
          guest: true,
        };
        list = [row];
        return HttpResponse.json({ ...row, emailed: false });
      }),
    ];
    // A member who can't list members, codes only: the client can't tell.
    mountHosted(
      panel,
      { providers: ["email"] },
      (m) => ({ ...m, user: { ...m.user, role: "member" } }),
      server,
    );
    const select = await screen.findByRole("combobox", { name: "Invite role" });
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "gia@elsewhere.test" },
    });
    fireEvent.keyDown(select, { key: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: "Can edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() =>
      expect(puts).toEqual([{ email: "gia@elsewhere.test", role: "editor" }]),
    );
    expect(
      await screen.findByRole("combobox", {
        name: "Role for gia@elsewhere.test",
      }),
    ).toHaveTextContent("Can comment");
    // The Editor note goes with an Editor share; this one was stored as commenter.
    expect(
      screen.queryByText(
        "Guests can only view. If they become a member, they'll be able to edit.",
      ),
    ).toBeNull();
  });
});

describe("email off means codes off (#2590)", () => {
  const WONT =
    "We won't email them about this share. Copy the link and send it yourself.";
  const type = async (email: string) => {
    await screen.findByRole("combobox", { name: "Invite role" });
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: email },
    });
  };
  it("Google and codes listed, email off: the Google-only line, never the code one, beside the no-email line", async () => {
    mountHosted(panel, true, (m) => ({
      ...m,
      instance: { ...m.instance, emailEnabled: false },
    }));
    await type("sam@gmail.com");
    expect(
      await screen.findByText(
        "Outside your team. sam@gmail.com opens this page with their Google account. They see only what you share. Free.",
      ),
    ).toBeVisible();
    expect(screen.getByText(WONT)).toBeVisible();
    expect(screen.queryByText(/a code we email them/)).toBeNull();
  });
  it("codes only, email off: no login line at all beside the no-email line", async () => {
    mountHosted(panel, { providers: ["email"] }, (m) => ({
      ...m,
      instance: { ...m.instance, emailEnabled: false },
    }));
    await type("sam@gmail.com");
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "Invite role" }),
      ).toHaveTextContent("Can comment"),
    );
    expect(screen.getByText(WONT)).toBeVisible();
    expect(screen.queryByText(/^Outside your team/)).toBeNull();
  });
  it("email on: the code line, and no no-email line", async () => {
    mountHosted(panel, { providers: ["email"] }, (m) => ({
      ...m,
      instance: { ...m.instance, emailEnabled: true },
    }));
    await type("sam@gmail.com");
    expect(
      await screen.findByText(
        "Outside your team. sam@gmail.com opens this page with a code we email them. They see only what you share. Free.",
      ),
    ).toBeVisible();
    expect(screen.queryByText(WONT)).toBeNull();
  });
});
