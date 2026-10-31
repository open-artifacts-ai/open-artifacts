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
  const [{ setupWorker }, { http, HttpResponse }, { handlers }] =
    await Promise.all([
      import("msw/browser"),
      import("msw"),
      import("./mocks/handlers"),
    ]);
  // ?mock=unauth: GET /v1/me answers 401.
  const extra =
    new URLSearchParams(location.search).get("mock") === "unauth"
      ? [
          http.get("*/v1/me", () =>
            HttpResponse.json({ error: "unauthenticated" }, { status: 401 }),
          ),
        ]
      : [];
  await setupWorker(...extra, ...handlers).start({
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
