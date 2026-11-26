import {
  type ArtifactSummary,
  ArtifactSummarySchema,
  R,
  ShareSchema,
  viewerPath,
} from "@oa/shared";
import { Button } from "@oa/ui/shadcn";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { z } from "zod";
import { api } from "../api/client";
import { toast } from "../layout/toast";
import { ConfirmDialog } from "../settings/ConfirmDialog";

const shareList = z.array(ShareSchema);

export function LibraryDeleteDialog({
  artifacts,
  onClose,
  onDeleted,
}: {
  artifacts: ArtifactSummary[];
  onClose: () => void;
  onDeleted: (ids: string[]) => void;
}) {
  const [remaining, setRemaining] = useState(artifacts);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const qc = useQueryClient();
  const impact = useQuery({
    queryKey: ["library-delete-impact", remaining.map((a) => a.id)],
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnMount: "always",
    queryFn: async ({ signal }) => {
      const pages = [];
      for (const { id } of remaining) {
        const [page, shares] = await Promise.all([
          api.get(R.artifact(id), ArtifactSummarySchema, signal),
          api.get(R.shares(id), shareList, signal),
        ]);
        pages.push({ page, emails: shares.map((s) => s.email) });
      }
      return pages;
    },
  });
  const shared = (impact.data ?? []).filter(
    ({ page, emails }) =>
      emails.length ||
      page.visibility !== "private" ||
      page.space?.kind === "shared",
  );
  const people = new Set(
    shared.flatMap((x) => x.emails.map((e) => e.toLowerCase())),
  ).size;
  const publicLinks = shared.filter(
    (x) => x.page.visibility === "public",
  ).length;
  const count = remaining.length;
  async function trash() {
    if (submitting.current || !impact.isSuccess || impact.isFetching) return;
    submitting.current = true;
    setBusy(true);
    const deleted: string[] = [];
    const failed: ArtifactSummary[] = [];
    for (const a of remaining) {
      try {
        await api.send("DELETE", R.artifact(a.id), undefined);
        deleted.push(a.id);
      } catch {
        failed.push(a);
      }
    }
    if (deleted.length) {
      onDeleted(deleted);
      toast({
        title: `${deleted.length} ${deleted.length === 1 ? "artifact" : "artifacts"} moved to Trash.`,
      });
      await Promise.all(
        ["artifacts", "trash", "search"].map((key) =>
          qc.invalidateQueries({ queryKey: [key] }),
        ),
      );
    }
    submitting.current = false;
    setBusy(false);
    if (!failed.length) {
      onClose();
      return;
    }
    setRemaining(failed);
    setError(
      `Couldn’t delete ${failed.map((a) => a.title).join(", ")}. You can try again.`,
    );
  }
  return (
    <ConfirmDialog
      open
      onClose={() => {
        if (!submitting.current) onClose();
      }}
      title={count === 1 ? "Delete 1 artifact?" : `Delete ${count} artifacts?`}
      body={
        <>
          <p>
            {count === 1 ? `“${remaining[0]?.title}” goes` : "They go"} to Trash
            for 30 days. You can restore {count === 1 ? "it" : "them"} from
            there.
          </p>
          {impact.isFetching && <p role="status">Checking who has access…</p>}
          {impact.isError && (
            <div role="alert">
              Couldn’t check who has access.{" "}
              <Button
                size="sm"
                variant="outline"
                onClick={() => void impact.refetch()}
              >
                Retry access check
              </Button>
            </div>
          )}
          {shared.length > 0 && (
            <div className="rounded-md border bg-muted p-3">
              <p>
                {shared.length} {shared.length === 1 ? "is" : "are"} shared.{" "}
                {people > 0 &&
                  `${people} directly shared ${people === 1 ? "recipient loses" : "recipients lose"} access. `}
                {publicLinks > 0 &&
                  `${publicLinks} public ${publicLinks === 1 ? "link stops" : "links stop"} working.`}
              </p>
              <ul className="mt-2 max-h-[30vh] list-disc overflow-y-auto ps-5">
                {shared.map(({ page, emails }) => (
                  <li key={page.id}>
                    <strong>{page.title}</strong>
                    {emails.length > 0 && ` · ${emails.join(", ")}`}
                    {page.space?.kind === "shared" &&
                      ` · Members of ${page.space.name}`}
                    {page.visibility === "team" &&
                      " · Anyone in the team with the link"}
                    {page.visibility === "public" && (
                      <>
                        {" "}
                        · Public link <code>{viewerPath(page.id)}</code>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {error && <p role="alert">{error}</p>}
        </>
      }
      confirm={`Delete ${count}`}
      danger
      pending="Deleting…"
      busy={busy}
      disabled={!impact.isSuccess || impact.isFetching}
      onConfirm={() => void trash()}
    />
  );
}
