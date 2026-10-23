// The shadcn PersonAvatar keeps @oa/ui Avatar's name, initials and hue.
import { avatarHue } from "@oa/ui";
import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { initials, PersonAvatar } from "../src/layout/PersonAvatar";

it("is an image named for the person, with their initials", () => {
  render(<PersonAvatar name="Ada Lovelace" email="ada@example.com" />);
  const a = screen.getByRole("img", { name: "Ada Lovelace" });
  expect(a).toHaveTextContent("AL");
  expect(a.style.getPropertyValue("--hue")).toBe(
    String(avatarHue("ada@example.com")),
  );
});

it("falls back to the email, then to ?", () => {
  render(<PersonAvatar name={null} email="bob@example.com" />);
  expect(
    screen.getByRole("img", { name: "bob@example.com" }),
  ).toHaveTextContent("BO");
  expect(initials(null, "")).toBe("?");
  expect(initials("ß x", "")).toBe("SS");
});
