// The sidebar's Spaces section (Design D1/D2, Spaces A): Personal, then every
// shared space the caller has a role in, by name. Past 8, the first 8 and an
// inline "Show all (N)" that expands in place. Each opens the Library
// filtered to it (`/?space=<id>`); Library stays the view across spaces.
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@oa/ui/shadcn";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { type MouseEvent, useState } from "react";
import { hasFeature } from "../api/contract";
import { useMe } from "../auth/useMe";
import { sharedSpaceName } from "./label";

const VISIBLE = 8;

function SpaceLink({
  id,
  label,
  active,
}: {
  id: string;
  label: string;
  active: boolean;
}) {
  const navigate = useNavigate();
  const { setOpenMobile } = useSidebar();
  const href = `/?space=${encodeURIComponent(id)}`;
  const go = (e: MouseEvent) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
      return;
    e.preventDefault();
    setOpenMobile(false);
    void navigate({ to: "/", search: { space: id } } as never);
  };
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={active}>
        <a href={href} aria-current={active ? "page" : undefined} onClick={go}>
          <span className="truncate">{label}</span>
        </a>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

export function SpaceSwitcher({ path }: { path: string }) {
  const state = useMe();
  const { space: current } = useSearch({ strict: false }) as {
    space?: string;
  };
  const [all, setAll] = useState(false);
  const navigate = useNavigate();
  const { setOpenMobile } = useSidebar();
  const me = state.status === "authed" ? state.me : null;
  if (!me || me.user.role === "guest" || !hasFeature(me, "spaces")) return null;
  // Any Library tab with ?space= counts as being in that space.
  const inLibrary = ["/", "/mine", "/shared", "/team"].includes(path);
  const here = (id: string) => inLibrary && current === id;
  const spaces = [...(me.spaces ?? [])].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const shown = all ? spaces : spaces.slice(0, VISIBLE);
  const admin = me.user.role === "owner" || me.user.role === "admin";
  return (
    <nav aria-label="Spaces">
      <SidebarGroup>
        <SidebarGroupLabel>Spaces</SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu>
            {me.personalSpaceId && (
              <SpaceLink
                id={me.personalSpaceId}
                label="Personal"
                active={here(me.personalSpaceId)}
              />
            )}
            {shown.map((s) => (
              <SpaceLink
                key={s.id}
                id={s.id}
                label={sharedSpaceName(s.name)}
                active={here(s.id)}
              />
            ))}
            {spaces.length > VISIBLE && !all && (
              <SidebarMenuItem>
                <SidebarMenuButton
                  aria-expanded={false}
                  className="text-muted-foreground"
                  onClick={() => setAll(true)}
                >
                  Show all ({spaces.length})
                </SidebarMenuButton>
              </SidebarMenuItem>
            )}
          </SidebarMenu>
          {spaces.length === 0 && (
            <div className="grid gap-[6px] px-[var(--oa-space-2)] pt-[var(--oa-space-1)] text-[length:var(--oa-text-xs)] text-muted-foreground">
              <b className="font-medium text-foreground">No spaces yet</b>
              <span>
                Your admin hasn't set up spaces. What you publish stays in
                Personal until they do.
              </span>
              {admin && (
                <a
                  href="/settings/spaces"
                  className="w-fit underline underline-offset-2"
                  onClick={(e) => {
                    if (e.button !== 0 || e.metaKey || e.ctrlKey) return;
                    e.preventDefault();
                    setOpenMobile(false);
                    void navigate({ to: "/settings/spaces" });
                  }}
                >
                  Set up spaces
                </a>
              )}
            </div>
          )}
        </SidebarGroupContent>
      </SidebarGroup>
    </nav>
  );
}
