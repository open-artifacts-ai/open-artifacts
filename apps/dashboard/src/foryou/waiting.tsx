import type { ArtifactSummary, Comment } from "@oa/shared";
import { AsksBadge } from "../library/AsksBadge";
import { waitText } from "./model";

/** ms since an ISO time, or undefined when absent or unreadable. */
function sinceMs(iso: string | undefined, now: number): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : Math.max(0, now - t);
}

/** `comment.ask.waitingSince` (#2778). */
export const askWaitingSince = (c: Comment): string | undefined =>
  c.ask?.waitingSince;

/** `ArtifactSummary.waiting` (#2778). */
export const libraryWaiting = (a: ArtifactSummary) => a.waiting;

/** The calm "◷ waiting 4 min" mark, the same one For you shows. */
export function WaitMark({
  ms,
  lead = "",
}: {
  ms: number;
  /** Text before the duration, e.g. "1 " on the Library card. */
  lead?: string;
}) {
  return (
    <span
      data-for-you-wait=""
      className="inline-flex items-center gap-1 rounded-full bg-[var(--oa-warning-soft)] px-[7px] py-px font-[family-name:var(--oa-font-mono)] text-[11.5px] font-medium whitespace-nowrap text-[var(--oa-warning)]"
    >
      <span aria-hidden="true">◷</span> {lead}
      {waitText(ms)}
    </span>
  );
}

/** On the page's ask card: nothing without `waitingSince`. */
export function AskWaiting({
  c,
  now = Date.now(),
}: {
  c: Comment;
  now?: number;
}) {
  const ms = sinceMs(askWaitingSince(c), now);
  return ms === undefined ? null : <WaitMark ms={ms} />;
}

/** On the Library card: "◷ 1 waiting 4 min"; nothing when none wait. */
export function LibraryWaiting({
  a,
  now = Date.now(),
}: {
  a: ArtifactSummary;
  now?: number;
}) {
  const w = libraryWaiting(a);
  const ms = w && w.count > 0 ? sinceMs(w.oldestSince, now) : undefined;
  return ms === undefined || !w ? null : (
    <WaitMark ms={ms} lead={`${w.count} `} />
  );
}

/**
 * The asks and waiting marks on a Library card or row. When every ask for the
 * viewer is one an agent waits on, one chip: "1 ask for you · 4 min".
 * Otherwise the asks chip and the waiting mark, side by side.
 */
export function LibraryAsks({
  a,
  now = Date.now(),
}: {
  a: ArtifactSummary;
  now?: number;
}) {
  const w = libraryWaiting(a);
  const ms = w && w.count > 0 ? sinceMs(w.oldestSince, now) : undefined;
  if (w && ms !== undefined && a.asksForYou === w.count)
    return (
      <AsksBadge n={a.asksForYou} age={waitText(ms).replace(/^waiting /, "")} />
    );
  return (
    <>
      <AsksBadge n={a.asksForYou} />
      <LibraryWaiting a={a} now={now} />
    </>
  );
}
