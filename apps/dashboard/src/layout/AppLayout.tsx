import { AUTH, type Me } from "@oa/shared";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Sidebar as ShSidebar,
  SidebarBrand,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@oa/ui/shadcn";
import { useQueryClient } from "@tanstack/react-query";
import {
  Outlet,
  useNavigate,
  useRouterState,
  useSearch,
} from "@tanstack/react-router";
import { type MouseEvent, type ReactNode, useEffect, useRef } from "react";
import { ApiClientError } from "../api/client";
import { hasFeature } from "../api/contract";
import { qk } from "../api/queries";
import { BreakGlass } from "../auth/BreakGlass";
import { useRedirect } from "../auth/redirect";
import { useSignOut } from "../auth/signOut";
import { useMe } from "../auth/useMe";
import { isEmbed, isFullPath } from "../embed";
import { SearchBox } from "../library/SearchBox";
import { EdgePanel } from "../pages/Edge";
import { NotPublic } from "../pages/NotPublic";
import { useDeparted } from "../settings/departed";
import { MEASURE } from "../settings/ui";
import { SpaceSwitcher } from "../spaces/SpaceSwitcher";
import { ATTENTION, AttentionDot } from "./AttentionDot";
import { CpuBanner } from "./CpuBanner";
import { DisplayNamePrompt } from "./DisplayNamePrompt";
import { QuotaBanner } from "./QuotaBanner";
import { SyncBanner, SyncDot, syncDot } from "./SyncBanner";
import { Toaster } from "./toast";
import { UpdateChip, UpdateDot } from "./UpdateChip";
import { UserAvatar } from "./UserAvatar";
import { instanceUpdate, shouldNudge } from "./update";

const icon = (d: string) => (
  <svg
    viewBox="0 0 16 16"
    width="16"
    height="16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d={d} />
  </svg>
);
const I = {
  lib: icon("M2 2h5v5H2zM9 2h5v5H9zM2 9h5v5H2zM9 9h5v5H9z"),
  share: icon("M10.5 5.5 13 8l-2.5 2.5M13 8H5a3 3 0 0 0-3 3"),
  team: icon(
    "M6 3.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM1.5 13.5c.5-2.5 2.3-3.8 4.5-3.8s4 1.3 4.5 3.8",
  ),
  usage: icon("M2.5 11a5.5 5.5 0 1 1 11 0M8 11l2.5-3"),
  trash: icon("M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4M6.5 7v4M9.5 7v4"),
  gear: icon(
    "M8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM8 1.8v1.7M8 12.5v1.7M1.8 8h1.7M12.5 8h1.7",
  ),
};

/** Routes that render without the app shell (edge pages, viewer owns its chrome). */
const bareRoute = (p: string) => publicRoute(p) || p === "/no-access";
/** Routes an anonymous visitor may see. */
const publicRoute = (raw: string) => {
  const p = raw.toLowerCase(); // the router matches case-insensitively
  return p === "/sign-in" || p === "/no-access" || p.startsWith("/a/");
};

/** The app's one Toaster sits beside every layout below. */
export function AppLayout() {
  return (
    <>
      <Layout />
      <Toaster />
    </>
  );
}

