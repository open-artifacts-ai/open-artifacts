import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import { Shell } from "./layout/Shell";
import { NoAccess } from "./pages/NoAccess";
import { SignIn } from "./pages/SignIn";

function Placeholder({ title, goes }: { title: string; goes: string }) {
  return (
    <>
      <h1>{title}</h1>
      <p className="oa-placeholder">{goes}</p>
    </>
  );
}

const root = createRootRoute({ component: Outlet });
const shell = createRoute({
  getParentRoute: () => root,
  id: "shell",
  component: Shell,
});
const page = (title: string, goes: string) => () => (
  <Placeholder title={title} goes={goes} />
);
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
    const { error, return: ret } = useSearch({ from: "/sign-in" });
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
    const { error, sub } = useSearch({ from: "/no-access" });
    return <NoAccess error={error} sub={sub} />;
  },
});

function Param({ title, goes }: { title: string; goes: string }) {
  const { id } = useParams({ strict: false }) as { id: string };
  return <Placeholder title={`${title} ${id}`} goes={goes} />;
}

const routeTree = root.addChildren([
  index,
  signIn,
  noAccess,
  shell.addChildren([
    inShell(
      "/installs",
      page(
        "Installs",
        "The installs list goes here: counts, active jobs, attention list.",
      ),
    ),
    inShell(
      "/installs/new",
      page("Create install", "Version select and live slug check go here."),
    ),
    inShell("/installs/$id", () => (
      <Param
        title="Install"
        goes="Install detail and lifecycle actions go here."
      />
    )),
    inShell("/jobs/$id", () => (
      <Param
        title="Job"
        goes="Job steps, attempt, last error and next retry go here."
      />
    )),
    inShell("/audit", page("Audit", "The audit log goes here.")),
    inShell(
      "/tokens",
      page(
        "Tokens",
        "Token mint, revoke and the connect-any-AI-agent card go here.",
      ),
    ),
  ]),
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
