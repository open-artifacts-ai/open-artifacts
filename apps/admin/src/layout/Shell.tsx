import { Button } from "@oa/ui/shadcn";
import { useQuery } from "@tanstack/react-query";
import { Link, Outlet } from "@tanstack/react-router";
import { api } from "../api/client";

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
        {/* TODO(C1): confirm the sign-out path. */}
        <Button asChild variant="outline" size="sm">
          <a href="/v1/auth/sign-out">Sign out</a>
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
        <main className="oa-page">{me.data ? <Outlet /> : null}</main>
      </div>
    </div>
  );
}
