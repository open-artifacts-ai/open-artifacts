// Move an artifact to another shared space (Design D3/D4, 2026-10-22): a list
// of the spaces you can publish to, with your role; never Personal (a space
// artifact can't go back) and never the current space. Moving out of Personal
// is one-way; a public artifact moved into a space with public links off asks
// first, and the server makes it Team in the same step.
import type { ArtifactSummary, MySpace } from "@oa/shared";
import { Button } from "@oa/ui/shadcn";
import { useState } from "react";
import { errorCopy } from "../api/errorCopy";
import { useMoveArtifact, useSpaces } from "../api/queries";
import { canPublishTo, useHosted } from "../auth/permissions";
import { useMe } from "../auth/useMe";
import { ConflictNote, isConflict } from "../layout/ConflictNote";
import { Modal } from "../layout/Modal";
import { toast } from "../layout/toast";
import { ConfirmDialog } from "../settings/ConfirmDialog";
import { sharedSpaceName } from "./label";

const ROLE = {
  viewer: "Viewer",
  editor: "Editor",
  manager: "Manager",
} as const;

/** Where `a` may move: shared spaces you can publish to, other than its own. */
export const useMoveTargets = (a: ArtifactSummary): MySpace[] => {
  const { spaces, cap } = useHosted();
  return spaces
    .filter(
      (s) =>
        s.kind === "shared" && s.id !== a.space?.id && canPublishTo(s, cap),
    )
    .sort((x, y) => x.name.localeCompare(y.name));
};

export function MoveDialog({
  artifact: a,
  onClose,
}: {
  artifact: ArtifactSummary;
  onClose: () => void;
}) {
  const targets = useMoveTargets(a);
  const move = useMoveArtifact(a.id, true);
  const shared = useSpaces({ kind: "shared" });
  const me = useMe();
  const install = me.status === "authed" ? me.me.instance.name : "";
  const [to, setTo] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const target = targets.find((s) => s.id === to) ?? null;
  const fromPersonal = a.space?.kind !== "shared";
  const count = shared.data?.pages
    .flatMap((p) => p.items)
    .find((s) => s.id === to)?.memberCount;

  const impact = !target
    ? null
    : fromPersonal
      ? count !== undefined
        ? `${target.name}'s ${count} ${count === 1 ? "member gets" : "members get"} access by their role. You can't move it back to Personal.`
        : `People in ${target.name} get access by their role. You can't move it back to Personal.`
      : `${target.name} members get access. People only in ${a.space?.name} lose it.`;

  const run = () => {
    if (!target) return;
    // mutateAsync, not mutate's callbacks: the refetch after a move can
    // unmount this dialog before they would run.
    move
      .mutateAsync(target.id)
      .then(() => {
        toast({ title: `Moved to ${target.name}.`, tone: "success" });
        onClose();
      })
      .catch(() => {}); // shown inline from move.error
  };
  const submit = () => {
    if (!target) return;
    // Public into a public-off space: the link stops working; ask first.
    if (a.visibility === "public" && !target.publicLinks) setAsking(true);
    else run();
  };

  return (
    <>
      <Modal
        open={!asking}
        onClose={onClose}
        title={`Move "${a.title}" to`}
        footer={
          <>
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              disabled={!target || move.isPending}
              aria-busy={move.isPending}
              onClick={submit}
            >
              {move.isPending ? "Moving…" : "Move"}
            </Button>
          </>
        }
      >
        <div className="grid gap-[var(--oa-space-3)]">
          <fieldset className="grid gap-[2px] border-0 p-0">
            <legend className="sr-only">Space</legend>
            {targets.map((s) => (
              <label
                key={s.id}
                className="flex cursor-pointer items-center gap-[var(--oa-space-2)] rounded-md px-[var(--oa-space-2)] py-[var(--oa-space-2)] hover:bg-[var(--oa-surface-2)] has-[:checked]:bg-[var(--oa-surface-2)]"
              >
                <input
                  type="radio"
                  name="oa-move-to"
                  value={s.id}
                  checked={to === s.id}
                  onChange={() => {
                    setTo(s.id);
                    move.reset();
                  }}
                />
                <span className="flex-1 font-medium">
                  {sharedSpaceName(s.name)}
                </span>
                <span className="text-[length:var(--oa-text-xs)] text-muted-foreground">
                  {ROLE[s.myRole]}
                </span>
              </label>
            ))}
          </fieldset>
          {impact && (
            <p className="m-0 text-[length:var(--oa-text-sm)] text-muted-foreground">
              {impact}
            </p>
          )}
          {isConflict(move.error) && <ConflictNote />}
          {move.error && !isConflict(move.error) && (
            <p
              role="alert"
              className="m-0 text-[length:var(--oa-text-sm)] text-destructive"
            >
              {errorCopy(move.error, "Couldn't move the artifact. Try again.")}
            </p>
          )}
        </div>
      </Modal>
      {target && (
        <ConfirmDialog
          open={asking}
          onClose={() => setAsking(false)}
          title={`Move "${a.title}" to ${target.name}?`}
          body={
            <p>
              Public links are off in {target.name}, so this link stops working
              and the artifact becomes visible to everyone at {install}.
            </p>
          }
          confirm="Move and turn off link"
          onConfirm={run}
        />
      )}
    </>
  );
}
