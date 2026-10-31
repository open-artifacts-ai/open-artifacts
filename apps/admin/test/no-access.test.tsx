import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { NoAccess } from "../src/pages/NoAccess";

it("shows the signed-in email and a way to switch accounts", () => {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <NoAccess email="x@example.com" />
    </QueryClientProvider>,
  );
  expect(screen.getByText(/x@example\.com/)).toBeInTheDocument();
  expect(
    screen.getByRole("link", { name: "Use another account?" }),
  ).toBeInTheDocument();
});
