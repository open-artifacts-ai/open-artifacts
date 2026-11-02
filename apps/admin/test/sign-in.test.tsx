import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SignIn } from "../src/pages/SignIn";

describe("SignIn", () => {
  it("shows the Google button without an error", () => {
    render(<SignIn />);
    const link = screen.getByRole("link", { name: "Sign in with Google" });
    // The full-size button, not the small one.
    expect(link).toHaveAttribute("data-size", "lg");
    expect(link).toHaveAttribute("href", "/auth/start?return=%2Finstalls");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each([
    ["expired", /took too long/],
    ["denied", /did not let you in/],
    ["no_access", /does not have admin access/],
    ["rate_limited", /Too many attempts/],
  ])("shows copy for %s with a way to switch accounts", (error, copy) => {
    render(<SignIn error={error} />);
    expect(screen.getByRole("alert")).toHaveTextContent(copy);
    // The handoff's warning note, not the red error box.
    expect(screen.getByRole("alert")).toHaveClass("oa-banner-warn");
    expect(
      screen.getByRole("link", { name: "Use another account?" }),
    ).toBeInTheDocument();
  });

  it("ignores an unknown error value", () => {
    render(<SignIn error="<script>" />);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("carries only a safe return", () => {
    render(<SignIn returnTo="//evil.example" />);
    expect(
      screen.getByRole("link", { name: "Sign in with Google" }),
    ).toHaveAttribute("href", "/auth/start?return=%2Finstalls");
  });

  it("carries a normal return path into the href", () => {
    render(<SignIn returnTo="/installs/abc?x=1" />);
    expect(
      screen.getByRole("link", { name: "Sign in with Google" }),
    ).toHaveAttribute(
      "href",
      `/auth/start?return=${encodeURIComponent("/installs/abc?x=1")}`,
    );
  });
});
