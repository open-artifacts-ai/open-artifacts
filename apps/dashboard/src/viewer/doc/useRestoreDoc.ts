import { viewerPath } from "@oa/shared";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { ApiClientError } from "../../api/client";
import { useDocRestore } from "../../api/queries";
import { useSingleFlight } from "../../api/useSingleFlight";
import { toast } from "../../layout/toast";
import { restoredToast } from "./versions";

/**
 * Restore a doc version (#1100) through its room (PROVISIONAL route, #2496):
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
