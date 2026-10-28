import { FormatSchema, type Role } from "@oa/shared";
import {
  createRootRoute,
  createRoute,
  createRouter,
  type RouterHistory,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import { hasFeature } from "./api/contract";
import { useMe } from "./auth/useMe";
import { AppLayout } from "./layout/AppLayout";
import { useDocumentTitle } from "./layout/useDocumentTitle";
import { Library } from "./library/Library";
import { SearchPage } from "./library/Search";
import type { Scope } from "./library/useLibraryQuery";
import { NoAccess } from "./pages/NoAccess";
import { NotFound } from "./pages/NotFound";
import { RenderError } from "./pages/RenderError";
import { SignIn } from "./pages/SignIn";
import { Agents } from "./settings/Agents";
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
      return {
        ...(format.success && { format: format.data }),
        ...(str(s.agent) && { agent: str(s.agent) }),
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
        member: "/settings/agents",
        owner: "/settings/agents",
        admin: "/settings/agents",
      }}
    >
      <Spaces />
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
  route("/a/$id", ViewerRoute),
  route("/a/$id/v/$v", ViewerRoute),
  route("/a/$id/full", FullRoute),
  route("/a/$id/diff/$from/$to", DiffRoute),
  settings.addChildren([
    gated("/settings/profile", [...ADMINS, "member"], "/", Profile),
    gated("/settings/members", ADMINS, "/settings/agents", Members),
    createRoute({
      getParentRoute: () => settings,
      path: "/settings/spaces",
      component: SpacesRoute,
    }),
    gated("/settings/directory", ADMINS, "/settings/agents", Directory),
    gated("/settings/agents", [...ADMINS, "member"], "/", Agents),
    gated("/settings/instance", ADMINS, "/settings/agents", Instance),
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
