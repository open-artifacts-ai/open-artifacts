import { AppLink } from "../library/AppLink";

/** Wordmark plus breadcrumbs (D4 header). */
export function Crumbs({ title }: { title: string }) {
  return (
    // #2622: no path row on a phone; the title bar's back arrow does its job.
    <header className="flex h-10 items-center gap-[14px] border-0 border-b border-border bg-[var(--oa-chrome)] px-5 [@media(width<=600px)]:hidden">
      <AppLink
        href="/"
        className="font-semibold whitespace-nowrap text-foreground"
      >
        Open Artifacts
      </AppLink>
      <nav
        className="flex min-w-0 items-center gap-[6px] whitespace-nowrap text-muted-foreground"
        aria-label="Breadcrumb"
      >
        <AppLink href="/">Library</AppLink>
        <span aria-hidden="true">/</span>
        <span
          aria-current="page"
          className="overflow-hidden font-medium text-ellipsis text-foreground"
        >
          {title}
        </span>
      </nav>
    </header>
  );
}
