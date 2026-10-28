import {
  Button,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@oa/ui/shadcn";
import { useCallback, useEffect, useRef, useState } from "react";
import { filesFromDrop, filterIgnored } from "./collect";
import { KINDS_LINE } from "./openable";
import { UploadDialog } from "./UploadDialog";
import "./upload.css";
import { toast } from "../layout/toast";

const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes("Files");

const UploadIcon = () => (
  <svg
    viewBox="0 0 16 16"
    width="22"
    height="22"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M8 11V2.5M4.5 6 8 2.5 11.5 6M2.5 10v3.5h11V10" />
  </svg>
);

/**
 * Window-level drop target plus a picker button; uploads create a new artifact. New
 * versions come only from agents. Takes `allowed` rather than calling useMe: a second
 * observer on a failed /me query would refetch it.
 */
export function DropZone({
  allowed,
  button = false,
  spaceId,
}: {
  /** Whether this user may publish here (signed in, not a guest, not capped). */
  allowed: boolean;
  button?: boolean;
  /** Hosted: the space the upload dialog starts on. */
  spaceId?: string;
}) {
  const enabled = allowed;
  const [dragging, setDragging] = useState(false);
  const [batch, setBatch] = useState<{ n: number; files: File[] } | null>(null);
  const busy = useRef(false);
  busy.current = batch !== null;
  const nextBatch = useRef(0);
  const start = useCallback((f: File[]) => {
    if (f.length === 0) return toast({ title: "No files to upload" });
    setBatch({ n: nextBatch.current++, files: f });
  }, []);
  const filePicker = useRef<HTMLInputElement>(null);
  const folderPicker = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!enabled) return;
    let depth = 0; // dragenter/leave fire per child element, so count them
    const root = document.documentElement;
    let stuck: ReturnType<typeof setTimeout> | undefined;
    const reset = () => {
      clearTimeout(stuck);
      depth = 0;
      setDragging(false);
      root.classList.remove("oa-file-drag");
    };
    // dragover fires continuously during a drag; silence means the drag ended unseen.
    const arm = () => {
      clearTimeout(stuck);
      stuck = setTimeout(reset, 400);
    };
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      arm();
      setDragging(true);
      root.classList.add("oa-file-drag");
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      if (--depth <= 0) reset();
    };
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (depth > 0) arm();
    };
    // Pointer events never fire mid-drag, so one means the overlay is stale.
    const stale = () => depth > 0 && reset();
    const drop = (e: DragEvent) => {
      if (!hasFiles(e) || !e.dataTransfer) return;
      e.preventDefault();
      reset();
      if (busy.current)
        return toast({ title: "Finish the current upload first" });
      void filesFromDrop(e.dataTransfer).then(start);
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && reset();
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    window.addEventListener("keydown", key);
    window.addEventListener("pointerdown", stale);
    window.addEventListener("mousemove", stale);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
      window.removeEventListener("keydown", key);
      window.removeEventListener("pointerdown", stale);
      window.removeEventListener("mousemove", stale);
      reset();
    };
  }, [enabled, start]);

  if (!enabled) return null;
  const picked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = filterIgnored([...(e.target.files ?? [])]);
    e.target.value = "";
    start(f);
  };
  return (
    <>
      {button && (
        <span className="up-buttons">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  onClick={() => filePicker.current?.click()}
                >
                  Upload files
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" collisionPadding={8}>
                {KINDS_LINE}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <Button variant="ghost" onClick={() => folderPicker.current?.click()}>
            Upload folder
          </Button>
          <input
            ref={filePicker}
            type="file"
            multiple
            hidden
            data-testid="upload-files"
            onChange={picked}
          />
          <input
            ref={folderPicker}
            type="file"
            hidden
            data-testid="upload-folder"
            // @ts-expect-error non-standard attribute, supported by all current browsers
            webkitdirectory=""
            onChange={picked}
          />
        </span>
      )}
      {dragging && (
        <div className="up-drop" role="presentation">
          <div className="up-zone">
            <div className="up-icon">
              <UploadIcon />
            </div>
            <h2>Drop files to create an artifact</h2>
            <p>
              One file makes one artifact; several files dropped together make
              one multi-file artifact.
            </p>
            <p className="up-kinds">{KINDS_LINE}</p>
            <div className="up-foot">
              Up to 25 MB per file and 100 MB per drop · Visibility starts as
              Private
            </div>
          </div>
        </div>
      )}
      {batch && (
        <UploadDialog
          key={batch.n}
          files={batch.files}
          onClose={() => setBatch(null)}
          spaceId={spaceId}
        />
      )}
    </>
  );
}
