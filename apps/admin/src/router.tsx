import { useQuery } from "@tanstack/react-query";
import {
  createRootRoute,
  createRoute,
  createRouter,
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
import { Installs } from "./pages/Installs";
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
    inShell("/installs", Installs),
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

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
