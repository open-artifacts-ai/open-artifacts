import { normalizePath, viewerPath } from "@oa/shared";
import { Button, Input, Textarea } from "@oa/ui/shadcn";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { ApiClientError } from "../api/client";
import { errorCopy } from "../api/errorCopy";
import { qk } from "../api/queries";
import { useHosted } from "../auth/permissions";
import { SpacePicker } from "../spaces/SpacePicker";
import "./upload.css";
import { Modal } from "../layout/Modal";
import { toast } from "../layout/toast";
import { OptionSelect } from "../settings/OptionSelect";
import {
  commonFolder,
  createArtifact,
  defaultEntry,
  type Progress,
  relativePaths,
  type Uploaded,
  UploadValidationError,
  uploadFiles,
} from "./uploadPipeline";

/** How long the create call may take before the dialog gives up on it. */
export const CREATE_TIMEOUT_MS = 30_000;

const stem = (p: string) => (p.split("/").pop() ?? p).replace(/\.[^.]*$/, "");

export function UploadDialog({
  files,
  onClose,
  spaceId: initialSpace,
}: {
  files: File[];
  onClose: () => void;
  /** Hosted: the space to preselect (the open one, if you can publish there). */
  spaceId?: string;
}) {
  const { features, personalSpaceId } = useHosted();
  const spaces = features.includes("spaces");
  const [space, setSpace] = useState<string | undefined>(initialSpace);
  // NFC, as the server and the pipeline see them.
  const paths = relativePaths(files).map((p) => {
    const r = normalizePath(p);
    return r.ok ? r.path : p;
  });
  const auto = defaultEntry(paths);
  const [title, setTitle] = useState(
    commonFolder(files) ?? stem(auto ?? paths[0] ?? ""),
  );
  const [message, setMessage] = useState("");
  const [entry, setEntry] = useState<string | undefined>(auto);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  // Kept after a finished upload so Retry repeats only the create call.
  const uploaded = useRef<Uploaded | null>(null);
  const [retryable, setRetryable] = useState(false);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const busy = progress !== null;
  const needsEntry = auto === undefined;
  const invalid = !title.trim() || (needsEntry && !entry);

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      abort.current?.abort();
    };
  }, []);

  const cancel = () => {
    abort.current?.abort();
    onClose();
  };

  const submit = async () => {
    setError(null);
    setRetryable(false);
    abort.current = new AbortController();
    const signal = abort.current.signal;
    const input = {
      files,
      title,
      message,
      entry,
      // Personal is the server's default: only a shared space is sent.
      ...(spaces && space && space !== personalSpaceId
        ? { spaceId: space }
        : {}),
    };
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      uploaded.current ??= await uploadFiles(input, setProgress, signal);
      const n = Object.keys(uploaded.current.files).length;
      setProgress({ done: n, total: n });
      const create = new AbortController();
      const relay = () => create.abort();
      signal.addEventListener("abort", relay, { once: true });
      timer = setTimeout(() => {
        timedOut = true;
        create.abort();
      }, CREATE_TIMEOUT_MS);
      let r: Awaited<ReturnType<typeof createArtifact>>;
      try {
        r = await createArtifact(input, uploaded.current, create.signal);
      } finally {
        signal.removeEventListener("abort", relay);
      }
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["artifacts"] }),
        qc.invalidateQueries({ queryKey: ["search"] }),
        qc.invalidateQueries({ queryKey: qk.artifact(r.id) }),
      ]);
      if (!alive.current) return;
      toast({ title: "Artifact created" });
      onClose();
      void navigate({ to: viewerPath(r.id, r.version) as never });
    } catch (e) {
      const aborted = (e as { name?: string }).name === "AbortError";
      if (aborted && !timedOut) return;
      if (!alive.current) return;
      setProgress(null);
      const down =
        timedOut ||
        (uploaded.current !== null &&
          e instanceof ApiClientError &&
          (e.status === 0 || e.status === 503));
      if (down) {
        setRetryable(true);
        setError("Couldn't create it. The server didn't answer.");
        return;
      }
      setError(
        e instanceof ApiClientError
          ? errorCopy(e, e.message)
          : e instanceof UploadValidationError
            ? e.message
            : "Upload failed. Try again.",
      );
    } finally {
      clearTimeout(timer);
    }
  };

  return (
    <Modal
      open
      onClose={cancel}
      title="Create artifact"
      description={`${files.length} file${files.length === 1 ? "" : "s"} selected`}
      footer={
        <>
          <Button variant="outline" onClick={cancel}>
            Cancel
          </Button>
          <Button
            variant="default"
            disabled={busy || invalid}
            onClick={() => void submit()}
          >
            {busy ? "Creating…" : "Create"}
          </Button>
        </>
      }
    >
      <form
        className="up-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy && !invalid) void submit();
        }}
      >
        {spaces && <SpacePicker value={space} onChange={setSpace} />}
        <div>
          <label htmlFor="up-title">Title</label>
          <Input
            id="up-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
            required
            disabled={busy}
          />
        </div>
        {needsEntry && (
          <div>
            <span className="up-entry-label" aria-hidden="true">
              Entry file
            </span>
            <OptionSelect
              label="Entry file"
              options={paths.map((p) => ({ value: p, label: p }))}
              value={entry ?? null}
              onChange={setEntry}
              placeholder="Choose the file to open first"
              disabled={busy}
            />
          </div>
        )}
        <div>
          <label htmlFor="up-message">Message (optional)</label>
          <Textarea
            id="up-message"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            maxLength={500}
            rows={2}
            disabled={busy}
          />
        </div>
        {progress && (
          <p role="status" className="up-progress">
            Uploaded {progress.done} of {progress.total}
          </p>
        )}
        {error && (
          <p role="alert" className="up-error">
            {error}
            {retryable && (
              <>
                {" "}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void submit()}
                >
                  Retry
                </Button>
              </>
            )}
          </p>
        )}
      </form>
    </Modal>
  );
}
