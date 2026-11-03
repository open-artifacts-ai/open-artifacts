// Hosted P4 Task 7: choose a space when uploading (Design D4 answers,
// 2026-10-22): a "Space" select first in the dialog, Personal then the spaces
// you can publish to by name; preselected from where you are; no Upload inside
// a space you can only view. Plus the header's account menu label.

import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "../src/api/client";
import { calls, installHarness, mount, mountHosted } from "./harness";

installHarness();

// msw's XHR interceptor can't build a request under jsdom; PUT via fetch so msw still sees it.
beforeEach(() => {
  vi.spyOn(api, "putRaw").mockImplementation(async (url, _body, type) => {
    await fetch(url, { method: "PUT", headers: { "Content-Type": type } });
  });
});
afterEach(() => vi.restoreAllMocks());

const ENG = "SpEngNpQrSt2uVwX";
const EXEC = "SpExcNpQrSt3uVwX";
const PERSONAL = "Ab3dEfGhJk4mNpQr";

const openUpload = async () => {
  const input = (await screen.findByTestId("upload-files")) as HTMLInputElement;
  fireEvent.change(input, {
    target: { files: [new File(["# x"], "a.md")] },
  });
  return screen.findByRole("dialog", { name: "Create artifact" });
};
const space = () => screen.findByRole("combobox", { name: "Space" });

it("the Space select comes first, with its helper; Personal, then publishable spaces by name", async () => {
  mountHosted("/");
  const d = await openUpload();
  const box = await space();
  const fields = [...d.querySelectorAll("label, [role=combobox], input")];
  expect(fields.indexOf(box)).toBeLessThan(
    fields.indexOf(within(d).getByLabelText("Title")),
  );
  expect(
    within(d).getByText(
      "Only you can see it until you share it or move it to a space.",
    ),
  ).toBeVisible();
  expect(box).toHaveTextContent("Personal");
  fireEvent.click(box);
  expect(
    (await screen.findAllByRole("option")).map((o) => o.textContent),
  ).toEqual(["Personal", "Engineering"]); // Exec (viewer) is hidden
});

it("the helper follows the selection: Personal, then a space", async () => {
  mountHosted("/");
  const d = await openUpload();
  expect(await space()).toHaveTextContent("Personal");
  expect(
    within(d).getByText(
      "Only you can see it until you share it or move it to a space.",
    ),
  ).toBeVisible();
  expect(
    within(d).queryByText("People in this space get access by their role."),
  ).toBeNull();
  fireEvent.click(await space());
  fireEvent.click(await screen.findByRole("option", { name: "Engineering" }));
  expect(
    await within(d).findByText(
      "People in this space get access by their role.",
    ),
  ).toBeVisible();
  expect(
    within(d).queryByText(
      "Only you can see it until you share it or move it to a space.",
    ),
  ).toBeNull();
});

it("inside a space you can publish to, it's preselected and sent as spaceId", async () => {
  const seen = calls("POST");
  mountHosted(`/?space=${ENG}`);
  await openUpload();
  expect(await space()).toHaveTextContent("Engineering");
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  await waitFor(() =>
    expect(
      seen.find((c) => c.path === "/api/v1/artifacts")?.body,
    ).toMatchObject({ spaceId: ENG }),
  );
});

it("Personal sends no spaceId (the server's default)", async () => {
  const seen = calls("POST");
  mountHosted("/");
  await openUpload();
  await space();
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  await waitFor(() =>
    expect(
      seen.find((c) => c.path === "/api/v1/artifacts")?.body,
    ).toBeDefined(),
  );
  expect(
    seen.find((c) => c.path === "/api/v1/artifacts")?.body,
  ).not.toHaveProperty("spaceId");
});

it("choosing another space sends it", async () => {
  const seen = calls("POST");
  mountHosted("/");
  await openUpload();
  fireEvent.click(await space());
  fireEvent.click(await screen.findByRole("option", { name: "Engineering" }));
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  await waitFor(() =>
    expect(
      seen.find((c) => c.path === "/api/v1/artifacts")?.body,
    ).toMatchObject({ spaceId: ENG }),
  );
});

it("inside Personal, Personal is preselected", async () => {
  mountHosted(`/?space=${PERSONAL}`);
  await openUpload();
  expect(await space()).toHaveTextContent("Personal");
});

it("inside a view-only space there is no Upload at all", async () => {
  mountHosted(`/?space=${EXEC}`);
  await screen.findByRole("heading", { level: 1, name: "Exec" });
  await screen.findByText("You're a viewer");
  expect(screen.queryByRole("button", { name: "Upload files" })).toBeNull();
  expect(screen.queryByTestId("upload-files")).toBeNull();
});

it("inside a space you can publish to, the header has Upload files and Upload folder", async () => {
  mountHosted(`/?space=${ENG}`);
  expect(
    await screen.findByRole("button", { name: "Upload files" }),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Upload folder" })).toBeVisible();
});

it("spaces off: no Space select and no spaceId", async () => {
  const seen = calls("POST");
  mount("/");
  await openUpload();
  expect(screen.queryByRole("combobox", { name: "Space" })).toBeNull();
  fireEvent.click(await screen.findByRole("button", { name: "Create" }));
  await waitFor(() =>
    expect(
      seen.find((c) => c.path === "/api/v1/artifacts")?.body,
    ).toBeDefined(),
  );
  expect(
    seen.find((c) => c.path === "/api/v1/artifacts")?.body,
  ).not.toHaveProperty("spaceId");
});

it("403 space_forbidden shows Design's copy in the dialog", async () => {
  mountHosted("/", true, undefined, [
    http.post("*/api/v1/artifacts", () =>
      HttpResponse.json(
        { error: { code: "space_forbidden", message: "server text" } },
        { status: 403 },
      ),
    ),
  ]);
  const d = await openUpload();
  await space();
  fireEvent.click(within(d).getByRole("button", { name: "Create" }));
  expect(
    await within(d).findByText(
      "You can't publish to this space. Ask a space manager to make you an editor.",
    ),
  ).toBeVisible();
  expect(within(d).queryByText("server text")).toBeNull();
});

// -- the account menu (Design follow-up)

it("the account menu starts with the signed-in email, not a menu item", async () => {
  mountHosted("/");
  const trigger = await screen.findByRole("button", { name: "Account menu" });
  fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
  const menu = await screen.findByRole("menu");
  expect(within(menu).getByText("ada@example.com")).toBeVisible();
  expect(
    within(menu).queryByRole("menuitem", { name: "ada@example.com" }),
  ).toBeNull();
  expect(
    within(menu)
      .getAllByRole("menuitem")
      .map((i) => i.textContent),
  ).toEqual(["Sign out"]);
});
