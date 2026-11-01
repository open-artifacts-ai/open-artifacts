import { Button } from "@oa/ui/shadcn";
import { useQuery } from "@tanstack/react-query";
import { Link, Outlet } from "@tanstack/react-router";
import { KeyRound, ScrollText, Server } from "lucide-react";
import { useEffect } from "react";
import { api } from "../api/client";
import { worldQuery } from "../api/queries";
import { signOut } from "../auth/signOut";
import { ProductionBanner, TokenBanner } from "../components/Banners";
import { fmtLeft } from "../components/labels";
import { LoadError } from "./LoadError";

export function Shell() {
  const me = useQuery({ queryKey: ["me"], queryFn: api.me, retry: false });
  // The panel is for an admin session (C1 MeSchema: principal "admin", role "admin").
  // Any other principal that gets a /me answer sees the no-access screen.
  const isAdmin = me.data?.principal === "admin" && me.data.role === "admin";
  const notAdmin = !!me.data && !isAdmin;
  useEffect(() => {
    if (notAdmin) api.redirect("/no-access?error=not_listed");
  }, [notAdmin]);
  // Only for the token banner; a failure here just means no banner.
  const world = useQuery({ ...worldQuery(), enabled: isAdmin, retry: false });
  const left = me.data?.sessionExpiresAt
    ? me.data.sessionExpiresAt - Date.now()
    : null;
  return (
    <div className="oa-app">
      <aside className="oa-sb">
        <strong className="oa-brand">
          <span className="oa-mark" aria-hidden />
          Platform admin
        </strong>
        <span
          className={`oa-env ${me.data?.env === "prod" ? "oa-env-prod" : ""}`}
          data-testid="env-slot"
        >
          {me.data ? (me.data.env === "prod" ? "Production" : "Staging") : ""}
        </span>
        <nav className="oa-nav" aria-label="Main">
          <Link to="/installs">
            <Server size={14} aria-hidden /> Installs
          </Link>
          <Link to="/audit">
            <ScrollText size={14} aria-hidden /> Audit log
          </Link>
          <Link to="/tokens">
            <KeyRound size={14} aria-hidden /> Agent tokens
          </Link>
        </nav>
        <div className="oa-sbfoot">
          {me.data && (
            <>
              <div>
                Signed in as <span>{me.data.email ?? "an admin"}</span>
              </div>
              {left !== null && left > 0 && (
                <div data-testid="session-hint">
                  Session ends in {fmtLeft(left)}
                </div>
              )}
            </>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => void signOut("/sign-in")}
          >
            Sign out
          </Button>
        </div>
      </aside>
      <div className="oa-main">
        {isAdmin && me.data?.env === "prod" && <ProductionBanner />}
        <main className="oa-page">
          <TokenBanner world={world.data} />
          {isAdmin ? (
            <Outlet />
          ) : notAdmin ? null : me.isError ? (
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
