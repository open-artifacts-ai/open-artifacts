// #1293: the Agents sidebar page (Design option 1, content from design B):
// the roster, namespaces, roles and share notices.
import { useDocumentTitle } from "../layout/useDocumentTitle";
import { muted } from "../settings/ui";
import { NamespacesTab } from "./NamespacesTab";
import { AGENTS_TABS, type AgentsTab, BusLink } from "./nav";
import { RolesTab } from "./Roles";
import { Roster } from "./Roster";
import { ShareNoticesTab } from "./ShareNotices";

/** The settings tabs' look: line tabs on a hairline. */
const TAB =
  "relative inline-flex h-[34px] flex-none items-center rounded-sm px-[var(--oa-space-3)] text-[length:var(--oa-text-sm)] font-medium whitespace-nowrap text-muted-foreground transition-colors after:absolute after:inset-x-0 after:bottom-0 after:h-[2px] after:bg-foreground after:opacity-0 hover:text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-[-2px] focus-visible:outline-ring aria-[current=page]:text-foreground aria-[current=page]:after:opacity-100";

export function AgentsPage({
  tab,
  scope,
  ns,
}: {
  tab: AgentsTab;
  /** `?in=` on the roster. */
  scope?: string;
  /** `?ns=` on Namespaces: one namespace's page. */
  ns?: string;
}) {
  const label = AGENTS_TABS.find((t) => t.to === tab)?.label ?? "Agents";
  useDocumentTitle(
    tab === "/agents" ? "Agent messaging" : `${label} · Agent messaging`,
  );
  return (
    <div className="mx-auto min-w-0 max-w-[1120px]">
      <h1 className="m-0 text-[length:var(--oa-text-xl)] font-semibold">
        Agent messaging
      </h1>
      <p className={`m-0 ${muted}`}>
        Let your running agents discover and message each other across machines.
        Only you see this page.
      </p>
      <nav
        // On phones the strip wraps onto a second row instead of scrolling, so
        // every section stays in view (#1453).
        className="mt-[var(--oa-space-3)] mb-[var(--oa-space-5)] flex flex-wrap gap-x-[var(--oa-space-1)] gap-y-0 shadow-[inset_0_-1px_0_var(--color-border)]"
        aria-label="Agents sections"
      >
        {AGENTS_TABS.map((t) => (
          <BusLink
            key={t.to}
            to={t.to}
            className={TAB}
            aria-current={t.to === tab ? "page" : undefined}
          >
            {t.label}
          </BusLink>
        ))}
      </nav>
      {tab === "/agents" && <Roster scope={scope} />}
      {tab === "/agents/namespaces" && <NamespacesTab ns={ns} />}
      {tab === "/agents/roles" && <RolesTab />}
      {tab === "/agents/share-notices" && <ShareNoticesTab />}
    </div>
  );
}
