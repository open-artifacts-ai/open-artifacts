// Erase a removed person (#1222, server #1221): what's left of their account
// goes for good. A typed word confirms it; while they still own artifacts the
// server refuses (409 member_owns_artifacts) and the dialog offers Transfer.
import { type Member, MemberOwnsArtifactsDetailsSchema } from "@oa/shared";
import { Button, Input, Label } from "@oa/ui/shadcn";
import { useId, useState } from "react";
import { ApiClientError } from "../api/client";
import { errorCopy } from "../api/errorCopy";
import { useEraseMember } from "../api/queries";
import { Modal } from "../layout/Modal";
import {
  personFirst,
  personFirstAtStart,
  personInSentence,
} from "../layout/person";
import { toast } from "../layout/toast";
import { artifacts } from "./Transfer";
import { errorText, muted } from "./ui";

const WORD = "erase";

/** movedCount's form: "2 artifacts (and 1 in trash)", or "1 artifact in trash". */
export const ownedCount = (live: number, deleted: number) =>
  live === 0
    ? `${artifacts(deleted)} in trash`
    : deleted > 0
      ? `${artifacts(live)} (and ${deleted} in trash)`
      : artifacts(live);

export function EraseDialog({
  member: m,
  onClose,
  onTransfer,
}: {
  member: Member;
  onClose: () => void;
  /** Opens the Transfer dialog for them (the owns-artifacts state). */
  onTransfer: () => void;
}) {
  const erase = useEraseMember();
  const id = useId();
  const [typed, setTyped] = useState("");
  const [owns, setOwns] = useState<{ live: number; deleted: number } | null>(
    null,
  );
  const [problem, setProblem] = useState<string | null>(null);
  // Taken now: after the call the name is gone.
  const first = personFirst(m);
  const matches = typed.trim().toLowerCase() === WORD;
  const go = () => {
    if (!matches || erase.isPending) return;
    setProblem(null);
    erase
      .mutateAsync(m.id)
      .then(() => {
        toast({ title: `Erased ${first}'s account.`, tone: "success" });
        onClose();
      })
      .catch((e: unknown) => {
        const d =
          e instanceof ApiClientError && e.code === "member_owns_artifacts"
            ? MemberOwnsArtifactsDetailsSchema.safeParse(e.details)
            : null;
        if (d?.success) return setOwns(d.data);
        setProblem(errorCopy(e, `Couldn't erase ${first}. Try again.`));
      });
  };
  return (
    <Modal
      onClose={onClose}
      title={`Erase ${personInSentence(m)}?`}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          {owns ? (
            <Button onClick={onTransfer}>Transfer…</Button>
          ) : (
            <Button
              variant="destructive"
              disabled={!matches || erase.isPending}
              aria-busy={erase.isPending || undefined}
              onClick={go}
            >
              Erase
            </Button>
          )}
        </>
      }
    >
      {owns ? (
        <p className="m-0">
          {personFirstAtStart(m)} still owns{" "}
          {ownedCount(owns.live, owns.deleted)}. Transfer them first, then
          erase.
        </p>
      ) : (
        <form
          className="grid gap-[var(--oa-space-3)] text-[length:var(--oa-text-sm)]"
          onSubmit={(e) => {
            e.preventDefault();
            go();
          }}
        >
          <p className="m-0">
            This deletes what's left of {first}'s account: their name and email,
            sign-ins, agent connections and tokens, the shares they received,
            and their space roles. It can't be undone, and they can't be
            restored afterwards.
          </p>
          <p className="m-0">
            What stays: work they published, shown as from a former member;
            shares they created; and the audit log.
          </p>
          <p className={`m-0 ${muted}`}>
            They can still come back as a new, empty account if your sign-in
            rules let them in. A Google account they used stays blocked until an
            admin resets its link.
          </p>
          <div className="grid gap-[6px]">
            <Label htmlFor={id}>Type "erase" to confirm</Label>
            <Input
              id={id}
              value={typed}
              autoComplete="off"
              onChange={(e) => setTyped(e.target.value)}
            />
          </div>
          {problem && (
            <p role="alert" className={`m-0 ${errorText}`}>
              {problem}
            </p>
          )}
        </form>
      )}
    </Modal>
  );
}
