// #2508 slice A2: attaching pictures in the comment box (button, paste or
// drop), up to 4, shrunk and stripped in the browser, with 56px thumbnails,
// remove, progress and errors. Words are OA Product's and OA Design's
// (screens v7, tab 1 and "Attaching"), word for word.
import { TriangleAlert, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  PICTURE_BYTES_MAX,
  PICTURES_MAX,
  type PictureRef,
  putBytes,
  requestUpload,
} from "../../../api/commentPictures";
import { TXT } from "../../ui";
import { isHeic, isPictureType, sha256, shrink } from "./shrink";

export const PICTURE_WORDS = {
  add: "Add a picture",
  drop: "Drop to attach",
  uploading: (i: number, n: number) => `Uploading ${i} of ${n}…`,
  didntUpload: "Didn't upload",
  /** OA Product: "Try again" is the button inside it. */
  failed: (n: number) =>
    n === 1
      ? (["1 picture didn't upload. ", ", or remove it to send."] as const)
      : ([
          `${n} pictures didn't upload. `,
          ", or remove them to send.",
        ] as const),
  tryAgain: "Try again",
  notPicture: "Only pictures can go in a comment: PNG, JPEG, GIF or WebP.",
  tooBig: (name: string, mb: number) =>
    `"${name}" is ${mb} MB. The limit is 10 MB a picture.`,
  tooMany: "4 pictures is the most one comment holds. The fifth wasn't added.",
  heic: "iPhone photos saved as HEIC can't be attached yet. Send a screenshot, or save it as JPEG.",
  needWords: "Say what you want done; the picture alone isn't a request",
  gone: "This picture is no longer available.",
  openOriginal: "Open original",
  close: "Close",
  /** PLACEHOLDER (#2508, for OA Product): names for controls with no words in the design. */
  remove: (name?: string) =>
    name ? `Remove picture ${name}` : "Remove picture",
  open: (i: number, n: number) => `Picture ${i} of ${n}`,
  previous: "Previous picture",
  next: "Next picture",
} as const;

export type Attached = {
  key: string;
  name: string;
  preview: string;
  status: "uploading" | "done" | "failed";
  progress: number;
  pictureId?: string;
  blob?: Blob;
  w?: number;
  h?: number;
};

let seq = 0;
const megabytes = (b: number) => Math.round(b / (1024 * 1024));

