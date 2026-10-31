import { Button } from "@oa/ui/shadcn";
import { useQuery } from "@tanstack/react-query";
import { Link, Outlet } from "@tanstack/react-router";
import { KeyRound, ScrollText, Server } from "lucide-react";
import { api } from "../api/client";
import { worldQuery } from "../api/queries";
import { signOut } from "../auth/signOut";
import { ProductionBanner, TokenBanner } from "../components/Banners";
import { fmtLeft } from "../components/labels";
import { LoadError } from "./LoadError";

export function Shell() {
  const me = useQuery({ queryKey: ["me"], queryFn: api.me, retry: false });
  // Only for the token banner; a failure here just means no banner.
  const world = useQuery({ ...worldQuery(), enabled: !!me.data, retry: false });
  const left = me.data?.sessionExpiresAt
    ? me.data.sessionExpiresAt - Date.now()
    : null;
  return (
    <div className="oa-app">
      <aside className="oa-sb">
        <strong className="oa-brand">Platform admin</strong>
        <span
          className={`oa-env ${me.data?.env === "prod" ? "oa-env-prod" : ""}`}
          data-testid="env-slot"
        >
          {me.data ? (me.data.env === "prod" ? "Production" : "Staging") : ""}
        </span>
        <nav className="oa-nav" aria-label="Main">
          <Link to="/installs">
            <Server size={15} aria-hidden /> Installs
          </Link>
          <Link to="/audit">
            <ScrollText size={15} aria-hidden /> Audit log
          </Link>
          <Link to="/tokens">
            <KeyRound size={15} aria-hidden /> Agent tokens
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
        {me.data?.env === "prod" && <ProductionBanner />}
        <main className="oa-page">
          <TokenBanner world={world.data} />
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
