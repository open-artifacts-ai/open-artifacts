import { Button } from "@oa/ui/shadcn";
import { useQuery } from "@tanstack/react-query";
import { Link, Outlet } from "@tanstack/react-router";
import { api } from "../api/client";
import { LoadError } from "./LoadError";

// POST /auth/logout, then the sign-in screen.
async function signOut() {
  try {
    await api.logout();
  } catch {
    // Go to sign-in anyway; an expired session is signed out already.
  }
  window.location.assign("/sign-in");
}

export function Shell() {
  const me = useQuery({ queryKey: ["me"], queryFn: api.me, retry: false });
  return (
    <div className="oa-shell">
      <header className="oa-topbar">
        <strong>Open Artifacts Admin</strong>
        {/* Environment slot: the prod banner goes here. */}
        <span className="oa-env" data-testid="env-slot" />
        <span className="oa-spacer" />
        {me.data && <span>{me.data.email}</span>}
        <Button variant="outline" size="sm" onClick={signOut}>
          Sign out
        </Button>
      </header>
      <div className="oa-body">
        <nav className="oa-nav" aria-label="Main">
          <Link to="/" activeOptions={{ exact: false }}>
            Installs
          </Link>
          <Link to="/audit">Audit</Link>
          <Link to="/tokens">Tokens</Link>
        </nav>
        <main className="oa-page">
          {me.data ? (
            <Outlet />
          ) : me.isError ? (
            <LoadError
              title="Couldn't load your session"
              error={me.error}
              onRetry={() => void me.refetch()}
            />
          ) : null}
        </main>
      </div>
    </div>
  );
}
