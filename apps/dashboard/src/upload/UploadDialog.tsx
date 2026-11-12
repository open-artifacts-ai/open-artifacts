import {
  ArtifactSummarySchema,
  normalizePath,
  R,
  viewerPath,
} from "@oa/shared";
import { Button, Input, Textarea } from "@oa/ui/shadcn";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { ApiClientError, api } from "../api/client";
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
  // The title at the last unanswered create; while it matches, the button says "Try again".
  const [retryTitle, setRetryTitle] = useState<string | null>(null);
  // A create was sent; it may have landed without us hearing.
  const createSent = useRef(false);
  const submitButton = useRef<HTMLButtonElement>(null);
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

  // After a failed create, the button that retries takes focus.
  useEffect(() => {
    if (retryTitle !== null) submitButton.current?.focus();
  }, [retryTitle]);

  const cancel = () => {
    abort.current?.abort();
    onClose();
  };

  const finish = async (r: { id: string; version: number }) => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["artifacts"] }),
      qc.invalidateQueries({ queryKey: ["search"] }),
      qc.invalidateQueries({ queryKey: qk.artifact(r.id) }),
    ]);
    if (!alive.current) return;
    toast({ title: "Artifact created" });
    onClose();
    void navigate({ to: viewerPath(r.id, r.version) as never });
  };

  /** The artifact a lost create may have made: it, null when the server says there is none (404), undefined when we could not tell. */
  const landed = async (id: string | undefined, outer: AbortSignal) => {
    if (!id) return null;
    const look = new AbortController();
    const relay = () => look.abort();
    outer.addEventListener("abort", relay, { once: true });
    const t = setTimeout(relay, CREATE_TIMEOUT_MS);
    try {
      const a = await api.get(
        R.artifact(id),
        ArtifactSummarySchema,
        look.signal,
      );
      return { id: a.id, version: a.currentVersion };
    } catch (e) {
      return e instanceof ApiClientError && e.status === 404 ? null : undefined;
    } finally {
      clearTimeout(t);
      outer.removeEventListener("abort", relay);
    }
  };

  const submit = async () => {
    setError(null);
    setRetryTitle(null);
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
      if (createSent.current) {
        const done = await landed(uploaded.current.reserved, signal);
        if (done) return await finish(done);
      }
      // The entry can change after the first upload: the latest choice wins.
      const given = entry === undefined ? undefined : normalizePath(entry);
      const current = {
        ...uploaded.current,
        entry: given?.ok ? given.path : uploaded.current.entry,
      };
      const create = new AbortController();
      const relay = () => create.abort();
      signal.addEventListener("abort", relay, { once: true });
      timer = setTimeout(() => {
        timedOut = true;
        create.abort();
      }, CREATE_TIMEOUT_MS);
      createSent.current = true;
      let r: Awaited<ReturnType<typeof createArtifact>>;
      try {
        r = await createArtifact(input, current, create.signal);
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", relay);
      }
      await finish(r);
    } catch (e) {
      const aborted = (e as { name?: string }).name === "AbortError";
      if (aborted && !timedOut) return;
      if (!alive.current) return;
      setProgress(null);
      const down =
        timedOut ||
        (uploaded.current !== null &&
          e instanceof ApiClientError &&
          (e.status === 0 ||
            e.status === 502 ||
            e.status === 503 ||
            e.status === 504));
      let lookupFailed = false;
      const deadUpload =
        e instanceof ApiClientError &&
        e.code === "bad_request" &&
        (e.details as { reason?: string } | undefined)?.reason ===
          "invalid_upload";
      if (
        createSent.current &&
        e instanceof ApiClientError &&
        (e.code === "conflict" || deadUpload)
      ) {
        const done = await landed(uploaded.current?.reserved, signal);
        if (done && alive.current) return await finish(done);
        // Only a 404 proves nothing landed; an unanswered lookup keeps the state.
        if (deadUpload && done === null) {
          // Its upload ids are spent: the next click uploads again.
          uploaded.current = null;
          createSent.current = false;
        }
        if (deadUpload && done === undefined) lookupFailed = true;
      }
      if (!alive.current) return;
      if (down || lookupFailed) {
        setRetryTitle(title);
        setError(
          `Couldn't create the artifact: the server didn't answer. Your ${files.length === 1 ? "file is" : "files are"} still here.`,
        );
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
            ref={submitButton}
            variant="default"
            disabled={busy || invalid}
            onClick={() => void submit()}
          >
            {busy
              ? "Creating…"
              : retryTitle !== null && title === retryTitle
                ? "Try again"
                : "Create"}
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
          </p>
        )}
      </form>
    </Modal>
  );
}
