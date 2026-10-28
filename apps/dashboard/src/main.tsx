import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { makeQueryClient } from "./api/queryClient";
import { isEmbed, lockToPath } from "./embed";
import { parseHostedParam } from "./hostedParam";
import { router } from "./router";
import "./styles.css";
import "./shadcn.css";

/** Dev-only: serve the API from in-browser MSW handlers. Dead-code-eliminated from production builds. */
async function startMocks() {
  if (import.meta.env.VITE_MOCK !== "1") return;
  const [
    { setupWorker },
    { createArtifactEvents, createHandlers, fixtures },
    { HttpResponse, getResponse, http, ws },
  ] = await Promise.all([
    import("msw/browser"),
    import("@oa/shared/mocks"),
    import("msw"),
  ]);
  const params = new URLSearchParams(location.search);
  const quotaExceeded =
    import.meta.env.VITE_MOCK_QUOTA === "1" || params.get("mock") === "quota";
  const extra = [];
  // ?role=admin|member|guest: sign in as that role.
  const role = params.get("role");
  if (role === "admin" || role === "member" || role === "guest")
    extra.push(
      http.get("*/api/v1/me", () =>
        HttpResponse.json({
          ...fixtures.me,
          user: { ...fixtures.me.user, role },
        }),
      ),
    );
  // ?mock=space-manager (with ?hosted=1): the caller is a plain member who manages
  // Engineering, and its People list has two other managers (manual, synced).
  if (params.get("mock") === "space-manager") {
    const hostedHandlers = createHandlers({
      hosted: parseHostedParam(params.get("hosted")) ?? {},
    });
    const row = (id: string, name: string, o: object) => ({
      userId: id,
      user: {
        id,
        name,
        email: `${name.split(" ")[0]?.toLowerCase()}@example.com`,
      },
      status: "active",
      source: "manual",
      manualRole: null,
      syncRole: null,
      groups: [],
      cap: null,
      allMembers: null,
      ...o,
    });
    extra.push(
      http.get("*/api/v1/me", async ({ request }) => {
        const res = await getResponse(hostedHandlers, request);
        const me = (await res?.json()) as { user: { role: string } };
        return HttpResponse.json({
          ...me,
          user: { ...me.user, role: "member" },
        });
      }),
      http.get("*/api/v1/spaces/SpEngNpQrSt2uVwX/members", () => {
        const items = [
          row("r1", "Rina Patel", { role: "manager", manualRole: "manager" }),
          row("m2", "Max Weber", {
            role: "manager",
            source: "sync",
            syncRole: "manager",
            groups: [
              {
                groupId: "gEng01",
                email: "eng@example.com",
                name: "Engineering",
                role: "manager",
                via: "space",
              },
            ],
          }),
          row("b1", "Bob Builder", { role: "editor", manualRole: "editor" }),
        ];
        return HttpResponse.json({
          items,
          nextCursor: null,
          total: items.length,
        });
      }),
    );
  }
  // ?mock=group-race (with ?hosted=1): changing a group's role on a space is refused as a race
  // (403 space_forbidden { target: "mapping" }).
  if (params.get("mock") === "group-race")
    extra.push(
      http.put("*/api/v1/spaces/:id/mappings/:g", () =>
        HttpResponse.json(
          {
            error: {
              code: "space_forbidden",
              message: "Only an admin can change a manager mapping",
              details: { target: "mapping" },
            },
          },
          { status: 403 },
        ),
      ),
    );

  // ?mock=conflict (with ?hosted=1): every artifact edit and move is refused as a
  // compare-and-set conflict (409 conflict), as when it changed under the editor.
  if (params.get("mock") === "conflict") {
    const conflict = () =>
      HttpResponse.json(
        { error: { code: "conflict", message: "The artifact changed" } },
        { status: 409 },
      );
    extra.push(
      http.patch("*/api/v1/artifacts/:id", conflict),
      http.post("*/api/v1/artifacts/:id/move", conflict),
    );
  }
  // ?mock=name: no display name yet (suggested "Ada Lovelace"); after a PATCH the shared mock answers.
  if (params.get("mock") === "name") {
    let named = false;
    extra.push(
      http.get("*/api/v1/me", () =>
        named
          ? undefined
          : HttpResponse.json({
              ...fixtures.me,
              displayName: null,
              suggestedName: "Ada Lovelace",
              needsDisplayName: true,
            }),
      ),
      http.patch("*/api/v1/me", () => {
        named = true;
        return undefined;
      }),
    );
  }
  // ?mock=email: the instance sends invite/share emails; ?mock=email-fail: it
  // does, but every send fails (the shared mocks always answer emailed:false).
  const mail = params.get("mock");
  const emailEnabled = mail === "email" || mail === "email-fail";
  if (mail === "email")
    extra.push(
      http.post("*/api/v1/members", async ({ request }) => {
        const { email, role } = (await request.json()) as {
          email: string;
          role: string;
        };
        return HttpResponse.json(
          {
            id: `u_${Date.now()}`,
            email,
            name: null,
            role,
            lastSeenAt: null,
            emailed: true,
          },
          { status: 201 },
        );
      }),
      http.put("*/api/v1/artifacts/:id/shares", async ({ request }) => {
        const { email, role } = (await request.json()) as {
          email: string;
          role: string;
        };
        return HttpResponse.json({
          email,
          role,
          createdAt: new Date().toISOString(),
          emailed: true,
        });
      }),
    );
  // ?mock=update: v0.14.2 with v0.15.0 out; ?mock=uptodate and ?mock=custom
  // (a -dev build): a check with nothing to upgrade to.
  const checkedAt = new Date(Date.now() - 5 * 60_000).toISOString();
  const updates = {
    update: { current: "0.14.2", custom: false, updateAvailable: true },
    uptodate: { current: "0.15.0", custom: false, updateAvailable: false },
    custom: { current: "0.15.0-dev", custom: true, updateAvailable: false },
  } as const;
  const u = updates[params.get("mock") as keyof typeof updates];
  const update = u && {
    ...u,
    latestVersion: "0.15.0",
    breaking: false,
    notesUrl:
      "https://github.com/open-artifacts-ai/open-artifacts/releases/tag/v0.15.0",
    checkedAt,
  };
  // ?mock=guest-live (with ?hosted=1): every artifact is a live-data (db) viewer share the
  // caller can't write; ?mock=viewer-live: the same for an employee viewer (data writes allowed);
  // ?mock=contractor-live: a restricted member (chip); ?mock=guest-static: a guest on an artifact without live data.
  const live = params.get("mock");
  if (
    live === "guest-live" ||
    live === "viewer-live" ||
    live === "contractor-live" ||
    live === "guest-static"
  )
    extra.push(
      http.get("*/api/v1/artifacts/:id", ({ params: p }) => {
        const a = fixtures.artifacts.find((x) => x.id === p.id);
        if (!a) return;
        return HttpResponse.json({
          ...a,
          access: "viewer",
          // Employees and contractors see it through a space; a guest, by link.
          space:
            live === "viewer-live" || live === "contractor-live"
              ? {
                  id: "SpEngNpQrSt2uVwX",
                  kind: "shared",
                  name: "Engineering",
                  publicLinks: true,
                }
              : undefined,
          can: {
            edit: false,
            share: false,
            setVisibility: false,
            delete: false,
            transfer: false,
            move: false,
            dataWrite: live === "viewer-live",
          },
          capabilities: {
            db: live !== "guest-static",
            viewer: false,
            storage: false,
          },
        });
      }),
    );
  // ?mock=cpu: 4 CPU-limit hits today, and the first two library requests get a 1102 (the first may be aborted).
  if (params.get("mock") === "cpu") {
    let hits = 0;
    extra.push(
      http.get("*/api/v1/usage", () =>
        HttpResponse.json({
          available: true,
          plan: "free",
          date: new Date().toISOString().slice(0, 10),
          metrics: [
            { key: "requests", used: 1200, limit: 100000 },
            { key: "d1_reads", used: 3400, limit: 5000000 },
            { key: "d1_writes", used: 120, limit: 100000 },
            { key: "do_requests", used: 80, limit: 100000 },
            { key: "cpu_limit_hits", used: 4, limit: 0 },
            { key: "cpu_p99_ms", used: 9.6, limit: 10 },
          ],
        }),
      ),
      http.get("*/api/v1/artifacts", () => {
        if (hits++ >= 2) return undefined;
        return new HttpResponse(
          "<!DOCTYPE html><title>Worker exceeded resource limits</title><h1>Error 1102</h1><p>Worker exceeded resource limits</p>",
          { status: 503, headers: { "content-type": "text/html" } },
        );
      }),
    );
  }
  // ?mock=trash: four deleted artifacts, 0 to 29 days old (two in Engineering
  // when hosted); ?mock=trash-empty: none. Fixed rows for screenshots; the
  // shared mock's own R.trash answers otherwise.
  const trash = params.get("mock");
  if (trash === "trash" || trash === "trash-empty") {
    const day = 86_400_000;
    const personal = {
      id: "Ab3dEfGhJk4mNpQr",
      name: "Personal",
      personal: true,
    };
    const eng =
      params.get("hosted") !== null
        ? { id: "SpEngNpQrSt2uVwX", name: "Engineering", personal: false }
        : personal;
    const row = (id: string, title: string, ago: number, space: object) => {
      const deleted = Date.now() - ago * day;
      return {
        id,
        title,
        description: null,
        format: "html",
        visibility: "private",
        owner: { id: personal.id, name: "Ada", email: "ada@example.com" },
        currentVersion: 1,
        createdAt: new Date(deleted - day).toISOString(),
        updatedAt: new Date(deleted).toISOString(),
        deletedAt: new Date(deleted).toISOString(),
        lastAgent: null,
        thumbnailUrl: null,
        thumbnailVersion: null,
        access: "owner",
        capabilities: { db: false, viewer: false, storage: false },
        dataWriters: "editors",
        allowAnonymousWrites: false,
        purgeAt: new Date(deleted + 30 * day).toISOString(),
        space,
      };
    };
    const items =
      trash === "trash-empty"
        ? []
        : [
            row("TrA1aaaaaaaaaaaa", "Q3 planning board", 0, personal),
            row(
              "TrA2aaaaaaaaaaaa",
              "Launch checklist with a long title that wraps",
              3,
              eng,
            ),
            row("TrA3aaaaaaaaaaaa", "Poll: offsite dates", 25, personal),
            row("TrA4aaaaaaaaaaaa", "Old pricing draft", 29, eng),
          ];
    extra.push(
      http.get("*/api/v1/trash", () =>
        HttpResponse.json({ items, nextCursor: null }),
      ),
    );
  }
  // ?mock=paid: a Workers Paid instance (#279): no daily caps, 30 s of CPU.
  // ?mock=paid-cpu adds 4 CPU-limit hits today.
  const paidCpu = params.get("mock") === "paid-cpu";
  if (params.get("mock") === "paid" || paidCpu)
    extra.push(
      http.get("*/api/v1/usage", () =>
        HttpResponse.json({
          available: true,
          plan: "paid",
          date: new Date().toISOString().slice(0, 10),
          metrics: [
            { key: "requests", used: 182400, limit: 0 },
            { key: "d1_reads", used: 3400, limit: 0 },
            { key: "d1_writes", used: 120, limit: 0 },
            { key: "do_requests", used: 80, limit: 0 },
            { key: "kv_writes", used: 2300, limit: 0 },
            { key: "cpu_limit_hits", used: paidCpu ? 4 : 0, limit: 0 },
            { key: "cpu_p99_ms", used: 18.2, limit: 30000 },
          ],
        }),
      ),
    );
  // Mock-only: the mocks treat unauthenticated requests as anonymous, and a service worker
  // can't see the cookie header, so authenticate with a bearer token instead.
  // Like the cookie it stands in for, it never rides on a credentials:"omit" request.
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const req = new Request(input, init);
    if (req.credentials !== "omit")
      req.headers.set("Authorization", "Bearer mock");
    return realFetch(req);
  };
  // The R.events socket; e2e drives it through window.__oaEvents.
  const events = createArtifactEvents();
  const urls: string[] = [];
  Object.assign(window, { __oaEvents: events, __oaEventsUrls: urls });
  // e2e: which URL each events socket used (embed must say embed=1).
  const seenUrls = ws
    .link("*/api/v1/artifacts/:id/events")
    .addEventListener("connection", ({ client }) => {
      urls.push(client.url.href);
    });
  await setupWorker(
    ...extra,
    ...createHandlers({
      quotaExceeded,
      emailEnabled,
      plan: params.get("mock")?.startsWith("paid") ? "paid" : "free",
      update,
      // ?hosted=1 (or tokens, see hostedParam.ts): the hosted M1 mocks.
      hosted: parseHostedParam(params.get("hosted")),
      events,
    }),
    ...events.handlers,
    seenUrls,
  ).start({
    onUnhandledRequest: "bypass",
  });
}

await startMocks();
const queryClient = makeQueryClient();
// Framed: stay on the /a/<id>/full we booted on (any other route renders the
// not-public panel, and stays there).
if (isEmbed()) lockToPath(router, location.pathname);

const el = document.getElementById("root");
if (!el) throw new Error("missing #root");
createRoot(el).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
