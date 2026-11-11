import { type ArtifactSummary, viewerPath } from "@oa/shared";
import { Button } from "@oa/ui/shadcn";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { ApiClientError } from "../api/client";
import { useRestoreVersion } from "../api/queries";
import { useSingleFlight } from "../api/useSingleFlight";
import { useCan } from "../auth/permissions";
import { toast } from "../layout/toast";
import { ConfirmDialog } from "../settings/ConfirmDialog";
import { BAR } from "./ui";

/**
 * #2118: one amber strip under the title bar while an older version is open:
 * what you are looking at, Restore it (if you can edit) and Back to current.
 */
export function OlderBanner({
  artifact,
  version,
}: {
  artifact: ArtifactSummary;
  version: number;
}) {
  const { id } = artifact;
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const canRestore = useCan(artifact).edit;
  const restore = useRestoreVersion(id);
  const once = useSingleFlight();
  const [asking, setAsking] = useState(false);
  return (
    <div
      data-older-banner=""
      role="status"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 border-0 border-b border-border bg-[var(--oa-warning-soft)] px-5 py-2 text-[length:var(--oa-text-md)] leading-[1.45] text-foreground max-[600px]:px-4"
    >
      <span className="min-w-0 flex-1 max-[600px]:basis-full">
        You're viewing <b>v{version}</b>, an older version of this page.
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
      <ConfirmDialog
        open={asking}
        onClose={() => setAsking(false)}
        title={`Restore v${version}?`}
        body={
          <p>
            This publishes a new version with the contents of the selected one.
          </p>
        }
        confirm="Restore version"
        pending="Restoring…"
        busy={restore.isPending}
        onConfirm={() =>
          once((done) =>
            restore.mutate(version, {
              onSuccess: (r) => {
                setAsking(false);
                void navigate({
                  to: viewerPath(id, r.version) as string,
                  search: search as never,
                });
              },
              onError: (e) =>
                toast({
                  title:
                    e instanceof ApiClientError
                      ? e.message
                      : "Couldn't restore",
                  tone: "danger",
                }),
              onSettled: done,
            }),
          )
        }
      />
    </div>
  );
}
