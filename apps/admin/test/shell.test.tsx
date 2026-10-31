import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { router as appRouter } from "../src/router";

afterEach(() => vi.unstubAllGlobals());

it("shows a load error with retry when /api/v1/me answers 500", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "internal" }), { status: 500 }),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          email: "a@example.com",
          role: "platform_admin",
          env: "prod",
          csrf: "t",
        }),
        { status: 200 },
      ),
    );
  vi.stubGlobal("fetch", fetchMock);
  const router = createRouter({
    routeTree: appRouter.routeTree,
    history: createMemoryHistory({ initialEntries: ["/audit"] }),
  });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  expect(
    await screen.findByText("Couldn't load your session"),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(
    await screen.findByRole("heading", { name: "Audit" }),
  ).toBeInTheDocument();
});
