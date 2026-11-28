import type * as React from "react";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "#shadcn/ui/sidebar";

// Paths of src/brand/mark.svg: the frame takes currentColor, the corners
// and the artifact take the accent (as --oa-brand-accent, then --oa-accent).
const FRAME =
  "M22 2H5a3 3 0 0 0-3 3v17l4 4V6h20zM10 30h17a3 3 0 0 0 3-3V10l-4-4v20H6z";
const ACCENT =
  "M22 2h5a3 3 0 0 1 3 3v5zM2 22v5a3 3 0 0 0 3 3h5zM12 10h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z";

/** The Framed Artifact mark, inline so it follows the theme. Decorative. */
export function BrandMark(props: React.ComponentProps<"svg">) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" {...props}>
      <path fill="currentColor" d={FRAME} />
      <path
        style={{ fill: "var(--oa-brand-accent, var(--oa-accent))" }}
        d={ACCENT}
      />
    </svg>
  );
}

/** Sidebar header row: the mark and the product name, linking home. */
export function SidebarBrand({
  href = "/",
  name = "Open Artifacts",
}: {
  href?: string;
  name?: string;
}) {
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton size="lg" asChild className="[&>svg]:size-6">
          <a href={href}>
            <BrandMark />
            <span className="text-base font-semibold tracking-tight">
              {name}
            </span>
          </a>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
