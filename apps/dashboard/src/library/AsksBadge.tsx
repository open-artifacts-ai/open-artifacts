/** "2 asks for you" on an artifact card or row (#1535). Nothing when there are none. */
export function AsksBadge({ n, age }: { n?: number; age?: string }) {
  if (!n) return null;
  return (
    <span className="rounded bg-[var(--oa-warning-soft)] px-[6px] font-semibold text-[var(--oa-warning)]">
      {n === 1 ? "1 ask for you" : `${n} asks for you`}
      {age ? ` · ${age}` : ""}
    </span>
  );
}