function Layout() {
  const state = useMe();
  const redirect = useRedirect();
  const loc = useRouterState({ select: (s) => s.location });
  // The rendered leaf match: mid-navigation `location` is already the target while
  // the old match still renders, which would remount it under the other layout.
  const path =
    useRouterState({ select: (s) => s.matches.at(-1)?.pathname }) ??
    loc.pathname;
  const embed = isEmbed();
  // Break-glass outlives a /me refetch (pending, with no data), so the card
  // isn't swapped for the shell while /me is asked again.
  const breakGlass = useRef<boolean | null>(null);
  if (state.status === "breakGlass") breakGlass.current = state.fresh;
  else if (state.status !== "loading") breakGlass.current = null;
  const anonymous =
    !embed && state.status === "anonymous" && !publicRoute(path);

  useEffect(() => {
    if (anonymous)
      redirect(
        `${AUTH.login}?next=${encodeURIComponent(path + loc.searchStr)}`,
      );
  }, [anonymous, redirect, path, loc.searchStr]);

  const navigate = useNavigate();
  const guestHome =
    state.status === "authed" &&
    state.me.user.role === "guest" &&
    ["/", "/mine", "/team"].includes(path);
  useEffect(() => {
    if (guestHome) void navigate({ to: "/shared" as string, replace: true });
  }, [guestHome, navigate]);

  if (anonymous || guestHome) return null;
  // The owner locked out by a directory mismatch: the card, with no app shell.
  if (!embed && breakGlass.current !== null)
    return (
      <main id="oa-main">
        <BreakGlass
          fresh={breakGlass.current}
          path={path}
          search={loc.searchStr}
        />
      </main>
    );
  // Framed: /a/<id>/full alone, with no app chrome or banners.
  if (embed)
    return (
      <main id="oa-main">{isFullPath(path) ? <Outlet /> : <NotPublic />}</main>
    );
  if (bareRoute(path))
    return (
      <main id="oa-main">
        <QuotaBanner />
        <Outlet />
      </main>
    );
  if (state.status === "error")
    return (
      <main id="oa-main">
        <QuotaBanner />
        <LoadError
          quota={
            state.error instanceof ApiClientError &&
            state.error.code === "quota_exceeded"
          }
        />
      </main>
    );
  const me = state.status === "authed" ? state.me : null;
  return (
    <SidebarProvider>
      <ContentScrollReset path={path} />
      <a
        href="#oa-main"
        className="sr-only z-[60] rounded-sm bg-[var(--oa-surface)] px-[var(--oa-space-2)] py-[var(--oa-space-1)] text-[var(--oa-text)] shadow-[var(--oa-shadow-2)] focus:not-sr-only focus:fixed focus:top-[var(--oa-space-2)] focus:left-[var(--oa-space-2)]"
      >
        Skip to content
      </a>
      <Sidebar me={me} path={path} />
      {/* The inset panel (Design's sidebar B), SidebarInset's box as a div so
          the header stays the banner, outside <main>. From 768px it floats
          8px in from the chrome (0 on the sidebar side unless collapsed),
          viewport-tall, and its content (not the panel) scrolls under the
          header. Below 768px it is full-bleed and the page scrolls. */}
      <div className="relative flex w-full min-w-0 flex-1 flex-col bg-[var(--oa-bg)] md:m-[var(--oa-space-2)] md:ml-0 md:h-[calc(100svh-2*var(--oa-space-2))] md:rounded-[var(--oa-radius-lg)] md:border md:border-[var(--oa-border)] md:peer-data-[state=collapsed]:ml-[var(--oa-space-2)]">
        <header className="sticky top-0 z-[5] flex h-12 flex-none items-center gap-[10px] border-0 border-b border-[var(--oa-divider)] bg-[var(--oa-bg)] px-[var(--oa-space-5)] max-md:px-[var(--oa-space-3)] md:static md:rounded-t-[calc(var(--oa-radius-lg)-1px)]">
          <MenuTrigger me={me} />
          <TopBar me={me} />
        </header>
        {/* Focusable (not tabbable) so the keyboard can scroll it. */}
        <main
          id="oa-main"
          tabIndex={-1}
          className="min-w-0 flex-1 outline-none md:min-h-0 md:overflow-auto md:rounded-b-[calc(var(--oa-radius-lg)-1px)] md:[scrollbar-gutter:stable]"
        >
          <QuotaBanner />
          <div className="oa-page">
            {/* In the page's content column: the settings measure there.
                The Directory page's own status header replaces the sync banner. */}
            {!/^\/settings\/directory\/?$/i.test(path) && (
              <SyncBanner
                me={me}
                className={/^\/settings(\/|$)/i.test(path) ? MEASURE : ""}
              />
            )}
            <CpuBanner
              role={me?.user.role}
              plan={me?.instance.plan}
              usageOff={hasFeature(me, "usage_off")}
              className={/^\/settings(\/|$)/i.test(path) ? MEASURE : ""}
            />
            <Outlet />
          </div>
        </main>
      </div>
      {me && <DisplayNamePrompt key={me.user.id} me={me} />}
    </SidebarProvider>
  );
}

