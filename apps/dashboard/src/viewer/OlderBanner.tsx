import { type ArtifactSummary, viewerPath } from "@oa/shared";
import { Button } from "@oa/ui/shadcn";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { useCan } from "../auth/permissions";
import { RestoreDialog } from "./RestoreDialog";
import { BAR } from "./ui";

/**
 * #2118: one amber strip under the title bar while an older version is open:
 * what you are looking at, Restore it (if you can edit) and Back to current.
 */
export function OlderBanner({
  artifact,
  version,
  current,
}: {
  artifact: ArtifactSummary;
  version: number;
  /** The newest version known, live or fetched. */
  current: number;
}) {
  const { id } = artifact;
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const canRestore = useCan(artifact).edit;
  const [asking, setAsking] = useState(false);
  return (
    <div
      data-older-banner=""
      data-current={current}
      className="flex flex-wrap items-center gap-x-3 gap-y-2 border-0 border-b border-border bg-[var(--oa-warning-soft)] px-5 py-2 text-[length:var(--oa-text-md)] leading-[1.45] text-foreground max-[600px]:px-4"
    >
      <span role="status" className="min-w-0 flex-1 max-[600px]:basis-full">
        You're viewing <b>v{version}</b>, an older version.
      </span>
      <div className="flex flex-none items-center gap-2">
        {canRestore && (
          <Button
            size="xs"
            className={`${BAR} bg-[var(--oa-accent)] text-[var(--oa-accent-text)] hover:bg-[var(--oa-accent-fg)]`}
            onClick={() => setAsking(true)}
          >
            Restore this version
          </Button>
        )}
        <Button
          size="xs"
          variant="outline"
          className={BAR}
          onClick={() =>
            void navigate({
              to: viewerPath(id) as string,
              search: search as never,
            })
          }
        >
          Back to current
        </Button>
      </div>
      <RestoreDialog
        id={id}
        version={asking ? version : null}
        onClose={() => setAsking(false)}
      />
    </div>
  );
}
