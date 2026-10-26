import type { ArtifactSummary, Me } from "@oa/shared";
import {
  type ArtifactEventsMock,
  createArtifactEvents,
  createHandlers,
  fixtures,
} from "@oa/shared/mocks";
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import {
  act,
  type Matcher,
  render,
  screen,
  waitFor,
  type waitForOptions,
} from "@testing-library/react";
import { getResponse, type HttpHandler, HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import type { ReactNode } from "react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  type Mock,
  vi,
} from "vitest";
import { resetCpuLimit } from "../src/api/client";
import { makeQueryClient } from "../src/api/queryClient";
import { RedirectProvider } from "../src/auth/redirect";
import type { HostedMockOptions } from "../src/hostedParam";
import { createAppRouter } from "../src/router";

const ORIGIN = "http://localhost";
export const server = setupServer();
/** Every /api/v1 request seen since the last test started. */
export const seen: URL[] = [];
export const arts = fixtures.artifacts as ArtifactSummary[];
/** The R.events mock of the current test (fresh each test). */
export let events: ArtifactEventsMock;

export type Call = { path: string; search: URLSearchParams; body: unknown };
let recorders: { method?: string; out: Call[] }[] = [];
server.events.on("request:start", ({ request }) => {
  const live = recorders.filter(
    (r) => !r.method || r.method === request.method,
  );
  if (!live.length) return;
  const url = new URL(request.url);
  const call: Call = {
    path: url.pathname,
    search: url.searchParams,
    body: undefined,
  };
  for (const r of live) r.out.push(call);
  void request
    .clone()
    .text()
    .then((t) => {
      try {
        call.body = t ? JSON.parse(t) : undefined;
      } catch {
        call.body = t;
      }
    });
});
/** Every request (of `method`, if given) from this call on, until the test ends. */
export const calls = (method?: string): Call[] => {
  const out: Call[] = [];
  recorders.push({ method, out });
  return out;
};

type Entry = { isIntersecting: boolean };
let observers: ((entries: Entry[]) => void)[] = [];
/** Fire every IntersectionObserver callback as intersecting. */
export const intersect = () =>
  act(() => {
    for (const cb of observers) cb([{ isIntersecting: true }]);
  });

const shim = () => {
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (u: RequestInfo | URL, init?: RequestInit) =>
    // The mocks answer cookie-less requests as anonymous (401 on list/search).
    realFetch(new URL(u as string, ORIGIN).href, {
      ...init,
      headers: { ...init?.headers, cookie: "oa_session=test" },
    }),
  );
};

/** Registers msw, the fetch shim and an IntersectionObserver stub for a test file. */
export const installHarness = () => {
  beforeAll(() => {
    server.listen({ onUnhandledRequest: "error" });
    shim();
  });
  afterAll(() => {
    server.close();
    vi.unstubAllGlobals();
  });
  beforeEach(() => {
    seen.length = 0;
    recorders = [];
    observers = [];
    lastClient = makeQueryClient();
    events = createArtifactEvents();
    server.use(
      http.all("*/api/v1/*", ({ request }) => {
        seen.push(new URL(request.url));
        return undefined;
      }),
      ...createHandlers({ events }),
      ...events.handlers,
    );
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(cb: (e: Entry[]) => void) {
          observers.push(cb);
        }
        observe() {}
        disconnect() {}
        unobserve() {}
      },
    );
    localStorage.clear();
    resetCpuLimit();
  });
  afterEach(() => {
    server.resetHandlers();
    vi.unstubAllGlobals();
    shim();
  });
};

/** The QueryClient of the most recent `mount`. */
export let lastClient: ReturnType<typeof makeQueryClient>;

/** The redirect of the most recent `mount` (full-page navigations). */
export let lastRedirect: Mock<(url: string) => void>;

export const mount = (path: string) => {
  lastClient = makeQueryClient();
  lastRedirect = vi.fn();
  const router = createAppRouter(
    createMemoryHistory({ initialEntries: [path] }),
  );
  render(
    <QueryClientProvider client={lastClient}>
      <RedirectProvider value={lastRedirect}>
        <RouterProvider router={router} />
      </RedirectProvider>
    </QueryClientProvider>,
  );
  return router;
};

/**
 * `mount` against the hosted mocks (`createHandlers({ hosted })`). `me`
 * rewrites the hosted `/me` body; `overrides` sit ahead of both, so a test's
 * handler wins from the first request.
 */
export const mountHosted = (
  path: string,
  opts: true | HostedMockOptions = true,
  me?: (m: Me) => Me,
  overrides: HttpHandler[] = [],
) => {
  const hosted = createHandlers({ hosted: opts });
  server.use(...hosted);
  if (me)
    server.use(
      http.get("*/api/v1/me", async ({ request }) => {
        const res = await getResponse(hosted, request);
        if (!res?.ok) return res;
        return HttpResponse.json(me((await res.json()) as Me));
      }),
    );
  server.use(...overrides);
  return mount(path);
};

/** renderHook wrapper on the current test's QueryClient (`lastClient`). */
export const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={lastClient}>{children}</QueryClientProvider>
);

/** A toast's text, once the toast shows. Sonner commits a toast at opacity 0
    and fades it in from an effect, so findByText can resolve while it's
    still invisible: assert toasts through this, not findBy + toBeVisible. */
export const findVisibleToast = (text: Matcher, options?: waitForOptions) =>
  waitFor(() => {
    const el = screen.getByText(text);
    expect(el.closest("[data-sonner-toast]")).not.toBeNull();
    expect(el).toBeVisible();
    return el;
  }, options);
export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const page = (items: unknown[], nextCursor: string | null) =>
  HttpResponse.json({ items, nextCursor });
