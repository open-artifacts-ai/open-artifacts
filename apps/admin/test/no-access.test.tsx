import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { NoAccess } from "../src/pages/NoAccess";

afterEach(() => vi.unstubAllGlobals());

const wrap = (ui: React.ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>,
  );

it("shows the signed-in email and a way to switch accounts", () => {
  wrap(<NoAccess email="x@example.com" />);
  expect(screen.getByText(/x@example\.com/)).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Use another account?" }),
  ).toBeInTheDocument();
});

it("on /no-access with a 403 me: no navigation, fallback copy", async () => {
  window.history.pushState({}, "", "/no-access");
  const assign = vi.fn();
  vi.stubGlobal("location", {
    ...window.location,
    pathname: "/no-access",
    search: "",
    assign,
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "no_access" }), { status: 403 }),
    ),
  );
  wrap(<NoAccess />);
  expect(
    await screen.findByText("This account is not an admin here."),
  ).toBeInTheDocument();
  expect(assign).not.toHaveBeenCalled();
});
