// Transfer a departed person's personal artifacts (hosted P4 Task 13, Design
// D7, 2026-10-22): to a person (they become the owner, shares kept) or to a
// shared space (the company owns them). Counts only, never titles. The run
// repeats R.memberTransfer until nextCursor is null; a failure part-way shows
// inline, and Retry moves only what's left.
import type { Member, TransferInput, TransferResult } from "@oa/shared";
import { displayName } from "@oa/ui";
import { Button, Label } from "@oa/ui/shadcn";
import { useEffect, useId, useRef, useState } from "react";
import { hasFeature } from "../api/contract";
import { errorCopy } from "../api/errorCopy";
import {
  useMembers,
  useRunTransfer,
  useSpaces,
  useTransferSummary,
} from "../api/queries";
import { useMe } from "../auth/useMe";
import { LoadError } from "../layout/LoadError";
import { Modal } from "../layout/Modal";
import { toast } from "../layout/toast";
import { sharedSpaceName } from "../spaces/label";
import { OptionSelect } from "./OptionSelect";
import { errorText, muted } from "./ui";

export const artifacts = (n: number) =>
  `${n} ${n === 1 ? "artifact" : "artifacts"}`;

/** Runs every page; resolves with the number moved. `onProgress(moved, remaining)`. */
export async function runAll(
  run: (i: TransferInput) => Promise<TransferResult>,
  to: TransferInput["to"],
  onProgress: (moved: number, remaining: number) => void,
): Promise<number> {
  let moved = 0;
  let cursor: string | undefined;
  for (;;) {
    const r = await run(cursor ? { to, cursor } : { to });
    moved += r.moved;
    onProgress(moved, r.remaining);
    if (!r.nextCursor) return moved;
    cursor = r.nextCursor;
  }
}

/** A failure part-way: how many moved before it. */
class PartialError extends Error {
  constructor(
    readonly moved: number,
    readonly cause: unknown,
  ) {
    super("partial transfer");
  }
}

