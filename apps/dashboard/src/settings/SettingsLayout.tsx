import type { Role } from "@oa/shared";
import { Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { type ReactNode, useEffect } from "react";
import { useMe } from "../auth/useMe";
import { ATTENTION, AttentionDot } from "../layout/AttentionDot";
import { SyncDot, syncDot } from "../layout/SyncBanner";
import { AppLink } from "../library/AppLink";
import { useDeparted } from "./departed";
import { canAdminSpaces } from "./spaces/access";
import { MEASURE } from "./ui";

/** Route links styled as shadcn's line tabs: the hairline is an inset
    shadow and the underline sits on it, so the scrolling strip clips
    neither; the focus ring is inset for the same reason. */
const TAB =
  "relative inline-flex h-[34px] flex-none items-center rounded-sm px-[var(--oa-space-3)] text-[length:var(--oa-text-sm)] font-medium whitespace-nowrap text-muted-foreground transition-colors after:absolute after:inset-x-0 after:bottom-0 after:h-[2px] after:bg-foreground after:opacity-0 hover:text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-[-2px] focus-visible:outline-ring aria-[current=page]:text-foreground aria-[current=page]:after:opacity-100";

const TABS: {
  to: string;
  label: string;
  roles: Role[];
  /** Only where the instance reports a directory (hosted, or self-host with Workspace connected). */
  directory?: true;
  /** Hosted spaces admin: org admins, and members who manage a space. */
  spaces?: true;
}[] = [
  {
    to: "/settings/profile",
    label: "Profile",
    roles: ["owner", "admin", "member"],
  },
  { to: "/settings/members", label: "Members", roles: ["owner", "admin"] },
  {
    to: "/settings/spaces",
    label: "Spaces",
    roles: ["owner", "admin", "member"],
    spaces: true,
  },
  {
    to: "/settings/directory",
    label: "Directory",
    roles: ["owner", "admin"],
    directory: true,
  },
  {
    to: "/settings/agents",
    label: "Agents",
    roles: ["owner", "admin", "member"],
  },
  { to: "/settings/instance", label: "Instance", roles: ["owner", "admin"] },
];

export function SettingsLayout() {
  const state = useMe();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const role = state.status === "authed" ? state.me.user.role : null;
  const me = state.status === "authed" ? state.me : null;
  const directory = me?.instance.directory;
  const sync = syncDot(me);
  // Compare the normalized path: the router matches case-insensitively, ignoring a trailing slash.
  const here = path.toLowerCase().replace(/\/+$/, "");
  // Departed people with artifacts to transfer light the Members tab.
  const departed = useDeparted(state.status === "authed" ? state.me : null);
  if (role === "guest") return <Outlet />; // no chrome; the gate redirects
  return (
    // The 880px measure, centered in the shell gutter.
    <div className={MEASURE}>
      <h1 className="text-[length:var(--oa-text-xl)] font-semibold">
        Settings
      </h1>
      <nav
        // On phones the row scrolls: the right edge fades so it reads as more to see,
        // and the end padding lets the last tab scroll clear of the fade.
        className="mt-[var(--oa-space-3)] mb-[var(--oa-space-5)] flex gap-[var(--oa-space-1)] overflow-x-auto shadow-[inset_0_-1px_0_var(--color-border)] [scrollbar-width:none] max-[600px]:pr-[24px] max-[600px]:[mask-image:linear-gradient(to_right,#000_calc(100%-24px),transparent)]"
        aria-label="Settings sections"
      >
        {TABS.filter(
          (t) =>
            role &&
            t.roles.includes(role) &&
            (!t.directory || directory) &&
            (!t.spaces || canAdminSpaces(me)),
        ).map((t) => (
          <AppLink
            key={t.to}
            href={t.to}
            className={`${TAB} gap-[6px]`}
            aria-current={here === t.to ? "page" : undefined}
            aria-label={
              (t.to === "/settings/members" && departed.length > 0) ||
              (t.directory && sync)
                ? `${t.label}${ATTENTION}`
                : undefined
            }
          >
            {t.label}
            {t.to === "/settings/members" && departed.length > 0 && (
              <AttentionDot />
            )}
            {t.directory && sync && <SyncDot tone={sync} small />}
          </AppLink>
        ))}
      </nav>
      <Outlet />
    </div>
  );
}

/** Role gate: renders `children` for `allow`, else redirects per `redirects` (default `/shared`). */
export function Gate({
  allow,
  redirects,
  children,
}: {
  allow: Role[];
  redirects: Partial<Record<Role, string>>;
  children: ReactNode;
}) {
  const state = useMe();
  const role = state.status === "authed" ? state.me.user.role : null;
  const to = role && !allow.includes(role) ? (redirects[role] ?? "/") : null;
  useRedirectEffect(to);
  return role && !to ? <>{children}</> : null;
}

function useRedirectEffect(to: string | null) {
  const navigate = useNavigate();
  useEffect(() => {
    if (to) void navigate({ to: to as string, replace: true });
  }, [to, navigate]);
}
