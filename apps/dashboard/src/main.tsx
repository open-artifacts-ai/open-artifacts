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
  // ?mock=doc: the "Landing page" mock is a collaborative doc (#1100), served by
  // e2e/doc-room.mjs at VITE_DOC_WS; ?mock=doc-readonly: viewed without edit.
  const docMock = params.get("mock");
  if (docMock === "doc" || docMock === "doc-readonly") {
    const { setMockDoc } = await import("./viewer/doc/docMock");
    setMockDoc(fixtures.artifacts[0]?.id ?? null, docMock === "doc-readonly");
  }
  // ?cap=plan: a capped (read-only) member, as a plan lock reports it.
  if (params.get("cap") === "plan")
    extra.push(
      http.get("*/api/v1/me", () =>
        HttpResponse.json({
          ...fixtures.me,
          instance: { ...fixtures.me.instance, docs: "on" },
          auth: {
            method: "google",
            readOnly: true,
            cap: "plan",
            expiresAt: null,
          },
        }),
      ),
    );
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
  // ?mock=login&login=<scenario> (with ?hosted=1): #2520's login settings, see
  // mockLogin.ts. Any other mock: a server without them (the Login tab hides).
  {
    const { LOGIN_SCENARIOS, loginAbsentHandlers, loginHandlers } =
      await import("./mockLogin");
    const pick = params.get("login") as (typeof LOGIN_SCENARIOS)[number] | null;
    extra.push(
      ...(params.get("mock") === "login"
        ? loginHandlers(
            pick && LOGIN_SCENARIOS.includes(pick) ? pick : "owner-off",
            createHandlers({
              hosted: parseHostedParam(params.get("hosted")) ?? {},
            }),
            () => new URLSearchParams(location.search).get("reauthed") === "1",
          )
        : loginAbsentHandlers()),
    );
  }
  // ?mock=restricted and ?mock=restricted-rows (with ?hosted=1): see mockRestricted.ts.
  const restricted = params.get("mock");
  if (restricted === "restricted" || restricted === "restricted-rows") {
    const { restrictedHandlers } = await import("./mockRestricted");
    extra.push(
      ...restrictedHandlers(
        createHandlers({
          hosted: parseHostedParam(params.get("hosted")) ?? {},
        }),
        restricted === "restricted-rows",
      ),
    );
  }
  // ?mock=plan-locked or solo-paused-member (with ?hosted=1): a plan-locked admin, or a member of a paused Solo; see mockRestricted.ts.
  if (restricted === "plan-locked" || restricted === "solo-paused-member") {
    const { planLockedHandlers } = await import("./mockRestricted");
    extra.push(
      ...planLockedHandlers(
        createHandlers({
          hosted: parseHostedParam(params.get("hosted")) ?? {},
        }),
        restricted === "solo-paused-member",
      ),
    );
  }
  // ?mock=transfer-error (with ?hosted=1): a transfer's counts fail to load.
  if (params.get("mock") === "transfer-error")
    extra.push(
      http.get("*/api/v1/members/:id/transfer", () =>
        HttpResponse.json(
          { error: { code: "internal", message: "Something went wrong" } },
          { status: 503 },
        ),
      ),
    );
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
  // ?mock=create-503: creating an artifact answers 503 temporarily_unavailable (the upload itself works).
  if (params.get("mock") === "create-503")
    extra.push(
      http.post("*/api/v1/artifacts", () =>
        HttpResponse.json(
          {
            error: {
              code: "temporarily_unavailable",
              message: "Try again shortly",
            },
          },
          { status: 503, headers: { "Retry-After": "5" } },
        ),
      ),
    );
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
  // ?mock=agent-name (#2277): a stored name that reads as an agent's, so others see the email; after a PATCH the shared mock answers.
  if (params.get("mock") === "agent-name") {
    let saved = false;
    extra.push(
      http.get("*/api/v1/me", () =>
        saved
          ? undefined
          : HttpResponse.json({
              ...fixtures.me,
              displayName: "Ada's agent",
              nameHiddenAs: "email",
            }),
      ),
      http.patch("*/api/v1/me", () => {
        saved = true;
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
  // (a -dev build): a check with nothing to upgrade to. The upgrade notice's
  // states (#1628): update-breaking, update-stale (released 20 days ago),
  // update-custom-older (a custom build behind the latest release) and
  // update-custom-current (a -dev build of the latest version: no notice).
  const checkedAt = new Date(Date.now() - 5 * 60_000).toISOString();
  const published = (days: number) =>
    new Date(Date.now() - days * 86_400_000).toISOString();
  const updates = {
    update: { current: "0.14.2", custom: false, updateAvailable: true },
    uptodate: { current: "0.15.0", custom: false, updateAvailable: false },
    custom: { current: "0.15.0-dev", custom: true, updateAvailable: false },
    "update-breaking": {
      current: "0.14.2",
      custom: false,
      updateAvailable: true,
      breaking: true,
    },
    "update-stale": {
      current: "0.14.2",
      custom: false,
      updateAvailable: true,
      latestPublishedAt: published(20),
    },
    "update-custom-older": {
      current: "0.14.0-dev+4f2a9c1",
      custom: true,
      updateAvailable: false,
      breaking: null,
    },
    "update-custom-breaking": {
      current: "0.14.0-dev+4f2a9c1",
      custom: true,
      updateAvailable: false,
      breaking: true,
    },
    "update-custom-current": {
      current: "0.15.0-dev+4f2a9c1",
      custom: true,
      updateAvailable: false,
      breaking: null,
    },
  } as const;
  const u = updates[params.get("mock") as keyof typeof updates];
  const update = u && {
    latestVersion: "0.15.0",
    breaking: false,
    latestPublishedAt: published(2),
    ...u,
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
  // ?mock=signed-out (#2080): no token, so every request is anonymous.
  const signedOut = params.get("mock") === "signed-out";
  window.fetch = (input, init) => {
    const req = new Request(input, init);
    if (!signedOut && req.credentials !== "omit")
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
  const mainHandlers = createHandlers({
    quotaExceeded,
    emailEnabled,
    plan: params.get("mock")?.startsWith("paid") ? "paid" : "free",
    // ?mock=newdoc (#1100): docs are on (New doc); ?mock=newdoc-gate: a free self-host.
    docs:
      params.get("docs") === "needs_paid"
        ? "needs_paid"
        : params.get("mock") === "newdoc" || params.get("mock") === "doc"
          ? "on"
          : params.get("mock") === "newdoc-gate"
            ? "needs_paid"
            : undefined,
    update,
    // ?hosted=1 (or tokens, see hostedParam.ts): the hosted M1 mocks.
    hosted: parseHostedParam(params.get("hosted")),
    events,
    // ?mock=welcome (#2287): Welcome is seeded and named by the onboarding state.
    // &ticks=connect,name,publish,mention,ask (or stalled) sets how far it is; &opened=1 skips the first-open redirect.
    welcome:
      params.get("mock") === "welcome"
        ? {
            agentConnected: params.get("ticks")?.includes("connect"),
            published: params.get("ticks")?.includes("publish"),
            commented: params.get("ticks")?.includes("comment"),
            named: params.get("ticks")?.includes("name"),
            mentionReplied: params.get("ticks")?.includes("mention"),
            mentionStalled: params.get("ticks")?.includes("stalled"),
            askAnswered: params.get("ticks")?.includes("ask"),
            opened: params.get("opened") === "1",
          }
        : false,
    // ?mock=asks (#1535): the "Landing page" artifact carries two asks.
    commentAsks: params.get("mock") === "asks",
    // ?mock=deciders (#2381): asks in each decider state.
    commentDeciders: params.get("mock") === "deciders",
    // ?passkey=ok|none|cooling|expired (#2263): with mock=asks, a dangerous ask that needs a passkey.
    commentPasskey: ["ok", "none", "cooling", "expired", "many"].includes(
      params.get("passkey") ?? "",
    )
      ? (params.get("passkey") as
          | "ok"
          | "none"
          | "cooling"
          | "expired"
          | "many")
      : undefined,
    // ?mock=passkey-cooling | passkey-usable (#2263): the caller has passkeys; default none.
    passkeys:
      params.get("mock") === "passkey-cooling"
        ? "cooling"
        : params.get("mock") === "passkey-usable"
          ? "usable"
          : params.get("mock") === "passkey-pending"
            ? "pending"
            : "none",
    // ?mock=agents (#1822): agent-authored comments, linked and not.
    commentAgents: params.get("mock") === "agents",
    // ?mock=pins and ?mock=pins-pdf (#2019): the "Landing page" is an image (or a pdf) with pins on it.
    commentPins:
      params.get("mock") === "pins"
        ? "image"
        : params.get("mock") === "pins-pdf"
          ? "pdf"
          : undefined,
    // ?mock=markdown (#2338): agent comments with markdown and a hostile one.
    commentMarkdown: params.get("mock") === "markdown",
    // ?mock=signed-out (#2080): a signed-out viewer on the public "Landing page", where only signed-in people may comment.
    commentersSignedIn: params.get("mock") === "signed-out",
    // ?mock=bus (#1293): the bus is on, with machines and agents.
    bus: params.get("mock") === "bus",
  });
  // e2e (#1100): window.__oaDocVersion makes the doc's GET answer that
  // currentVersion, so a test can watch the version pill tick after the room
  // says a version was saved.
  if (docMock === "doc" || docMock === "doc-readonly") {
    const docId = fixtures.artifacts[0]?.id;
    extra.push(
      http.get(`*/api/v1/artifacts/${docId}`, async ({ request }) => {
        const res = await getResponse(mainHandlers, request);
        if (!res) return undefined;
        const body = (await res.json()) as { currentVersion: number };
        const v = (window as unknown as { __oaDocVersion?: number })
          .__oaDocVersion;
        return HttpResponse.json(v ? { ...body, currentVersion: v } : body);
      }),
      // e2e (#1100): window.__oaMe401 makes /me answer 401, as once the
      // session has ended, so the doc room's sign-in check sees it.
      http.get("*/api/v1/me", () =>
        (window as unknown as { __oaMe401?: boolean }).__oaMe401
          ? HttpResponse.json(
              { error: { code: "unauthorized", message: "Sign in" } },
              { status: 401 },
            )
          : undefined,
      ),
    );
  }
  await setupWorker(
    ...extra,
    ...mainHandlers,
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
const app = (
  <QueryClientProvider client={queryClient}>
    <RouterProvider router={router} />
  </QueryClientProvider>
);
// ?strict=off (mock mode only): render without StrictMode, so an e2e can tell
// what the dev build's double mount does from what a production build does.
const strictOff =
  import.meta.env.VITE_MOCK === "1" &&
  new URLSearchParams(location.search).get("strict") === "off";
createRoot(el).render(strictOff ? app : <StrictMode>{app}</StrictMode>);