/** Opens/collapses the sidebar. On phones, an update (Design's A) puts a dot
    on it; so does anything that lights Settings: sync trouble (D13 B) or
    departed people with artifacts to transfer. */
function MenuTrigger({ me }: { me: Me | null }) {
  const { isMobile } = useSidebar();
  const update = instanceUpdate(me);
  const sync = syncDot(me);
  const departed = useDeparted(me).length > 0;
  const dot = isMobile && shouldNudge(update);
  // A sync tone wins; departed people alone get the accent.
  const settingsTone =
    isMobile && !dot ? (sync ?? (departed ? "accent" : null)) : null;
  return (
    <span className="relative inline-flex">
      {/* Settings' dot keeps the trigger's name and describes it instead:
          its causes (a held sweep, a departed person) can sit for days. */}
      <SidebarTrigger
        aria-label={dot ? "Open menu, update available" : "Toggle navigation"}
        aria-describedby={settingsTone ? "oa-menu-settings" : undefined}
      />
      {dot && (
        <UpdateDot
          breaking={update.breaking === true}
          ring="page"
          className="pointer-events-none absolute top-[6px] right-[5px]"
        />
      )}
      {settingsTone && (
        <span id="oa-menu-settings" hidden>
          Settings needs attention
        </span>
      )}
      {settingsTone && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute top-[6px] right-[5px] block size-2 rounded-full"
          style={{
            background: `var(--oa-${settingsTone})`,
            boxShadow: "0 0 0 2px var(--oa-bg)",
          }}
        />
      )}
    </span>
  );
}

/** The daily quota is an expected state, so it gets its own copy. */
function LoadError({ quota }: { quota: boolean }) {
  const client = useQueryClient();
  return (
    <EdgePanel>
      {quota ? (
        <>
          <h1>Daily limit reached</h1>
          <p>
            This instance has used today's free-plan requests. Your artifacts
            are safe; try again after the reset.
          </p>
        </>
      ) : (
        <>
          <h1>Couldn't load your account</h1>
          <p>Something went wrong reaching the server.</p>
        </>
      )}
      <div className="oa-actions">
        <button
          type="button"
          className="oa-btn oa-primary"
          onClick={() => void client.refetchQueries({ queryKey: qk.me })}
        >
          Retry
        </button>
      </div>
    </EdgePanel>
  );
}

/** From 768px the panel's content scrolls, not the window, so a new page
    starts at its top. */
function ContentScrollReset({ path }: { path: string }) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs per page
  useEffect(() => {
    const main = document.getElementById("oa-main");
    if (main) main.scrollTop = 0;
  }, [path]);
  return null;
}

/** A router link that also closes the phone sheet. */
const useGo = () => {
  const navigate = useNavigate();
  const { setOpenMobile } = useSidebar();
  return (e: MouseEvent, to: string) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
      return;
    e.preventDefault();
    setOpenMobile(false);
    void navigate({ to });
  };
};

