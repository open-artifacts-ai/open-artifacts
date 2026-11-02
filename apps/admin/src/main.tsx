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
  // ?mock=empty: no installs yet.
  // ?mock=running: every job is mid-run, retrying after a Cloudflare error.
  const flag = new URLSearchParams(location.search).get("mock");
  const { fixtureMe, fixtureWorld } = await import(
    "@oa/shared/provisioning/fixtures"
  );
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
        : flag === "empty"
          ? [
              http.get("*/api/v1/installs", () =>
                HttpResponse.json({ items: [], nextCursor: null }),
              ),
              http.get("*/api/v1/world", () => {
                const w = fixtureWorld();
                return HttpResponse.json({
                  ...w,
                  installs: {
                    total: 0,
                    byState: Object.fromEntries(
                      Object.keys(w.installs.byState).map((k) => [k, 0]),
                    ),
                    byServingMode: Object.fromEntries(
                      Object.keys(w.installs.byServingMode).map((k) => [k, 0]),
                    ),
                    byHealth: Object.fromEntries(
                      Object.keys(w.installs.byHealth).map((k) => [k, 0]),
                    ),
                    items: [],
                  },
                  jobs: { active: 0, failed24h: 0, recent: [] },
                  attention: [],
                });
              }),
            ]
          : flag === "running"
            ? [
                http.get("*/api/v1/jobs/:jobId", async ({ params }) => {
                  const { jobsByStatus } = await import("./mocks/fixtures");
                  return HttpResponse.json({
                    ...jobsByStatus.running,
                    id: params.jobId,
                    attempt: 2,
                    lastErrorCode: "cf_error",
                    createdAt: Date.now() - 90_000,
                    startedAt: Date.now() - 85_000,
                    retryAt: Date.now() + 4 * 60_000,
                  });
                }),
              ]
            : [];
  // The browser clock, so a token minted here is live; one OAuth grant is seeded
  // so the page shows both kinds. Unit tests keep the mock's fixed clock.
  const at = Date.now();
  const mock = createMock({
    now: Date.now,
    tokens: [
      {
        id: "01JMCKSEED0000000000000001",
        kind: "oauth",
        label: "mcp",
        clientName: "Claude Code",
        scopes: ["installs:read", "audit:read"],
        createdAt: at - 120_000,
        expiresAt: at + 6 * 3_600_000,
        revokedAt: null,
        lastUsedAt: at - 120_000,
      },
    ],
  });
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
