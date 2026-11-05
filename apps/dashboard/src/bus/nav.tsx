// #1293: in-app links between the Agents tabs, with their search params.
import { useNavigate } from "@tanstack/react-router";
import type { ComponentProps } from "react";

/** A text link in body copy. */
export const LINK = "underline underline-offset-2";

export const AGENTS_TABS = [
  { to: "/agents", label: "Agents" },
  { to: "/agents/namespaces", label: "Namespaces" },
  { to: "/agents/roles", label: "Roles and access" },
  { to: "/agents/share-notices", label: "Share notices" },
] as const;
export type AgentsTab = (typeof AGENTS_TABS)[number]["to"];

const href = (to: string, search: Record<string, string | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(search)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `${to}?${s}` : to;
};

/** A plain link that navigates in-app (modifier clicks open as usual). */
export function BusLink({
  to,
  search = {},
  onClick,
  ...rest
}: Omit<ComponentProps<"a">, "href"> & {
  to: string;
  search?: Record<string, string | undefined>;
}) {
  const navigate = useNavigate();
  return (
    // biome-ignore lint/a11y/useAnchorContent: children come through rest
    <a
      {...rest}
      href={href(to, search)}
      onClick={(e) => {
        onClick?.(e);
        if (
          e.defaultPrevented ||
          e.button !== 0 ||
          e.metaKey ||
          e.ctrlKey ||
          e.shiftKey ||
          e.altKey
        )
          return;
        e.preventDefault();
        void navigate({ to, search } as never);
      }}
    />
  );
}