export function TransferDialog({
  member,
  onClose,
}: {
  member: Member;
  onClose: () => void;
}) {
  const name = displayName(member);
  const summary = useTransferSummary(member.id);
  const members = useMembers();
  const state = useMe();
  // Without spaces every artifact is personal: only a person can receive them (parity 1).
  const withSpaces =
    state.status === "authed" && hasFeature(state.me, "spaces");
  const spaces = useSpaces({ kind: "shared" }, withSpaces);
  const run = useRunTransfer(member.id);
  const [kind, setKind] = useState<"user" | "space">("user");
  const [userId, setUserId] = useState<string | null>(null);
  const [spaceId, setSpaceId] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; of: number } | null>(
    null,
  );
  const [failed, setFailed] = useState<{
    done: number;
    of: number;
    why: string;
  } | null>(null);
  const radios = useId();
  // Every shared space, not only the first page (a failed page stops here).
  useEffect(() => {
    if (spaces.hasNextPage && !spaces.isFetching && !spaces.isError)
      void spaces.fetchNextPage();
  }, [spaces]);
  /** The first run's totals: a Retry continues them. */
  const first = useRef<{ live: number; of: number; done: number } | null>(null);

  // Fixed once a run starts: the summary refetches as pages move.
  const live = first.current?.live ?? summary.data?.live ?? 0;
  const trash = summary.data?.deleted ?? 0;
  // Active, non-guest, non-restricted members other than them.
  const successors = (members.data ?? []).filter(
    (m) =>
      m.id !== member.id &&
      (m.status ?? "active") === "active" &&
      m.role !== "guest" &&
      !m.restriction,
  );
  const shared = (spaces.data?.pages.flatMap((p) => p.items) ?? []).filter(
    (s) => s.kind === "shared",
  );
  const person = successors.find((m) => m.id === userId);
  const space = shared.find((s) => s.id === spaceId);
  const target =
    kind === "user"
      ? person && {
          to: { kind, userId: person.id } as const,
          label: displayName(person),
        }
      : space && {
          to: { kind, spaceId: space.id } as const,
          label: sharedSpaceName(space.name),
        };
  const busy = progress !== null;

  const start = async () => {
    if (!target) return;
    // Trash moves too: progress counts it. A Retry keeps the first run's totals.
    first.current ??= { live, of: live + trash, done: 0 };
    const t = first.current;
    const before = t.done;
    setFailed(null);
    setProgress({ done: before, of: t.of });
    let done = before;
    try {
      await runAll(
        (i) =>
          run.mutateAsync(i).catch((e: unknown) => {
            throw new PartialError(done, e);
          }),
        target.to,
        (moved) => {
          done = before + moved;
          setProgress({ done, of: t.of });
        },
      );
      toast({
        title: `Moved ${artifacts(t.live)}${t.of > t.live ? ` (and ${t.of - t.live} in trash)` : ""} to ${target.label}.`,
        tone: "success",
      });
      onClose();
    } catch (e) {
      const p = e instanceof PartialError ? e : new PartialError(done, e);
      t.done = p.moved;
      setProgress(null);
      setFailed({ done: p.moved, of: t.of, why: errorCopy(p.cause, "") });
    }
  };

  return (
    <Modal
      onClose={busy ? () => {} : onClose}
      title={`Transfer ${name}'s ${live} personal ${live === 1 ? "artifact" : "artifacts"}`}
      description={
        trash > 0
          ? `Plus ${trash} in trash: ${trash === 1 ? "it moves" : "they move"} too and ${trash === 1 ? "keeps its" : "keep their"} trash timer.`
          : withSpaces
            ? "Their space artifacts stay where they are."
            : undefined
      }
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Later
          </Button>
          <Button disabled={!target || busy} onClick={() => void start()}>
            Transfer {live}
          </Button>
        </>
      }
    >
      <div className="grid gap-[var(--oa-space-3)] text-[length:var(--oa-text-sm)]">
        {withSpaces && (
          <fieldset className="grid gap-[var(--oa-space-2)] border-0 p-0">
            <legend className="sr-only">Transfer to</legend>
            <label className="flex items-center gap-[var(--oa-space-2)]">
              <input
                type="radio"
                name={radios}
                checked={kind === "user"}
                disabled={busy}
                onChange={() => setKind("user")}
              />
              <span>
                To a person{" "}
                <span className={muted}>· they become the owner</span>
              </span>
            </label>
            <label className="flex items-center gap-[var(--oa-space-2)]">
              <input
                type="radio"
                name={radios}
                checked={kind === "space"}
                disabled={busy}
                onChange={() => setKind("space")}
              />
              <span>
                To a space{" "}
                <span className={muted}>· the company owns them</span>
              </span>
            </label>
          </fieldset>
        )}
        {kind === "user" ? (
          <div className="grid gap-[6px]">
            <Label>Give them to</Label>
            {members.isError ? (
              <LoadError
                title="Couldn't load people."
                error={members.error}
                onRetry={() => void members.refetch()}
              />
            ) : (
              <OptionSelect
                label="Give them to"
                value={userId}
                options={successors.map((m) => ({
                  value: m.id,
                  label: displayName(m),
                }))}
                placeholder="Choose a person"
                disabled={busy}
                onChange={setUserId}
              />
            )}
            {person && (
              <p className={muted}>
                You won't see titles or contents. {displayName(person)} gets
                them in their Personal, with {name}'s shares kept.
              </p>
            )}
          </div>
        ) : (
          <div className="grid gap-[6px]">
            <Label>Space</Label>
            {spaces.isError ? (
              <LoadError
                title="Couldn't load spaces."
                error={spaces.error}
                onRetry={() => void spaces.refetch()}
              />
            ) : (
              <OptionSelect
                label="Space"
                value={spaceId}
                options={shared.map((s) => ({
                  value: s.id,
                  label: sharedSpaceName(s.name),
                }))}
                placeholder="Choose a space"
                disabled={busy}
                onChange={setSpaceId}
              />
            )}
            {space && (
              <p className={muted}>
                Everyone with access to {space.name} can open them, by their
                role.
              </p>
            )}
          </div>
        )}
        {progress && (
          <p role="status" className={muted}>
            Transferring… {progress.done} of {progress.of}
            {progress.of > live ? ", including trash." : ""}
          </p>
        )}
        {failed && (
          <div
            role="alert"
            className={`flex flex-wrap items-center gap-[var(--oa-space-2)] ${errorText}`}
          >
            <span>
              {failed.done > 0
                ? `Moved ${failed.done} of ${failed.of}. ${failed.of - failed.done} didn't move.`
                : failed.why || "Couldn't transfer the artifacts. Try again."}
            </span>
            {failed.done > 0 && (
              <Button size="sm" variant="outline" onClick={() => void start()}>
                Retry
              </Button>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
