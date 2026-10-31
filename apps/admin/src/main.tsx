import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { router } from "./router";
import "./styles.css";
import "./shadcn.css";

/** Dev-only: serve the API from in-browser MSW handlers. Dead-code-eliminated from production builds. */
async function startMocks() {
  if (import.meta.env.VITE_MOCK !== "1") return;
  const [
    { setupWorker },
    { http, HttpResponse },
    { createMock },
    { autoAdvance },
  ] = await Promise.all([
    import("msw/browser"),
    import("msw"),
    import("./mocks/handlers"),
    import("./mocks/autoAdvance"),
  ]);
  // ?mock=unauth: GET /api/v1/me answers 401.
  // ?mock=fresh: the admin signed in just now (a purge needs a fresh sign-in).
  const flag = new URLSearchParams(location.search).get("mock");
  const { fixtureMe } = await import("@oa/shared/provisioning/fixtures");
  const extra =
    flag === "unauth"
      ? [
          http.get("*/api/v1/me", () =>
            HttpResponse.json({ error: "unauthenticated" }, { status: 401 }),
          ),
        ]
      : flag === "fresh"
        ? [
            http.get("*/api/v1/me", () =>
              HttpResponse.json(
                fixtureMe({
                  principal: "admin",
                  email: "admin@example.com",
                  role: "admin",
                  scopes: [
                    "installs:read",
                    "installs:write",
                    "installs:delete",
                    "installs:pii",
                    "audit:read",
                  ],
                  env: "staging",
                  csrf: "mock-csrf",
                  sessionExpiresAt: Date.now() + 8 * 3_600_000,
                  authAt: Date.now(),
                  provisioningToken: "active",
                  tokenId: null,
                  tokenKind: null,
                  tokenExpiresAt: null,
                }),
              ),
            ),
          ]
        : [];
  const mock = createMock();
  const worker = setupWorker(...extra, ...mock.handlers);
  autoAdvance(worker.events, mock, 1500);
  await worker.start({
    onUnhandledRequest: "bypass",
  });
}

const queryClient = new QueryClient();

void startMocks().then(() => {
  const el = document.getElementById("root");
  if (!el) return;
  createRoot(el).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </StrictMode>,
  );
});
