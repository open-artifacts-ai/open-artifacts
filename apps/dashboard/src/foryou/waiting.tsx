import type { ArtifactSummary, Comment } from "@oa/shared";
import { waitText } from "./model";

// PROVISIONAL (#2778): the two optional fields below arrive in @oa/shared with
// that PR. Until it merges the schemas strip them, so nothing shows. When it
// merges, delete the two types and the casts in the two readers: the swap is
// this file.
type WaitingSince = { ask?: { waitingSince?: string } };
type Waiting = { waiting?: { count: number; oldestSince: string } };

/** ms since an ISO time, or undefined when absent or unreadable. */
function sinceMs(iso: string | undefined, now: number): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : Math.max(0, now - t);
}

/** PROVISIONAL (#2778): `comment.ask.waitingSince`. */
export const askWaitingSince = (c: Comment): string | undefined =>
  (c as Comment & WaitingSince).ask?.waitingSince;

/** PROVISIONAL (#2778): `ArtifactSummary.waiting`. */
export const libraryWaiting = (a: ArtifactSummary) =>
  (a as ArtifactSummary & Waiting).waiting;

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
