import { AgentViaSchema, FormatSchema, type Role } from "@oa/shared";
import {
  createRootRoute,
  createRoute,
  createRouter,
  type RouterHistory,
  redirect,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import { hasFeature } from "./api/contract";
import { useMe } from "./auth/useMe";
import { AgentsPage } from "./bus/AgentsPage";
import { useCanUseBus, useMachinesAccess } from "./bus/access";
import { Machines } from "./bus/Machines";
import type { AgentsTab } from "./bus/nav";
import { AppLayout } from "./layout/AppLayout";
import { useDocumentTitle } from "./layout/useDocumentTitle";
import { Library } from "./library/Library";
import { SearchPage } from "./library/Search";
import type { Scope } from "./library/useLibraryQuery";
import { NoAccess } from "./pages/NoAccess";
import { NotFound } from "./pages/NotFound";
import { RenderError } from "./pages/RenderError";
import { SignIn } from "./pages/SignIn";
import { useNoAgentsPage } from "./settings/AgentSetupCard";
import { Connections } from "./settings/Agents";
import { Directory } from "./settings/Directory";
import { Instance } from "./settings/Instance";
import { Members } from "./settings/Members";
import { Profile } from "./settings/Profile";
import { Gate, SettingsLayout } from "./settings/SettingsLayout";
import { canAdminSpaces } from "./settings/spaces/access";
import { Spaces } from "./settings/spaces/Spaces";
import { Usage } from "./settings/Usage";
import { Trash } from "./trash/Trash";
import { Diff } from "./viewer/Diff";
import { Shell } from "./viewer/Shell";

// Placeholders; later tasks replace each with the real page.
function Placeholder({ title }: { title: string }) {
  useDocumentTitle(title);
  return <h1>{title}</h1>;
}
const page = (title: string) => () => <Placeholder title={title} />;

// Query values stay strings: `?q=007` must not become the number 7.
const parseSearch = (qs: string) =>
  Object.fromEntries(new URLSearchParams(qs.replace(/^\?/, "")));
const stringifySearch = (o: Record<string, unknown>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o))
    if (v != null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};

const root = createRootRoute({
  component: AppLayout,
  notFoundComponent: NotFound,
});
const route = (path: string, component: () => React.ReactNode) =>
  createRoute({ getParentRoute: () => root, path, component });

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
const library = (path: string, scope: Scope) =>
  createRoute({
    getParentRoute: () => root,
    path,
    validateSearch: (s: Record<string, unknown>) => {
      const format = FormatSchema.safeParse(s.format);
      const view = s.view === "grid" || s.view === "list" ? s.view : undefined;
      const via = AgentViaSchema.safeParse(s.agentVia);
      return {
        ...(format.success && { format: format.data }),
        ...(str(s.agent) && { agent: str(s.agent) }),
        ...(via.success && { agentVia: via.data }),
        ...(str(s.space) && { space: str(s.space) }),
        ...(view && { view }),
      };
    },
    component: () => <Library scope={scope} />,
  });

function ViewerRoute() {
  const { id, v } = useParams({ strict: false }) as { id: string; v?: string };
  const n = v === undefined ? undefined : Number(v);
  if (n !== undefined && !(Number.isInteger(n) && n >= 1)) return <NotFound />;
  return <Shell id={id} v={n} />;
}

/** Chromeless: the artifact alone, current version, same access as /a/$id. */
function FullRoute() {
  const { id } = useParams({ strict: false }) as { id: string };
  return <Shell id={id} chromeless />;
}

/** `/sign-in`: the SPA owns the chooser and the code forms. */
function SignInRoute() {
  const { error, next, method, via } = useSearch({ strict: false }) as {
    error?: string;
    next?: string;
    method?: string;
    via?: "access" | "google";
  };
  return <SignIn error={error} next={next} method={method} via={via} />;
}

function DiffRoute() {
  const { id, from, to } = useParams({ strict: false }) as {
    id: string;
    from: string;
    to: string;
  };
  const a = Number(from);
  const b = Number(to);
  const ok = (n: number) => Number.isInteger(n) && n >= 1;
  if (!ok(a) || !ok(b)) return <NotFound />;
  return <Diff key={`${id}:${a}:${b}`} id={id} from={a} to={b} />;
}

const search = createRoute({
  getParentRoute: () => root,
  path: "/search",
  validateSearch: (s: Record<string, unknown>) => ({
    q: s.q == null ? "" : String(s.q),
    ...(str(s.space) && { space: str(s.space) }),
  }),
  component: SearchPage,
});

/** Every install; guests delete nothing. */
function TrashRoute() {
  const state = useMe();
  if (state.status !== "authed") return null;
  if (state.me.user.role === "guest") return <NotFound />;
  return <Trash />;
}
const trash = createRoute({
  getParentRoute: () => root,
  path: "/trash",
  validateSearch: (s: Record<string, unknown>) => ({
    ...(str(s.spaceId) && { spaceId: str(s.spaceId) }),
  }),
  component: TrashRoute,
});

/** #1293: the bus pages exist only for the server's canConnect with the bus on; anyone else gets Not found. */
function BusRoute({ children }: { children: React.ReactNode }) {
  const ok = useCanUseBus();
  if (ok === null) return null;
  return ok ? children : <NotFound />;
}

