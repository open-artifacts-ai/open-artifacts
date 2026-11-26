// #3029 item 2: a `next` the dashboard has no route for says so, and signs in to the Library.
import { screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { DEAD_LINK } from "../src/pages/SignIn";
import { installHarness, mountHosted } from "./harness";

installHarness();

const google = () =>
  screen.findByRole("link", { name: "Continue with Google" });

it("?dead=1 shows the line and signs in to /", async () => {
  mountHosted("/sign-in?dead=1");
  expect(await google()).toHaveAttribute("href", "/auth/login/google?next=%2F");
  expect(screen.getByText(DEAD_LINK)).toBeInTheDocument();
});

it.each([
  "/a/abc",
  "/settings/profile",
  "/mine",
  "/oauth/authorize?client_id=x",
])("next without dead=1 %s shows no line and keeps next", async (path) => {
  mountHosted(`/sign-in?next=${encodeURIComponent(path)}`);
  expect(await google()).toHaveAttribute(
    "href",
    `/auth/login/google?next=${encodeURIComponent(path)}`,
  );
  expect(screen.queryByText(DEAD_LINK)).toBeNull();
});

it("no next shows no line", async () => {
  mountHosted("/sign-in");
  await google();
  expect(screen.queryByText(DEAD_LINK)).toBeNull();
});
