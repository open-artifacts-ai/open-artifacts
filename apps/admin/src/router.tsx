import { useQuery } from "@tanstack/react-query";
import {
  createRootRoute,
  createRoute,
  createRouter,
  defaultParseSearch,
  defaultStringifySearch,
  Outlet,
  redirect,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import { api } from "./api/client";
import { Shell } from "./layout/Shell";
import { Audit } from "./pages/Audit";
import { CreateInstall } from "./pages/CreateInstall";
import { InstallDetail } from "./pages/InstallDetail";
import { Installs, parseStateFilter, type StateFilter } from "./pages/Installs";
import { JobPage } from "./pages/JobPage";
import { NoAccess } from "./pages/NoAccess";
import { SignIn } from "./pages/SignIn";
import { Tokens } from "./pages/Tokens";

const root = createRootRoute({ component: Outlet });
const shell = createRoute({
  getParentRoute: () => root,
  id: "shell",
  component: Shell,
});
const inShell = <P extends string>(path: P, component: () => React.ReactNode) =>
  createRoute({ getParentRoute: () => shell, path, component });

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

const index = createRoute({
  getParentRoute: () => root,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/installs", replace: true });
  },
});

const signIn = createRoute({
  getParentRoute: () => root,
  path: "/sign-in",
  validateSearch: (s: Record<string, unknown>) => ({
    error: str(s.error),
    return: str(s.return),
  }),
  component: function SignInRoute() {
    const { error, return: ret } = useSearch({ strict: false }) as {
      error?: string;
      return?: string;
    };
    return <SignIn error={error} returnTo={ret} />;
  },
});
const noAccess = createRoute({
  getParentRoute: () => root,
  path: "/no-access",
  validateSearch: (s: Record<string, unknown>) => ({
    error: str(s.error),
    sub: str(s.sub),
  }),
  component: function NoAccessRoute() {
    const { error, sub } = useSearch({ strict: false }) as {
      error?: string;
      sub?: string;
    };
    return <NoAccess error={error} sub={sub} />;
  },
});

const useId = () => (useParams({ strict: false }) as { id: string }).id;
function TokensRoute() {
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  return <Tokens env={me.data?.env ?? "prod"} />;
}

const routeTree = root.addChildren([
  index,
  signIn,
  noAccess,
  shell.addChildren([
    createRoute({
      getParentRoute: () => shell,
      path: "/installs",
      validateSearch: (s: Record<string, unknown>): { state?: StateFilter } => {
        const state = parseStateFilter(s.state);
        return state ? { state } : {};
      },
      component: Installs,
    }),
    inShell("/installs/new", CreateInstall),
    inShell("/installs/$id", () => <InstallDetail id={useId()} />),
    inShell("/jobs/$id", () => <JobPage id={useId()} />),
    createRoute({
      getParentRoute: () => shell,
      path: "/audit",
      validateSearch: (
        s: Record<string, unknown>,
      ): { installId?: string; actor?: string; action?: string } => ({
        ...(str(s.installId) ? { installId: str(s.installId) } : {}),
        ...(str(s.actor) ? { actor: str(s.actor) } : {}),
        ...(str(s.action) ? { action: str(s.action) } : {}),
      }),
      component: function AuditRoute() {
        const { installId, actor, action } = useSearch({
          strict: false,
        }) as { installId?: string; actor?: string; action?: string };
        return <Audit installId={installId} actor={actor} action={action} />;
      },
    }),
    inShell("/tokens", TokensRoute),
  ]),
]);

/**
 * The default search codec, except `sub` stays the raw string: parsed as JSON,
 * an all-digit Google account id becomes a rounded number and drops (#1026).
 */
export const searchCodec = {
  parseSearch: (str: string) => {
    const out: Record<string, unknown> = defaultParseSearch(str);
    const raw = new URLSearchParams(str).get("sub");
    if (raw !== null) out.sub = raw;
    return out;
  },
  stringifySearch: (search: Record<string, unknown>) => {
    const { sub, ...rest } = search;
    const str = defaultStringifySearch(rest);
    if (typeof sub !== "string") return str;
    return `${str}${str ? "&" : "?"}sub=${encodeURIComponent(sub)}`;
  },
};

export const router = createRouter({ routeTree, ...searchCodec });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
