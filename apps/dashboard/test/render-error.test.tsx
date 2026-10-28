import { screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { installHarness, mount } from "./harness";

// A page that throws while rendering must not blank the app (the leo white
// page, 2026-10-28): the router's error component shows in the layout.
vi.mock("../src/library/Library", () => ({
  Library: () => {
    throw new Error("boom");
  },
}));

installHarness();

it("a page that throws shows Something went wrong inside the layout, with the sidebar kept", async () => {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  mount("/");
  expect(
    await screen.findByRole("heading", { name: "Something went wrong" }),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Reload" })).toBeVisible();
  expect(
    await screen.findByRole("navigation", { name: "Primary" }),
  ).toBeVisible();
  spy.mockRestore();
});