function Link({
  to,
  active,
  icon,
  label,
  attention,
}: {
  to: string;
  active: boolean;
  icon: ReactNode;
  label: string;
  /** A lasting dot: a sync tone (D13 B) wins over true (something there needs an admin). */
  attention?: boolean | "warning" | "danger" | null;
}) {
  const go = useGo();
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={active}>
        <a
          href={to}
          aria-current={active ? "page" : undefined}
          aria-label={attention ? `${label}${ATTENTION}` : undefined}
          onClick={(e) => go(e, to)}
        >
          {icon}
          <span>{label}</span>
          {typeof attention === "string" ? (
            <SyncDot tone={attention} className="ml-auto" />
          ) : (
            attention && <AttentionDot />
          )}
        </a>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function Sidebar({ me, path }: { me: Me | null; path: string }) {
  const role = me?.user.role;
  const guest = role === "guest";
  const on = (p: string) => path === p || path.startsWith(`${p}/`);
  const go = useGo();
  const home = guest ? "/shared" : "/";
  const { space } = useSearch({ strict: false }) as { space?: string };
  const inSpace = Boolean(space) && hasFeature(me, "spaces");
  const update = instanceUpdate(me);
  // Departed people with artifacts to transfer (org admins, hosted).
  const departed = useDeparted(me);
  const usageOff = hasFeature(me, "usage_off");
  const sync = syncDot(me);
  return (
    <ShSidebar variant="inset">
      <SidebarHeader
        className="h-12 justify-center gap-0 p-0 in-data-[mobile=true]:mx-2 in-data-[mobile=true]:mt-2"
        onClick={(e) => {
          if ((e.target as Element).closest("a")) go(e, home);
        }}
      >
        <SidebarBrand
          href={home}
          name={me?.instance.name || "Open Artifacts"}
        />
      </SidebarHeader>
      {/* The phone sheet has no inset container, so it takes the desktop's
          8px itself. */}
      <SidebarContent className="in-data-[mobile=true]:px-2">
        <nav aria-label="Primary">
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                {guest ? (
                  <Link
                    to="/shared"
                    active={on("/shared")}
                    icon={I.share}
                    label="Shared with me"
                  />
                ) : (
                  <>
                    <Link
                      to="/"
                      // While a space is open, its Spaces link is current instead.
                      active={path === "/" && !inSpace}
                      icon={I.lib}
                      label="Library"
                    />
                    {me && (
                      <Link
                        to="/shared"
                        active={on("/shared")}
                        icon={I.share}
                        label="Shared with me"
                      />
                    )}
                    {me && (
                      <Link
                        to="/team"
                        active={on("/team")}
                        icon={I.team}
                        label="Team"
                      />
                    )}
                    {(role === "owner" || role === "admin") && !usageOff && (
                      <Link
                        to="/settings/usage"
                        active={on("/settings/usage")}
                        icon={I.usage}
                        label="Usage"
                      />
                    )}
                    {me && (
                      <Link
                        to="/settings/members"
                        active={
                          path.startsWith("/settings") && !on("/settings/usage")
                        }
                        icon={I.gear}
                        label="Settings"
                        attention={sync ?? departed.length > 0}
                      />
                    )}
                  </>
                )}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </nav>
        <SpaceSwitcher path={path} />
        {/* Its own group under Spaces (Design's Trash A), on every install. */}
        {me && !guest && (
          <nav aria-label="Trash">
            <SidebarGroup>
              <SidebarGroupContent>
                <SidebarMenu>
                  <Link
                    to="/trash"
                    active={on("/trash")}
                    icon={I.trash}
                    label="Trash"
                  />
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </nav>
        )}
      </SidebarContent>
      {/* On phones the chip takes the nav rows' inset: 8px (content) + 8px (group). */}
      {shouldNudge(update) && (
        <SidebarFooter className="in-data-[mobile=true]:px-4 in-data-[mobile=true]:pb-3">
          <UpdateChip
            update={update}
            onSettings={(e) => go(e, "/settings/instance")}
          />
        </SidebarFooter>
      )}
    </ShSidebar>
  );
}

function TopBar({ me }: { me: Me | null }) {
  const signOut = useSignOut();
  if (!me) return null;
  return (
    <>
      <SearchBox />
      <div
        style={{
          marginLeft: "auto",
          display: "flex",
          gap: 8,
          alignItems: "center",
        }}
      >
        {/* Below 640px the avatar alone (it opens the account menu), so the
            search and its space chip get the room. */}
        <span data-header-email="" className="max-[640px]:hidden">
          {me.user.email}
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              title="Account menu"
              className="h-auto px-[2px] py-0"
            >
              {/* Named by hidden text, not aria-label, so the visible initials never contradict it. */}
              <span className="oa-sr">Account menu</span>
              <span aria-hidden="true" style={{ display: "contents" }}>
                <UserAvatar
                  name={me.user.name ?? undefined}
                  email={me.user.email}
                />
              </span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="min-w-[200px] text-[length:var(--oa-text-sm)]"
          >
            {/* Who's signed in: a label, not an item (the header hides it on phones). */}
            <DropdownMenuLabel className="truncate font-normal text-muted-foreground">
              {me.user.email}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={signOut}>Sign out</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </>
  );
}