/** #1293: the Agents sidebar page's tabs; `?in=` scopes the roster, `?ns=` opens a namespace. */
const agents = (path: AgentsTab) =>
  createRoute({
    getParentRoute: () => root,
    path,
    validateSearch: (s: Record<string, unknown>) => ({
      ...(str(s.in) && { in: str(s.in) }),
      ...(str(s.ns) && { ns: str(s.ns) }),
    }),
    component: function AgentsRoute() {
      const q = useSearch({ strict: false }) as { in?: string; ns?: string };
      return (
        <BusRoute>
          <AgentsPage tab={path} scope={q.in} ns={q.ns} />
        </BusRoute>
      );
    },
  });

/** Settings › Machines: full, revoke-only for a capped member with a machine left (#1447), else Not found. */
function MachinesRoute() {
  const access = useMachinesAccess();
  if (access === null) return null;
  return access === "none" ? (
    <NotFound />
  ) : (
    <Machines revokeOnly={access === "revoke"} />
  );
}

const ADMINS: Role[] = ["owner", "admin"];
/** Guests go to /shared; a member is sent to the page they may see. */
const gated = (
  path: string,
  allow: Role[],
  memberTo: string,
  C: () => React.ReactNode,
) =>
  createRoute({
    getParentRoute: () => settings,
    path,
    component: () => (
      <Gate allow={allow} redirects={{ guest: "/shared", member: memberTo }}>
        <C />
      </Gate>
    ),
  });
/** Hosted only; org admins and members who manage a space. Guests go to /shared. */
function SpacesRoute() {
  const state = useMe();
  if (state.status !== "authed") return null;
  const role = state.me.user.role;
  const ok = canAdminSpaces(state.me);
  return (
    <Gate
      allow={ok ? [role] : []}
      redirects={{
        guest: "/shared",
        member: "/settings/connections",
        owner: "/settings/connections",
        admin: "/settings/connections",
      }}
    >
      <Spaces />
    </Gate>
  );
}
/** Revoke-only with nothing to revoke: no Connections page, so Profile, the first tab. */
function ConnectionsRoute() {
  const none = useNoAgentsPage();
  const to = "/settings/profile";
  return (
    <Gate
      allow={none ? [] : [...ADMINS, "member"]}
      redirects={{ guest: "/shared", member: to, owner: to, admin: to }}
    >
      <Connections />
    </Gate>
  );
}
const settings = createRoute({
  getParentRoute: () => root,
  id: "settings",
  component: SettingsLayout,
});
/** Hosted with `usage_off`: the Usage page is 404 server side, so it goes to Profile. */
function UsageRoute() {
  const state = useMe();
  const off = state.status === "authed" && hasFeature(state.me, "usage_off");
  return (
    <Gate
      allow={off ? [] : ADMINS}
      redirects={
        off
          ? {
              guest: "/shared",
              member: "/",
              owner: "/settings/profile",
              admin: "/settings/profile",
            }
          : { guest: "/shared", member: "/" }
      }
    >
      <Usage />
    </Gate>
  );
}
const usage = createRoute({
  getParentRoute: () => root,
  path: "/settings/usage",
  component: UsageRoute,
});

const routeTree = root.addChildren([
  library("/", "all"),
  library("/mine", "mine"),
  library("/shared", "shared"),
  library("/team", "team"),
  search,
  trash,
  agents("/agents"),
  agents("/agents/namespaces"),
  agents("/agents/roles"),
  agents("/agents/share-notices"),
  route("/a/$id", ViewerRoute),
  route("/a/$id/v/$v", ViewerRoute),
  route("/a/$id/full", FullRoute),
  route("/a/$id/diff/$from/$to", DiffRoute),
  settings.addChildren([
    gated("/settings/profile", [...ADMINS, "member"], "/", Profile),
    gated("/settings/members", ADMINS, "/settings/connections", Members),
    createRoute({
      getParentRoute: () => settings,
      path: "/settings/spaces",
      component: SpacesRoute,
    }),
    gated("/settings/directory", ADMINS, "/settings/connections", Directory),
    createRoute({
      getParentRoute: () => settings,
      path: "/settings/connections",
      component: ConnectionsRoute,
    }),
    // #1293: Settings › Agents is now Connections; old links keep working.
    createRoute({
      getParentRoute: () => settings,
      path: "/settings/agents",
      beforeLoad: ({ location }) => {
        throw redirect({
          to: "/settings/connections",
          search: location.search,
          hash: location.hash,
          replace: true,
        } as never);
      },
    }),
    gated("/settings/instance", ADMINS, "/settings/connections", Instance),
    createRoute({
      getParentRoute: () => settings,
      path: "/settings/machines",
      component: MachinesRoute,
    }),
  ]),
  usage,
  route("/no-access", NoAccess),
  createRoute({
    getParentRoute: () => root,
    path: "/sign-in",
    // After a refused Google sign-in: `?error=` (never echoed) and `?next=`;
    // `?method=code` is the guest code page. An empty `?error=` still counts,
    // as it always has on the Access page.
    validateSearch: (s: Record<string, unknown>) => {
      const error = typeof s.error === "string" ? s.error : undefined;
      const next = str(s.next);
      const method = s.method === "code" ? "code" : undefined;
      // Which sign-in refused a no_access (#799); anything else is dropped.
      const via = s.via === "access" || s.via === "google" ? s.via : undefined;
      return {
        ...(error !== undefined && { error }),
        ...(next && { next }),
        ...(method && { method }),
        ...(via && { via }),
      };
    },
    component: SignInRoute,
  }),
  route("*", NotFound),
]);

export const createAppRouter = (history?: RouterHistory) =>
  createRouter({
    routeTree,
    history,
    parseSearch,
    stringifySearch,
    // A page that throws renders this in the layout's outlet, never a blank app.
    defaultErrorComponent: RenderError,
  });

export const router = createAppRouter();

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