/** The comment box's pictures: what is attached, and the notes to show. */
export function usePictureDrawer(artifactId: string) {
  const [items, setItems] = useState<Attached[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const live = useRef(new Map<string, AbortController>());
  const count = useRef(0);
  count.current = items.length;
  useEffect(
    () => () => {
      for (const c of live.current.values()) c.abort();
    },
    [],
  );
  const patch = useCallback(
    (key: string, p: Partial<Attached>) =>
      setItems((xs) => xs.map((x) => (x.key === key ? { ...x, ...p } : x))),
    [],
  );

  /** Takes a picture back out and says why. */
  const refuse = useCallback((key: string, note: string) => {
    setItems((xs) => {
      const gone = xs.find((x) => x.key === key);
      if (gone) URL.revokeObjectURL(gone.preview);
      return xs.filter((x) => x.key !== key);
    });
    setNotes((n) => (n.includes(note) ? n : [...n, note]));
  }, []);

  const upload = useCallback(
    async (key: string, blob: Blob, name = "Picture") => {
      const ctl = new AbortController();
      live.current.set(key, ctl);
      patch(key, { status: "uploading", progress: 0 });
      try {
        // The server reads w and h from the file itself.
        const meta = {
          type: blob.type,
          bytes: blob.size,
          sha256: await sha256(blob),
        };
        const up = await requestUpload(artifactId, meta);
        await putBytes(
          up.url,
          blob,
          (p) => patch(key, { progress: p }),
          ctl.signal,
        );
        patch(key, { status: "done", progress: 1, pictureId: up.pictureId });
      } catch (e) {
        if ((e as { name?: string }).name === "AbortError") return;
        // too_large (10 MB, or "dimensions"): the same words as the size check.
        const err = e as {
          code?: string;
          details?: { reason?: string };
          reason?: string;
        };
        if (err.code === "too_large") {
          refuse(key, PICTURE_WORDS.tooBig(name, megabytes(blob.size)));
          return;
        }
        // The server's own refusal of a kind (HEIC, or not a picture).
        if (err.code === "unsupported_format") {
          const heic = (err.reason ?? err.details?.reason) === "heic";
          refuse(key, heic ? PICTURE_WORDS.heic : PICTURE_WORDS.notPicture);
          return;
        }
        patch(key, { status: "failed" });
      } finally {
        live.current.delete(key);
      }
    },
    [artifactId, patch, refuse],
  );

  const add = useCallback(
    async (files: Iterable<File>) => {
      const next: string[] = [];
      let room = PICTURES_MAX - count.current;
      for (const f of files) {
        if (isHeic(f)) {
          if (!next.includes(PICTURE_WORDS.heic)) next.push(PICTURE_WORDS.heic);
          continue;
        }
        // OA Product: never ignored silently.
        if (!isPictureType(f.type)) {
          if (!next.includes(PICTURE_WORDS.notPicture))
            next.push(PICTURE_WORDS.notPicture);
          continue;
        }
        if (room <= 0) {
          if (!next.includes(PICTURE_WORDS.tooMany))
            next.push(PICTURE_WORDS.tooMany);
          continue;
        }
        room--;
        const key = `p${++seq}`;
        // Shown at once from the file; replaced by the shrunk copy.
        const preview = URL.createObjectURL(f);
        count.current++;
        setItems((xs) => [
          ...xs,
          { key, name: f.name, preview, status: "uploading", progress: 0 },
        ]);
        void (async () => {
          let s: Awaited<ReturnType<typeof shrink>>;
          try {
            s = await shrink(f);
          } catch {
            patch(key, { status: "failed" });
            return;
          }
          if (s.blob.size > PICTURE_BYTES_MAX) {
            refuse(
              key,
              PICTURE_WORDS.tooBig(f.name || "Picture", megabytes(s.blob.size)),
            );
            return;
          }
          patch(key, { blob: s.blob, w: s.w, h: s.h });
          await upload(key, s.blob, f.name || "Picture");
        })();
      }
      setNotes(next);
    },
    [upload, patch, refuse],
  );

  const remove = (key: string) => {
    live.current.get(key)?.abort();
    setItems((xs) => {
      const gone = xs.find((x) => x.key === key);
      if (gone) URL.revokeObjectURL(gone.preview);
      return xs.filter((x) => x.key !== key);
    });
    setNotes([]);
  };
  const retry = () => {
    for (const x of items)
      if (x.status === "failed" && x.blob) void upload(x.key, x.blob);
  };
  /** After a post: the box starts empty. Returns what was attached, to restore on failure. */
  const take = () => {
    const was = items;
    setItems([]);
    setNotes([]);
    return was;
  };
  const restore = (was: Attached[]) => setItems(was);
  const uploading = items.filter((x) => x.status === "uploading").length;
  const failed = items.filter((x) => x.status === "failed").length;
  const refs: PictureRef[] = items.flatMap((x) =>
    x.status === "done" && x.pictureId ? [{ pictureId: x.pictureId }] : [],
  );
  return {
    items,
    notes,
    add,
    remove,
    retry,
    take,
    restore,
    uploading,
    failed,
    refs,
    /** Everything in and nothing pending: the comment can carry them. */
    ready: uploading === 0 && failed === 0,
  };
}
export type PictureDrawer = ReturnType<typeof usePictureDrawer>;

/** The files in a paste or a drop (the drawer refuses what isn't a picture). */
export const filesOf = (dt: DataTransfer | null): File[] =>
  dt ? [...dt.files] : [];
export const hasFiles = (dt: DataTransfer | null) =>
  !!dt && [...dt.types].includes("Files");

/** The 56px thumbnails in the box, each with remove; progress and failure on the tile. */
export function AttachedThumbs({ d }: { d: PictureDrawer }) {
  if (d.items.length === 0) return null;
  return (
    <ul className="m-0 flex list-none flex-wrap gap-2 p-0" data-attached="">
      {d.items.map((x, i) => (
        <li
          key={x.key}
          data-attached-picture={x.status}
          className={`relative size-14 flex-none overflow-hidden rounded-lg border ${
            x.status === "failed"
              ? "border-destructive bg-[var(--oa-danger-soft,transparent)]"
              : "border-border"
          }`}
        >
          <img
            src={x.preview}
            alt={PICTURE_WORDS.open(i + 1, d.items.length)}
            className={`size-full object-cover ${x.status === "uploading" ? "opacity-70" : ""} ${x.status === "failed" ? "opacity-30" : ""}`}
          />
          {x.status === "uploading" && (
            <span
              aria-hidden="true"
              className="absolute bottom-0 left-0 h-1 bg-[var(--oa-accent)]"
              style={{
                width: `${Math.round(Math.max(0.08, x.progress) * 100)}%`,
              }}
            />
          )}
          {x.status === "failed" && (
            // Design: an icon on the tile; the red line below has the words.
            <span className="absolute inset-0 grid place-items-center text-destructive">
              <TriangleAlert className="size-5" aria-hidden="true" />
              <span className="sr-only">{PICTURE_WORDS.didntUpload}</span>
            </span>
          )}
          <button
            type="button"
            aria-label={PICTURE_WORDS.remove(x.name)}
            onClick={() => d.remove(x.key)}
            className="absolute top-0 right-0 grid size-6 cursor-pointer place-items-center rounded-full border-0 bg-transparent p-0"
          >
            <span className="grid size-[18px] place-items-center rounded-full bg-black/70 text-white">
              <X className="size-3" aria-hidden="true" />
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** The notes under the thumbnails: refusals, and a failed upload with Try again. */
export function PictureNotes({
  d,
  needWords,
}: {
  d: PictureDrawer;
  needWords: boolean;
}) {
  if (d.notes.length === 0 && d.failed === 0 && !needWords) return null;
  return (
    <div className="flex flex-col gap-1.5" aria-live="polite">
      {d.notes.map((n) => (
        <p
          key={n}
          className={`m-0 rounded-md px-2.5 py-1.5 ${TXT} ${
            n === PICTURE_WORDS.tooMany
              ? "bg-muted text-foreground"
              : "bg-[var(--oa-danger-soft)] text-destructive"
          }`}
          data-picture-note=""
        >
          {n}
        </p>
      ))}
      {d.failed > 0 && (
        <p
          className={`m-0 rounded-md bg-[var(--oa-danger-soft)] px-2.5 py-1.5 text-destructive ${TXT}`}
          data-picture-note=""
        >
          {PICTURE_WORDS.failed(d.failed)[0]}
          <button
            type="button"
            onClick={d.retry}
            className="cursor-pointer border-0 bg-transparent p-0 font-[inherit] text-inherit underline"
          >
            {PICTURE_WORDS.tryAgain}
          </button>
          {PICTURE_WORDS.failed(d.failed)[1]}
        </p>
      )}
      {needWords && (
        <p
          className={`m-0 rounded-md bg-[var(--oa-warning-soft)] px-2.5 py-1.5 text-[var(--oa-warning)] ${TXT}`}
          data-picture-note=""
        >
          {PICTURE_WORDS.needWords}
        </p>
      )}
    </div>
  );
}

/** The picture button: opens the system chooser (photo library, camera or files on a phone). */
export function AttachButton({ d }: { d: PictureDrawer }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        aria-label={PICTURE_WORDS.add}
        title={PICTURE_WORDS.add}
        data-attach-picture=""
        onClick={() => input.current?.click()}
        className="inline-grid size-[30px] flex-none cursor-pointer place-items-center rounded-lg border border-border bg-background p-0 text-muted-foreground hover:text-foreground max-[600px]:before:absolute max-[600px]:before:-inset-[7px] max-[600px]:relative"
      >
        <svg
          viewBox="0 0 24 24"
          width="16"
          height="16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <circle cx="9" cy="10" r="1.6" />
          <path d="M4 18l5-5 4 4 3-3 4 4" />
        </svg>
      </button>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp,image/heic,image/heif"
        multiple
        hidden
        data-attach-input=""
        onChange={(e) => {
          const files = [...(e.currentTarget.files ?? [])];
          e.currentTarget.value = "";
          if (files.length) void d.add(files);
        }}
      />
    </>
  );
}

/** "Uploading 1 of 2…" while pictures go up. */
export function UploadStatus({ d }: { d: PictureDrawer }) {
  if (d.uploading === 0) return null;
  return (
    <span className={`${TXT} text-muted-foreground`} role="status">
      {PICTURE_WORDS.uploading(d.uploading, d.items.length)}
    </span>
  );
}
