// T19 (#800) raced on the invite button: it read "Add member" before GET
// /settings/login answered, then the click opened "Invite people". The button
// now shows only once the login settings have answered, with its final label.
import { createHandlers } from "@oa/shared/mocks";
import { screen, waitFor } from "@testing-library/react";
import { delay, HttpResponse, http } from "msw";
import { expect, it } from "vitest";
import { LOGIN_SETTINGS } from "../src/api/loginSettings";
import { loginHandlers } from "../src/mockLogin";
import { installHarness, mountHosted } from "./harness";
import { FIRST_LOAD_MS } from "./timeouts";

installHarness();

const invite = () =>
  screen.queryByRole("button", { name: /^(Invite people|Add member)$/ });

it("no invite button until the login settings answer, then Invite people", async () => {
  let answer: () => void = () => {};
  const answered = new Promise<void>((r) => {
    answer = r;
  });
  const handlers = loginHandlers(
    "owner-on",
    createHandlers({ hosted: true }),
    () => false,
  );
  mountHosted("/settings/members", true, undefined, [
    http.get(`*${LOGIN_SETTINGS}`, async () => {
      await answered;
      return undefined;
    }),
    ...handlers,
  ]);
  await screen.findByRole(
    "heading",
    { name: "Members" },
    { timeout: FIRST_LOAD_MS },
  );
  // The list is in, the login settings aren't: no label to read yet.
  expect(invite()).toBeNull();
  answer();
  expect(
    await screen.findByRole(
      "button",
      { name: "Invite people" },
      { timeout: FIRST_LOAD_MS },
    ),
  ).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Add member" })).toBeNull();
});

it("a server without login settings gets Add member once it says so", async () => {
  mountHosted("/settings/members", true, undefined, [
    http.get(`*${LOGIN_SETTINGS}`, async () => {
      await delay(10);
      return HttpResponse.json(
        { error: { code: "not_found", message: "Not found" } },
        { status: 404 },
      );
    }),
  ]);
  await waitFor(
    () =>
      expect(
        screen.getByRole("button", { name: "Add member" }),
      ).toBeInTheDocument(),
    { timeout: FIRST_LOAD_MS },
  );
  expect(screen.queryByRole("button", { name: "Invite people" })).toBeNull();
});
