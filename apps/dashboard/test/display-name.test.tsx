import { type Me, R } from "@oa/shared";
import { fixtures } from "@oa/shared/mocks";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import { qk } from "../src/api/queries";
import { installHarness, lastClient, mount, server, wait } from "./harness";

installHarness();

const TITLE = "What do you like to be called?";
const needsName = (over: Partial<Me> = {}): Me => ({
  ...fixtures.me,
  displayName: null,
  suggestedName: "Ada Lovelace",
  needsDisplayName: true,
  ...over,
});
const serveMe = (me: Me) =>
  server.use(http.get(`*${R.me}`, () => HttpResponse.json(me)));
const patches = () => {
  const out: unknown[] = [];
  server.events.on("request:start", async ({ request }) => {
    if (request.method === "PATCH" && new URL(request.url).pathname === R.me)
      out.push(await request.clone().json());
  });
  return out;
};
/** The server's shape: zod issues under details. */
const INVALID = {
  error: {
    code: "bad_request",
    message: "Invalid request body",
    details: [
      {
        code: "custom",
        path: ["displayName"],
        message: "Name contains invalid characters",
      },
    ],
  },
};
const dialog = () => screen.findByRole("dialog", { name: TITLE });
const nameField = () =>
  screen.findByLabelText("Your name") as Promise<HTMLInputElement>;

beforeEach(() => sessionStorage.clear());

