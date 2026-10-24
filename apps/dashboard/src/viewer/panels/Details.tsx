import type { ArtifactSummary } from "@oa/shared";
import { displayName, Textarea } from "@oa/ui";
import { Button, Input } from "@oa/ui/shadcn";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { ApiClientError } from "../../api/client";
import {
  useDeleteArtifact,
  usePatchArtifact,
  useVersionInfo,
} from "../../api/queries";
import { useSingleFlight } from "../../api/useSingleFlight";
import { useCan, useHosted } from "../../auth/permissions";
import { toast } from "../../layout/toast";
import { ConfirmDialog } from "../../settings/ConfirmDialog";
import { MoveDialog, useMoveTargets } from "../../spaces/MoveDialog";
import { useOfferUndo } from "../useOfferUndo";

const fmtSize = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1024 * 1024
      ? `${(n / 1024).toFixed(1)} KB`
      : `${(n / 1024 / 1024).toFixed(1)} MB`;
const fail = (e: unknown, fallback: string) =>
  toast({
    title: e instanceof ApiClientError ? e.message : fallback,
    tone: "danger",
  });

export function Details({ artifact }: { artifact: ArtifactSummary }) {
  const { id } = artifact;
  const can = useCan(artifact);
  const { features, personalSpaceId } = useHosted();
  const spaces = features.includes("spaces");
  const targets = useMoveTargets(artifact);
  const [moving, setMoving] = useState(false);
  const info = useVersionInfo(id, artifact.currentVersion).data;
  const patch = usePatchArtifact(id);
  const del = useDeleteArtifact(id);
  const offerUndo = useOfferUndo();
  const saveOnce = useSingleFlight();
  const removeOnce = useSingleFlight();
  const navigate = useNavigate();
  const [title, setTitle] = useState(artifact.title);
  const [desc, setDesc] = useState(artifact.description ?? "");
  const [confirm, setConfirm] = useState(false);
  // Follow the server while a field is untouched (a rename elsewhere, a refetch).
  const synced = useRef({
    title: artifact.title,
    desc: artifact.description ?? "",
  });
  useEffect(() => {
    const next = artifact.description ?? "";
    setTitle((d) => (d === synced.current.title ? artifact.title : d));
    setDesc((d) => (d === synced.current.desc ? next : d));
    synced.current = { title: artifact.title, desc: next };
  }, [artifact.title, artifact.description]);
  const t = title.trim();
  const valid = t.length >= 1 && t.length <= 200 && desc.length <= 2000;
  const dirty = t !== artifact.title || desc !== (artifact.description ?? "");

  const save = () =>
    saveOnce((done) =>
      patch.mutate(
        {
          ...(t !== artifact.title && { title: t }),
          ...(desc !== (artifact.description ?? "") && { description: desc }),
        },
        {
          onError: (e) => {
            setTitle(artifact.title);
            setDesc(artifact.description ?? "");
            fail(e, "Couldn't save");
          },
          onSettled: done,
        },
      ),
    );
  const remove = () =>
    removeOnce((done) =>
      del.mutate(undefined, {
        onSuccess: () => {
          setConfirm(false);
          void navigate({ to: "/" });
          offerUndo(id, artifact.title);
        },
        onError: (e) => {
          setConfirm(false);
          fail(e, "Couldn't delete");
        },
        onSettled: done,
      }),
    );

  return (
    <div className="oa-details">
      {can.edit && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (valid && dirty) save();
          }}
        >
          <div>
            <span id="oa-d-title">Title</span>
            <Input
              aria-labelledby="oa-d-title"
              value={title}
              maxLength={200}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div>
            <span id="oa-d-desc">Description</span>
            <Textarea
              aria-labelledby="oa-d-desc"
              value={desc}
              maxLength={2000}
              onChange={(e) => setDesc(e.target.value)}
            />
          </div>
          <Button
            type="submit"
            variant="default"
            aria-busy={patch.isPending}
            disabled={!valid || !dirty || patch.isPending}
          >
            Save
          </Button>
        </form>
      )}
      <dl className="oa-dl">
        <dt>Format</dt>
        <dd>{artifact.format}</dd>
        <dt>Entry</dt>
        <dd>{info?.entry ?? "…"}</dd>
        <dt>Files</dt>
        <dd>
          <ul>
            {(info?.files ?? []).map((f) => (
              <li key={f.path}>
                {f.path} <span className="oa-muted">{fmtSize(f.size)}</span>
              </li>
            ))}
          </ul>
        </dd>
        <dt>Created</dt>
        <dd>{new Date(artifact.createdAt).toLocaleString()}</dd>
        <dt>{artifact.space?.kind === "shared" ? "Created by" : "Owner"}</dt>
        <dd>{displayName(artifact.owner)}</dd>
        {spaces && artifact.space && (
          <>
            <dt>Space</dt>
            <dd>
              {artifact.space.kind === "shared"
                ? artifact.space.name
                : artifact.space.id === personalSpaceId
                  ? "Personal"
                  : `${displayName(artifact.owner)}'s personal space`}
            </dd>
          </>
        )}
      </dl>
      {spaces && can.move && targets.length > 0 && (
        <Button variant="outline" onClick={() => setMoving(true)}>
          Move
        </Button>
      )}
      {/* Outside the gate: a finished move can leave no targets. */}
      {moving && (
        <MoveDialog artifact={artifact} onClose={() => setMoving(false)} />
      )}
      {can.delete && (
        <>
          <Button variant="destructive" onClick={() => setConfirm(true)}>
            Delete artifact
          </Button>
          <ConfirmDialog
            open={confirm}
            onClose={() => setConfirm(false)}
            title="Delete artifact?"
            body={<p>"{artifact.title}" will be recoverable for 30 days.</p>}
            confirm="Delete"
            danger
            pending="Deleting…"
            busy={del.isPending}
            onConfirm={remove}
          />
        </>
      )}
    </div>
  );
}
