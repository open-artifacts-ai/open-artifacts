import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { render } from "@testing-library/react";
import { type HttpHandler, HttpResponse, http, type JsonBodyType } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";
import { createMock } from "../src/mocks/handlers";
import { router as appRouter, searchCodec } from "../src/router";

const ORIGIN = "http://localhost";
export const server = setupServer();
export const json = (body: JsonBodyType, status = 200) =>
  HttpResponse.json(body, { status });
export const apiErr = (
  code: string,
  status: number,
  details?: JsonBodyType,
  message = "No.",
) => json({ error: { code, message, details } }, status);

/** Every request seen since the test began: method, path and body. */
export type Seen = {
  method: string;
  path: string;
  body: unknown;
  csrf: string | null;
};
export let seen: Seen[] = [];
server.events.on("request:start", async ({ request }) => {
  const u = new URL(request.url);
  const body =
    request.method === "GET" || request.method === "DELETE"
      ? undefined
      : await request
          .clone()
          .json()
          .catch(() => undefined);
  seen.push({
    method: request.method,
    path: u.pathname + u.search,
    body,
    csrf: request.headers.get("x-csrf-token"),
  });
});
/** The contract mock of the current test: advanceJob, finishAllJobs. */
export let mock: ReturnType<typeof createMock>;
export const writes = () => seen.filter((s) => s.method !== "GET");

// Captured after listen(): msw patches the global fetch there. The panel's
// client asks for relative URLs; node's fetch needs an origin.
let realFetch: typeof fetch;
beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
  realFetch = globalThis.fetch;
});
beforeEach(() => {
  seen = [];
  mock = createMock();
  server.use(...mock.handlers);
  vi.stubGlobal("fetch", (u: RequestInfo | URL, init?: RequestInit) =>
    realFetch(new URL(u as string, ORIGIN).href, init),
  );
});
afterEach(() => {
  server.resetHandlers();
  vi.unstubAllGlobals();
});
afterAll(() => server.close());

/** Per-test overrides, ahead of the contract mock. */
export const use = (...h: HttpHandler[]) => server.use(...h);
export { http };

/** Render the app at `path`, signed in against the contract mock. */
export function renderApp(path: string) {
  const router = createRouter({
    routeTree: appRouter.routeTree,
    ...searchCodec,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, qc, ...view };
}
