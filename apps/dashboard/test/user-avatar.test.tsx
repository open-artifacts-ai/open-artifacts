// The shadcn UserAvatar keeps @oa/ui Avatar's name, initials and hue.
import { avatarHue } from "@oa/ui";
import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { initials, UserAvatar } from "../src/layout/UserAvatar";

it("is an image named for the person, with their initials", () => {
  render(<UserAvatar name="Ada Lovelace" email="ada@example.com" />);
  const a = screen.getByRole("img", { name: "Ada Lovelace" });
  expect(a).toHaveTextContent("AL");
  expect(a.querySelector("[data-slot=avatar-fallback]")).toHaveStyle({
    backgroundColor: `hsl(${avatarHue("ada@example.com")} 45% 30%)`,
  });
});

it("falls back to the email, then to ?", () => {
  render(<UserAvatar name={null} email="bob@example.com" />);
  expect(
    screen.getByRole("img", { name: "bob@example.com" }),
  ).toHaveTextContent("BO");
  expect(initials(null, "")).toBe("?");
  expect(initials("ß x", "")).toBe("SS");
});
