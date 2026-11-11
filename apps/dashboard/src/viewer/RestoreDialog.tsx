import { viewerPath } from "@oa/shared";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { ApiClientError } from "../api/client";
import { useRestoreVersion } from "../api/queries";
import { useSingleFlight } from "../api/useSingleFlight";
import { toast } from "../layout/toast";
import { ConfirmDialog } from "../settings/ConfirmDialog";

/**
 * Restore one version: a confirm, then a new version with its contents, then
 * the viewer moves to it. Shared by the Versions panel and the older-version
 * banner. `version` null keeps it closed.
 */
export function RestoreDialog({
  id,
  version,
  onClose,
}: {
  id: string;
  version: number | null;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const restore = useRestoreVersion(id);
  const once = useSingleFlight();
  return (
    <ConfirmDialog
      open={version !== null}
      onClose={onClose}
      title={`Restore v${version ?? ""}?`}
      body={
        <p>
          This publishes a new version with the contents of the selected one.
        </p>
      }
      confirm="Restore version"
      pending="Restoring…"
      busy={restore.isPending}
      onConfirm={() =>
        version !== null &&
        once((done) =>
          restore.mutate(version, {
            onSuccess: (r) => {
              onClose();
              void navigate({
                to: viewerPath(id, r.version) as string,
                search: search as never,
              });
            },
            onError: (e) =>
              toast({
                title:
                  e instanceof ApiClientError ? e.message : "Couldn't restore",
                tone: "danger",
              }),
            onSettled: done,
          }),
        )
      }
    />
  );
}