describe("display-name dialog", () => {
  it("doesn't show when the server doesn't ask for a name", async () => {
    mount("/");
    await screen.findByRole("heading", { name: "Library" });
    await wait(50);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows when needsDisplayName, prefilled from suggestedName", async () => {
    serveMe(needsName());
    mount("/");
    await dialog();
    expect((await nameField()).value).toBe("Ada Lovelace");
    expect(
      screen.getByText(
        "Teammates see this name on invites and shared artifacts.",
      ),
    ).toBeInTheDocument();
  });

  it("starts empty with Save disabled without a suggestedName", async () => {
    serveMe(needsName({ suggestedName: null }));
    mount("/");
    expect((await nameField()).value).toBe("");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.change(await nameField(), { target: { value: "   " } });
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.change(await nameField(), {
      target: { value: "x".repeat(81) },
    });
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Name must be at most 80 characters",
    );
  });

  it("Save PATCHes the trimmed name, updates Me and closes", async () => {
    serveMe(needsName());
    const sent = patches();
    mount("/");
    fireEvent.change(await nameField(), { target: { value: "  Grace H  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(sent).toEqual([{ displayName: "Grace H" }]));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const me = lastClient.getQueryData<Me>(qk.me);
    expect(me?.displayName).toBe("Grace H");
    expect(me?.needsDisplayName).toBe(false);
  });

  it("shows the server's 400 message inline and stays open", async () => {
    serveMe(needsName());
    server.use(
      http.patch(`*${R.me}`, () => HttpResponse.json(INVALID, { status: 400 })),
    );
    mount("/");
    await nameField();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Name contains invalid characters",
    );
    expect(await dialog()).toBeInTheDocument();
    expect(await nameField()).toHaveAttribute("aria-invalid", "true");
  });

  it("falls back to the error message without details", async () => {
    serveMe(needsName());
    server.use(
      http.patch(`*${R.me}`, () =>
        HttpResponse.json(
          { error: { code: "rate_limited", message: "Slow down" } },
          { status: 429 },
        ),
      ),
    );
    mount("/");
    await nameField();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Slow down");
  });

  it("Not now closes it for this session and this user only", async () => {
    serveMe(needsName());
    const sent = patches();
    const first = mount("/");
    await dialog();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(sent).toEqual([]);
    expect(
      sessionStorage.getItem(`oa:display-name-skipped:${fixtures.me.user.id}`),
    ).toBe("1");
    first.history.destroy();
    document.body.innerHTML = "";

    // Same user, same session: stays hidden.
    mount("/");
    await screen.findByRole("heading", { name: "Library" });
    await wait(50);
    expect(screen.queryByRole("dialog")).toBeNull();
    document.body.innerHTML = "";

    // Another user in the same browser session still gets asked.
    serveMe(needsName({ user: { ...fixtures.me.user, id: "u_other" } }));
    mount("/");
    expect(await dialog()).toBeInTheDocument();
  });

  it("closing it moves focus to the page heading, not <body>", async () => {
    serveMe(needsName());
    mount("/");
    await dialog();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const h1 = screen.getByRole("heading", { name: "Library", level: 1 });
    await waitFor(() => expect(document.activeElement).toBe(h1));
    expect(h1).toHaveAttribute("tabindex", "-1");
  });

  it("closing it after Save also lands on the heading", async () => {
    serveMe(needsName());
    mount("/");
    await nameField();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("heading", { name: "Library", level: 1 }),
      ),
    );
  });

  it("sign-out forgets Not now, so the next sign-in asks again", async () => {
    serveMe(needsName());
    sessionStorage.setItem("unrelated", "keep");
    mount("/");
    await dialog();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    sessionStorage.setItem("oa:display-name-skipped:u_other", "1");
    const menu = await screen.findByRole("button", { name: "Account menu" });
    fireEvent.keyDown(menu, { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Sign out" }));
    await waitFor(() =>
      expect(
        Object.keys(sessionStorage).filter((k) =>
          k.startsWith("oa:display-name-skipped:"),
        ),
      ).toEqual([]),
    );
    expect(sessionStorage.getItem("unrelated")).toBe("keep");
  });

  it("a failed sign-out keeps Not now", async () => {
    serveMe(needsName());
    server.use(
      http.post("*/auth/logout", () =>
        HttpResponse.json(
          { error: { code: "internal", message: "down" } },
          { status: 500 },
        ),
      ),
    );
    mount("/");
    await dialog();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const menu = await screen.findByRole("button", { name: "Account menu" });
    fireEvent.keyDown(menu, { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Sign out" }));
    expect(await screen.findByText("Couldn't sign out")).toBeInTheDocument();
    expect(
      sessionStorage.getItem(`oa:display-name-skipped:${fixtures.me.user.id}`),
    ).toBe("1");
  });

  it("still works when sessionStorage throws", async () => {
    const get = Storage.prototype.getItem;
    const set = Storage.prototype.setItem;
    Storage.prototype.getItem = () => {
      throw new Error("blocked");
    };
    Storage.prototype.setItem = () => {
      throw new Error("blocked");
    };
    try {
      serveMe(needsName());
      mount("/");
      await dialog();
      fireEvent.click(screen.getByRole("button", { name: "Not now" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    } finally {
      Storage.prototype.getItem = get;
      Storage.prototype.setItem = set;
    }
  });
});

describe("Settings → Profile", () => {
  const field = () =>
    screen.findByLabelText("Display name") as Promise<HTMLInputElement>;

  it("is a settings tab for members", async () => {
    server.use(
      http.get(`*${R.me}`, () =>
        HttpResponse.json({
          ...fixtures.me,
          user: { ...fixtures.me.user, role: "member" },
        }),
      ),
    );
    mount("/settings/connections");
    expect(
      await screen.findByRole("link", { name: "Profile" }),
    ).toHaveAttribute("href", "/settings/profile");
  });

  it("redirects guests away", async () => {
    server.use(
      http.get(`*${R.me}`, () =>
        HttpResponse.json({
          ...fixtures.me,
          user: { ...fixtures.me.user, role: "guest" },
        }),
      ),
    );
    const router = mount("/settings/profile");
    await waitFor(() => expect(router.state.location.pathname).toBe("/shared"));
  });

  it("prefills, shows the email read-only and saves the trimmed name", async () => {
    serveMe(needsName({ needsDisplayName: false, suggestedName: "Ada L" }));
    const sent = patches();
    mount("/settings/profile");
    const input = await field();
    expect(input.value).toBe("Ada L");
    expect(screen.getByLabelText("Email")).toHaveValue(fixtures.me.user.email);
    expect(screen.getByLabelText("Email")).toHaveAttribute("readonly");
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "  Ada Lovelace " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(sent).toEqual([{ displayName: "Ada Lovelace" }]),
    );
    expect(await screen.findByText("Saved")).toBeInTheDocument();
    expect(await screen.findByText("Display name saved")).toBeInTheDocument();
    expect(lastClient.getQueryData<Me>(qk.me)?.displayName).toBe(
      "Ada Lovelace",
    );
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("disables Save until the name changes", async () => {
    serveMe(needsName({ needsDisplayName: false, displayName: "Ada" }));
    mount("/settings/profile");
    const input = await field();
    expect(input.value).toBe("Ada");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.change(input, { target: { value: " Ada " } });
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.change(input, { target: { value: "Ada B" } });
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("shows the server's 400 inline", async () => {
    server.use(
      http.patch(`*${R.me}`, () => HttpResponse.json(INVALID, { status: 400 })),
    );
    mount("/settings/profile");
    fireEvent.change(await field(), { target: { value: "Ada" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Name contains invalid characters",
    );
  });
});
