import { viewerPath } from "@oa/shared";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { ApiClientError } from "../../api/client";
import { useDocRestore } from "../../api/queries";
import { useSingleFlight } from "../../api/useSingleFlight";
import { toast } from "../../layout/toast";
import { restoredToast } from "./versions";

/** Docs just restored: their Versions list starts with no hover tint (#1100). */
const restored = new Set<string>();
/** True once for a doc just restored; the next call says false. */
export const takeRestored = (id: string) => restored.delete(id);

/**
 * Restore a doc version (#1100) through its room (R.docRestore, #2140):
 * no confirm (the mockup's flow; nothing is lost), then the mockup's toast,
 * then back to the live doc, where the room applied it for everyone. Used by
 * the Versions panel and the older-version banner.
 */
export function useRestoreDoc(id: string) {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const restore = useDocRestore(id);
  const once = useSingleFlight();
  const run = (v: number) =>
    once((done) =>
      // mutateAsync: the caller remounts as the new version lands, which
      // would drop mutate()'s own callbacks.
      restore
        .mutateAsync(v)
        .then((r) => {
          // The pointer still rests where Restore was, now over an older row.
          restored.add(id);
          toast({ title: restoredToast(v, r.version), tone: "neutral" });
          void navigate({
            to: viewerPath(id) as string,
            search: search as never,
          });
        })
        .catch((e: unknown) =>
          toast({
            title: e instanceof ApiClientError ? e.message : "Couldn't restore",
            tone: "danger",
          }),
        )
        .finally(done),
    );
  return { run, pending: restore.isPending };
}
