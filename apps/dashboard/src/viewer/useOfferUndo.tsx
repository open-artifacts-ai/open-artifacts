import { ArtifactSummarySchema, R, viewerPath } from "@oa/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ApiClientError, api } from "../api/client";
import { qk } from "../api/queries";
import { toast } from "../layout/toast";
import { DeletedNote } from "../trash/DeletedNote";

/** Returns a function that toasts an Undo for a just-deleted artifact. */
export function useOfferUndo() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  return (artifactId: string) =>
    toast({
      title: <DeletedNote />,
      action: {
        label: "Undo",
        onClick: () => {
          void (async () => {
            try {
              await api.send(
                "POST",
                R.restoreDeleted(artifactId),
                undefined,
                ArtifactSummarySchema,
              );
              await Promise.all([
                qc.invalidateQueries({ queryKey: ["artifacts"] }),
                qc.invalidateQueries({ queryKey: qk.artifact(artifactId) }),
              ]);
              void navigate({ to: viewerPath(artifactId) as string });
            } catch (e) {
              toast({
                title:
                  e instanceof ApiClientError
                    ? e.message
                    : "Couldn't undo the delete",
                tone: "danger",
              });
            }
          })();
        },
      },
    });
}
