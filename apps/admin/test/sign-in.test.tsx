import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SignIn } from "../src/pages/SignIn";

describe("SignIn", () => {
  it("shows the Google button without an error", () => {
    render(<SignIn />);
    const link = screen.getByRole("link", { name: "Sign in with Google" });
    expect(link).toHaveAttribute("href", "/v1/auth/google/start?next=%2F");
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
    expect(
      screen.getByRole("button", { name: "Use another account?" }),
    ).toBeInTheDocument();
  });

  it("ignores an unknown error value", () => {
    render(<SignIn error="<script>" />);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("carries only a safe next", () => {
    render(<SignIn next="//evil.example" />);
    expect(
      screen.getByRole("link", { name: "Sign in with Google" }),
    ).toHaveAttribute("href", "/v1/auth/google/start?next=%2F");
  });

  it("carries a normal next path into the href", () => {
    render(<SignIn next="/installs/abc?x=1" />);
    expect(
      screen.getByRole("link", { name: "Sign in with Google" }),
    ).toHaveAttribute(
      "href",
      `/v1/auth/google/start?next=${encodeURIComponent("/installs/abc?x=1")}`,
    );
  });
});
