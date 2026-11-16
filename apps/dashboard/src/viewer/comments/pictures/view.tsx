// #2508 slice A2: a posted comment's pictures (56px square thumbnails in one
// row, the space held while loading, "no longer available" when gone) and
// the full-size view over the page with "Open original".
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@oa/ui/shadcn";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useState } from "react";
import {
  type CommentPicture,
  PICTURE_ROUTES,
  picturesOf,
} from "../../../api/commentPictures";
import { TXT } from "../../ui";
import { PICTURE_WORDS } from "./drawer";

type Who = { name: string; when: string };

/** One thumbnail: the box is held while it loads; a dashed box if it's gone. */
function Thumb({
  src,
  label,
  onOpen,
  onGone,
}: {
  src: string;
  label: string;
  onOpen: () => void;
  onGone: () => void;
}) {
  const [state, setState] = useState<"loading" | "ok" | "gone">("loading");
  if (state === "gone")
    return (
      <span
        data-picture="gone"
        className="block size-14 flex-none rounded-lg border border-dashed border-border bg-muted"
      />
    );
  return (
    <button
      type="button"
      aria-label={label}
      data-picture={state}
      onClick={onOpen}
      className="block size-14 flex-none cursor-zoom-in overflow-hidden rounded-lg border border-border bg-muted p-0"
    >
      <img
        src={src}
        alt=""
        loading="lazy"
        className={`size-full object-cover ${state === "loading" ? "opacity-0" : ""}`}
        onLoad={() => setState("ok")}
        onError={() => {
          setState("gone");
          onGone();
        }}
      />
    </button>
  );
}

/** Under a posted comment's text: its pictures, and an agent's description. */
export function CommentPictures({
  artifactId,
  c,
  who,
}: {
  artifactId: string;
  c: object;
  who: Who;
}) {
  const pics = picturesOf(c);
  const [open, setOpen] = useState<number | null>(null);
  const [gone, setGone] = useState(false);
  if (pics.length === 0) return null;
  const alts = pics.flatMap((p) => (p.alt ? [p.alt] : []));
  return (
    <div className="flex flex-col gap-1" data-comment-pictures="">
      <div className="flex flex-wrap gap-1.5">
        {pics.map((p, i) => (
          <Thumb
            key={p.id}
            src={PICTURE_ROUTES.view(artifactId, p.id, true)}
            label={p.alt || PICTURE_WORDS.open(i + 1, pics.length)}
            onOpen={() => setOpen(i)}
            onGone={() => setGone(true)}
          />
        ))}
      </div>
      {gone && (
        <span className={`${TXT} text-muted-foreground`}>
          {PICTURE_WORDS.gone}
        </span>
      )}
      {alts.length > 0 && (
        <p className={`m-0 ${TXT} text-muted-foreground`}>{alts.join(" ")}</p>
      )}
      {open !== null && (
        <Lightbox
          artifactId={artifactId}
          pics={pics}
          at={open}
          who={who}
          onAt={setOpen}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}

/** Full size over the page. Arrow keys move through this comment's pictures. */
export function Lightbox({
  artifactId,
  pics,
  at,
  who,
  onAt,
  onClose,
}: {
  artifactId: string;
  pics: CommentPicture[];
  at: number;
  who: Who;
  onAt: (i: number) => void;
  onClose: () => void;
}) {
  const p = pics[at];
  if (!p) return null;
  const n = pics.length;
  const go = (d: number) => onAt((at + d + n) % n);
  const original = PICTURE_ROUTES.view(artifactId, p.id);
  const head = `${who.name} · ${who.when}${n > 1 ? ` · ${at + 1} of ${n}` : ""}`;
  const btn =
    "inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-white/40 bg-transparent px-2.5 text-[length:var(--oa-text-sm)] text-white no-underline hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-white";
  const nav =
    "grid size-9 flex-none cursor-pointer place-items-center rounded-full border border-white/40 bg-transparent p-0 text-white hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-white";
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        data-lightbox=""
        className="top-0 left-0 flex h-dvh w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-0 bg-black/85 p-0 text-white shadow-none sm:max-w-none"
        onKeyDown={(e) => {
          if (n < 2) return;
          if (e.key === "ArrowRight") go(1);
          if (e.key === "ArrowLeft") go(-1);
        }}
      >
        <div className="flex flex-wrap items-center gap-2.5 px-3.5 py-2.5">
          <DialogTitle className={`m-0 min-w-0 truncate font-normal ${TXT}`}>
            {head}
          </DialogTitle>
          <span className="ml-auto flex gap-2">
            <a className={btn} href={original} target="_blank" rel="noopener">
              {PICTURE_WORDS.openOriginal}
            </a>
            <DialogClose className={btn}>
              {PICTURE_WORDS.close}
              <X className="size-3.5" aria-hidden="true" />
            </DialogClose>
          </span>
        </div>
        {/* A click on the space around the picture closes, as a click outside. */}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: a pointer shortcut; Esc and Close are the keyboard ways out. */}
        <div
          className="flex min-h-0 flex-1 items-center justify-center gap-3 px-3.5 py-1.5"
          onClick={(e) => e.target === e.currentTarget && onClose()}
          role="presentation"
        >
          {n > 1 && (
            <button
              type="button"
              aria-label={PICTURE_WORDS.previous}
              className={nav}
              onClick={() => go(-1)}
            >
              <ChevronLeft className="size-4" aria-hidden="true" />
            </button>
          )}
          <img
            key={p.id}
            src={original}
            alt={p.alt || PICTURE_WORDS.open(at + 1, n)}
            className="h-full min-h-0 w-full min-w-0 flex-1 object-contain"
          />
          {n > 1 && (
            <button
              type="button"
              aria-label={PICTURE_WORDS.next}
              className={nav}
              onClick={() => go(1)}
            >
              <ChevronRight className="size-4" aria-hidden="true" />
            </button>
          )}
        </div>
        <p
          className={`m-0 min-h-[1lh] px-3.5 pt-2.5 pb-3.5 text-center text-white/85 ${TXT}`}
        >
          {p.alt ?? ""}
        </p>
      </DialogContent>
    </Dialog>
  );
}
