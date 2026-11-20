/**
 * #2610 part 1: the publisher beside the title, for the version on screen,
 * and the one sheet it opens (who can open the page, who published it, See
 * all versions). Design's tab 2 ("beside the title, collapsing to the
 * picture"). A signed-out visitor gets the person only, and no button.
 */
import type { ArtifactSummary } from "@oa/shared";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  Button as ShButton,
} from "@oa/ui/shadcn";
import {
  type RefObject,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { personName } from "../layout/person";
import { AuthorFace } from "./comments/AuthorFace";
import { ACCESS } from "./panels/Share";
import {
  fullLine,
  lineParts,
  type Publisher,
  publisherName,
  sheetLines,
} from "./publisher";
import { TXT, VisibilityBadge } from "./ui";

/**
 * The picture only under 960px: under 900px as Design drew it, and from 900
 * to 960px too, where the one-row bar (#2503) already gives way in stages and
 * the title keeps its room.
 */
export const PICTURE_ONLY = "(width < 960px)";
const pictureOnlyStore = {
  subscribe: (cb: () => void) => {
    const m = window.matchMedia?.(PICTURE_ONLY);
    m?.addEventListener?.("change", cb);
    return () => m?.removeEventListener?.("change", cb);
  },
  get: () => window.matchMedia?.(PICTURE_ONLY).matches ?? false,
};
export const usePictureOnly = () =>
  useSyncExternalStore(
    pictureOnlyStore.subscribe,
    pictureOnlyStore.get,
    () => false,
  );

/**
 * How far the line has given way (0 full ... 3 picture only). From 960px it
 * drops a part each time the title row is too tight: the title truncates, the
 * row overflows, or the buttons wrap below it. A new width or new content
 * starts again from 0; every step runs before paint.
 */
export function usePublisherStage(
  row: RefObject<HTMLElement | null>,
  title: RefObject<HTMLElement | null>,
  buttons: RefObject<HTMLElement | null>,
  pictureOnly: boolean,
  content: string,
): 0 | 1 | 2 | 3 {
  const [stage, setStage] = useState<0 | 1 | 2 | 3>(0);
  const [width, setWidth] = useState(0);
  const key = `${content}|${width}|${pictureOnly}`;
  const was = useRef(key);
  // Even the picture alone didn't make the row fit (the buttons wrap below the
  // title anyway): then the title's line has room, so the line stays whole.
  const gaveUp = useRef(false);
  useLayoutEffect(() => {
    const el = row.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [row]);
  useLayoutEffect(() => {
    if (was.current !== key) {
      was.current = key;
      gaveUp.current = false;
      if (stage !== 0) {
        setStage(0);
        return;
      }
    }
    if (pictureOnly || gaveUp.current) return;
    const el = row.current;
    const h = title.current?.querySelector("h1") as HTMLElement | null;
    const b = buttons.current;
    if (!el) return;
    const tight =
      el.scrollWidth > el.clientWidth + 1 ||
      (h !== null && h.scrollWidth > h.clientWidth + 1) ||
      (b !== null &&
        title.current !== null &&
        b.offsetTop > title.current.offsetTop + 4);
    if (!tight) return;
    if (stage < 3) setStage((stage + 1) as 1 | 2 | 3);
    else {
      gaveUp.current = true;
      setStage(0);
    }
  });
  return pictureOnly ? 3 : stage;
}

/** On a phone the picture is 18px, a person's initials and an agent's tile alike (Design). */
const PHONE_18 =
  "contents max-[600px]:[&>[data-avatar]]:size-[18px] max-[600px]:[&>[data-avatar]]:text-[8.5px]";

function Face({ p }: { p: Publisher }) {
  return <span className={PHONE_18}>{face(p)}</span>;
}

function face(p: Publisher) {
  return p.agent ? (
    <AuthorFace
      small
      a={{
        kind: "agent",
        name: p.agent.name,
        linked: p.agent.linked,
        animal: p.agent.animal,
        me: false,
      }}
    />
  ) : (
    <AuthorFace
      small
      a={{
        kind: "user",
        id: p.person.id,
        name: personName(p.person),
        me: false,
      }}
    />
  );
}

/** The words beside the picture, by stage (none at stage 3). */
function Words({ p, stage }: { p: Publisher; stage: 0 | 1 | 2 | 3 }) {
  const parts = lineParts(p, stage);
  if (parts.length === 0) return null;
  return (
    <>
      <span className="font-medium text-[var(--oa-text-2)]">{parts[0]}</span>
      {parts.slice(1).map((x) => ` · ${x}`)}
    </>
  );
}

const LINE =
  "inline-flex min-w-0 max-w-[44ch] flex-none items-center gap-1.5 whitespace-nowrap text-[length:var(--oa-text-sm)] text-muted-foreground";

/**
 * The publisher beside the title. A button opening the sheet for anyone who
 * can open Versions (signed in); a plain line for a signed-out visitor.
 * `open`/`onOpenChange` let the title and the access chip open the same sheet.
 */
export function PublisherLine({
  p,
  stage,
  signedIn,
  artifact,
  org,
  open,
  onOpenChange,
  onVersions,
  canSeeVersions,
}: {
  /** Guests and signed-out visitors can't open Versions: no "See all versions". */
  canSeeVersions: boolean;
  p: Publisher;
  stage: 0 | 1 | 2 | 3;
  signedIn: boolean;
  artifact: ArtifactSummary;
  org: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onVersions: () => void;
}) {
  const label = fullLine(p);
  if (!signedIn)
    return (
      <span
        data-publisher=""
        data-publisher-stage={stage}
        role="img"
        aria-label={label}
        title={label}
        className={LINE}
      >
        <Face p={p} />
        <span className="min-w-0 truncate" aria-hidden="true">
          <Words p={p} stage={stage} />
        </span>
      </span>
    );
  const [title, sub] = sheetLines(p);
  const [access, who] = ACCESS(artifact.visibility, org, artifact.space);
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor asChild>
        <span
          data-publisher=""
          data-publisher-stage={stage}
          // The tooltip: always the full line.
          title={label}
          className={LINE}
        >
          {/* The picture is the control, named by the full line; the
                    short words beside it are the same target for a pointer. */}
          <span className="relative grid flex-none place-items-center">
            <Face p={p} />
            {/* Over the picture, with no text of its own: its name is
                      the full line, whatever the picture shows (initials). */}
            <button
              type="button"
              aria-label={label}
              aria-haspopup="dialog"
              aria-expanded={open}
              onClick={() => onOpenChange(!open)}
              className="absolute -inset-1 cursor-pointer rounded-sm border-0 bg-transparent p-0 outline-none focus-visible:ring-2 focus-visible:ring-[var(--oa-focus)]"
            />
          </span>
          {stage < 3 && (
            // biome-ignore lint/a11y/noStaticElementInteractions: the button beside it is the keyboard's way in
            // biome-ignore lint/a11y/useKeyWithClickEvents: as above
            <span
              aria-hidden="true"
              onClick={() => onOpenChange(!open)}
              className="min-w-0 cursor-pointer truncate hover:text-foreground"
            >
              <Words p={p} stage={stage} />
            </span>
          )}
        </span>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        collisionPadding={8}
        aria-label={`About ${artifact.title}`}
        data-publisher-sheet=""
        className="w-[300px] max-w-[calc(100vw-16px)] p-3"
      >
        <div className="flex flex-wrap items-center gap-2">
          <VisibilityBadge visibility={artifact.visibility} org={org} />
          <span className="sr-only">{access}. </span>
          <small className={`${TXT} m-0 text-muted-foreground`}>{who}</small>
        </div>
        <div className="mt-2.5 flex items-start gap-2.5 border-t border-border pt-2.5">
          <Face p={p} />
          <div className="min-w-0">
            <b className={`${TXT} block font-semibold`} data-published-by="">
              {title}
            </b>
            <small className={`${TXT} block text-muted-foreground`}>
              {sub}
            </small>
          </div>
        </div>
        {canSeeVersions && (
          <ShButton
            variant="link"
            size="sm"
            className="mt-2 h-auto p-0"
            onClick={() => {
              onOpenChange(false);
              onVersions();
            }}
          >
            See all versions
          </ShButton>
        )}
      </PopoverContent>
    </Popover>
  );
}

export { publisherName };
