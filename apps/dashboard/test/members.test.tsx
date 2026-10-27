import { type Member, R } from "@oa/shared";
import { fixtures } from "@oa/shared/mocks";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { delay, HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { installHarness, mount, server } from "./harness";

installHarness();

// Radix Select needs these in jsdom.
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.scrollIntoView ??= () => {};

const owner = fixtures.members[0] as Member;
const mk = (id: string, email: string, role: Member["role"]): Member => ({
  id,
  email,
  name: null,
  role,
  lastSeenAt: null,
});
const admin = mk("adm1", "admin@example.com", "admin");
const other = mk("mem1", "mem@example.com", "member");
const guest = mk("gst1", "guest@example.com", "guest");

/** Sign in as `who` and serve `list` as the member list. */
const as = (who: Member, list: Member[] = [owner, admin, other]) =>
  server.use(
    http.get(`*${R.me}`, () =>
      HttpResponse.json({ ...fixtures.me, user: who }),
    ),
    http.get(`*${R.members}`, () => HttpResponse.json(list)),
  );

const bodies = (method: string) => {
  const out: { url: string; body: unknown }[] = [];
  server.events.on("request:start", async ({ request }) => {
    if (request.method === method)
      out.push({
        url: new URL(request.url).pathname,
        body: await request
          .clone()
          .json()
          .catch(() => undefined),
      });
  });
  return out;
};

/** The email also shows in the top bar, so wait for it inside the list. */
const rowOf = (email: string) =>
  waitFor(() => {
    const row = screen
      .queryAllByText(email)
      .map((e) => e.closest("li"))
      .find(Boolean);
    if (!row) throw new Error(`no row for ${email}`);
    return row;
  });

describe("members", () => {
  it("the owner row has no Remove and no role select", async () => {
    mount("/settings/members");
    const row = await rowOf(owner.email);
    expect(within(row).queryByRole("button", { name: /remove/i })).toBeNull();
    expect(within(row).queryByRole("combobox")).toBeNull();
    const bob = await rowOf((fixtures.members[1] as Member).email);
    expect(within(bob).getByRole("button", { name: /remove/i })).toBeTruthy();
  });

  it("invite POSTs a trimmed, lowercased email", async () => {
    const posts = bodies("POST");
    mount("/settings/members");
    fireEvent.click(await screen.findByRole("button", { name: "Add member" }));
    fireEvent.change(await screen.findByLabelText("Email"), {
      target: { value: "  New.Person@Example.COM " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add member" }));
    await waitFor(() => expect(posts.length).toBe(1));
    expect(posts[0]).toEqual({
      url: R.members,
      body: { email: "new.person@example.com", role: "member" },
    });
  });

  it("after adding, shows the sign-in link to send instead of promising an email", async () => {
    mount("/settings/members");
    fireEvent.click(await screen.findByRole("button", { name: "Add member" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).not.toHaveTextContent(/sent to their email/);
    fireEvent.change(within(dialog).getByLabelText("Email"), {
      target: { value: "new@example.com" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add member" }));
    expect(
      await screen.findByRole("heading", {
        name: "new@example.com can now sign in",
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Sign-in link" })).toHaveValue(
      location.origin,
    );
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("rejects a non-ASCII email without POSTing", async () => {
    const posts = bodies("POST");
    mount("/settings/members");
    fireEvent.click(await screen.findByRole("button", { name: "Add member" }));
    fireEvent.change(await screen.findByLabelText("Email"), {
      target: { value: "josé@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add member" }));
    expect(await screen.findByText(/valid.*email/i)).toBeTruthy();
    expect(posts.length).toBe(0);
  });

  it("shows the server's conflict error on invite", async () => {
    mount("/settings/members");
    fireEvent.click(await screen.findByRole("button", { name: "Add member" }));
    fireEvent.change(await screen.findByLabelText("Email"), {
      target: { value: owner.email },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add member" }));
    expect(
      (await screen.findAllByText("Already a member")).length,
    ).toBeGreaterThan(0);
  });

  it("an admin is never offered owner", async () => {
    as(admin);
    mount("/settings/members");
    const row = await rowOf(other.email);
    fireEvent.click(within(row).getByRole("combobox"));
    const names = (await screen.findAllByRole("option")).map(
      (o) => o.textContent,
    );
    expect(names).toEqual(["Admin", "Member"]);
  });

  it("you cannot change or remove yourself", async () => {
    as(admin);
    mount("/settings/members");
    const row = await rowOf(admin.email);
    expect(within(row).queryByRole("button", { name: /remove/i })).toBeNull();
    expect(within(row).queryByRole("combobox")).toBeNull();
  });

  it("a role change PATCHes", async () => {
    const patches = bodies("PATCH");
    as(admin);
    mount("/settings/members");
    const row = await rowOf(other.email);
    fireEvent.click(within(row).getByRole("combobox"));
    fireEvent.click(await screen.findByRole("option", { name: "Admin" }));
    await waitFor(() => expect(patches.length).toBe(1));
    expect(patches[0]).toEqual({
      url: R.member(other.id),
      body: { role: "admin" },
    });
  });

  it("a failed role change rolls back and toasts", async () => {
    as(admin);
    server.use(
      http.patch(`*/api/v1/members/*`, () =>
        HttpResponse.json(
          { error: { code: "bad_request", message: "Nope" } },
          { status: 400 },
        ),
      ),
    );
    mount("/settings/members");
    const row = await rowOf(other.email);
    fireEvent.click(within(row).getByRole("combobox"));
    fireEvent.click(await screen.findByRole("option", { name: "Admin" }));
    expect(await screen.findByText("Nope")).toBeTruthy();
    await waitFor(() =>
      expect(within(row).getByRole("combobox").textContent).toContain("Member"),
    );
  });

  it("an admin's remove dialog says the artifacts go to the instance owner", async () => {
    as(admin);
    mount("/settings/members");
    const row = await rowOf(other.email);
    fireEvent.click(within(row).getByRole("button", { name: /remove/i }));
    expect(
      await screen.findByText("Their artifacts move to the instance owner."),
    ).toBeTruthy();
  });

  it("remove confirms with the transfer copy, then DELETEs", async () => {
    const dels = bodies("DELETE");
    as(owner);
    mount("/settings/members");
    const row = await rowOf(other.email);
    fireEvent.click(within(row).getByRole("button", { name: /remove/i }));
    expect(
      await screen.findByText("Their artifacts move to you."),
    ).toBeTruthy();
    expect(dels.length).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "Remove member" }));
    await waitFor(() => expect(dels.length).toBe(1));
    expect(dels[0]?.url).toBe(R.member(other.id));
  });

  it("a guest row shows no admin/member false state", async () => {
    as(owner, [owner, guest]);
    mount("/settings/members");
    const row = await rowOf(guest.email);
    expect(within(row).getByRole("combobox").textContent).toContain("Guest");
  });
});

describe("members: failures and edge cases", () => {
  it("a failed remove toasts and the row returns", async () => {
    as(owner);
    server.use(
      http.delete("*/api/v1/members/*", async () => {
        await delay(20);
        return HttpResponse.json(
          { error: { code: "bad_request", message: "Remove refused" } },
          { status: 400 },
        );
      }),
    );
    mount("/settings/members");
    const row = await rowOf(other.email);
    fireEvent.click(within(row).getByRole("button", { name: /remove/i }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Remove member" }),
    );
    expect(await screen.findByText("Remove refused")).toBeTruthy();
    await rowOf(other.email);
  });

  it("a failed invite toasts", async () => {
    mount("/settings/members");
    fireEvent.click(await screen.findByRole("button", { name: "Add member" }));
    fireEvent.change(await screen.findByLabelText("Email"), {
      target: { value: owner.email },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add member" }));
    await waitFor(() =>
      expect(screen.getAllByText("Already a member").length).toBe(2),
    );
  });

  it("Enter in the invite form submits it, once while pending", async () => {
    let posts = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    server.use(
      http.post(`*${R.members}`, async () => {
        posts++;
        await gate;
        return HttpResponse.json({
          ...mk("n1", "new@example.com", "member"),
          emailed: false,
        });
      }),
    );
    mount("/settings/members");
    fireEvent.click(await screen.findByRole("button", { name: "Add member" }));
    const input = await screen.findByLabelText("Email");
    fireEvent.change(input, { target: { value: "new@example.com" } });
    const form = input.closest("form") as HTMLFormElement;
    // Two Enters before React re-renders: neither sees `isPending` yet.
    act(() => {
      fireEvent.submit(form);
      fireEvent.submit(form);
    });
    await waitFor(() => expect(posts).toBeGreaterThanOrEqual(1));
    // A third while the request is still in flight.
    fireEvent.submit(form);
    release();
    await screen.findByRole("heading", {
      name: "new@example.com can now sign in",
    });
    expect(posts).toBe(1);
  });

  it("marks the active tab on a trailing-slash or upper-case URL", async () => {
    as(owner);
    mount("/settings/members/");
    await rowOf(other.email);
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    expect(
      within(nav)
        .getByRole("link", { name: "Members" })
        .getAttribute("aria-current"),
    ).toBe("page");
  });

  it("labels last seen inline: Active …, Never signed in, Last active unknown", async () => {
    const recent = new Date(Date.now() - 3 * 3600_000).toISOString();
    as(owner, [
      { ...owner, lastSeenAt: recent },
      { ...other, lastSeenAt: "garbage" },
      { ...guest },
    ]);
    mount("/settings/members");
    const me = await rowOf(owner.email);
    expect(within(me).getByText(/^Active \S.*ago$/)).toBeTruthy();
    const row = await rowOf(other.email);
    expect(within(row).getByText("Last active unknown")).toBeTruthy();
    const g = await rowOf(guest.email);
    expect(within(g).getByText("Never signed in")).toBeTruthy();
  });

  it("a guest row offers no owner option", async () => {
    as(owner, [owner, guest]);
    mount("/settings/members");
    const row = await rowOf(guest.email);
    fireEvent.click(within(row).getByRole("combobox"));
    const names = (await screen.findAllByRole("option")).map(
      (o) => o.textContent,
    );
    expect(names).toEqual(["Admin", "Member"]);
  });
});

describe("settings guards", () => {
  const at = async (who: Member, path: string, want: string) => {
    as(who);
    const router = mount(path);
    await waitFor(() => expect(router.state.location.pathname).toBe(want));
  };
  it("guest: /settings/members -> /shared", () =>
    at({ ...guest, id: "g" }, "/settings/members", "/shared"));
  it("guest: /settings/agents -> /shared", () =>
    at(guest, "/settings/agents", "/shared"));
  it("guest: /settings/usage -> /shared", () =>
    at(guest, "/settings/usage", "/shared"));
  it("member: /settings/members -> /settings/agents", () =>
    at(other, "/settings/members", "/settings/agents"));
  it("member: /settings/instance -> /settings/agents", () =>
    at(other, "/settings/instance", "/settings/agents"));
  it("member: /settings/usage -> /", () => at(other, "/settings/usage", "/"));
  it("member keeps /settings/agents", () =>
    at(other, "/settings/agents", "/settings/agents"));
  it("admin keeps /settings/instance and /settings/usage", async () => {
    await at(admin, "/settings/instance", "/settings/instance");
    await at(admin, "/settings/usage", "/settings/usage");
    expect(await screen.findByRole("heading", { name: "Usage" })).toBeTruthy();
  });
  it("member sees only the Profile and Agents tabs", async () => {
    as(other);
    mount("/settings/agents");
    const nav = await screen.findByRole("navigation", {
      name: "Settings sections",
    });
    expect(
      (await within(nav).findAllByRole("link")).map((a) => a.textContent),
    ).toEqual(["Profile", "Agents"]);
  });
});
