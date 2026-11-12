import { type CommentAuthor, PRESENCE_PALETTE_SIZE } from "@oa/shared";
import { Bot } from "lucide-react";
import { AnimalIcon } from "../presence/animals";

/** Up to two initials of a display name. */
export function initials(name: string): string {
  const w = name.trim().split(/\s+/).filter(Boolean);
  const first = (x?: string) => Array.from(x ?? "")[0] ?? "";
  const out =
    w.length > 1
      ? `${first(w[0])}${first(w[w.length - 1])}`
      : Array.from(w[0] ?? "?")
          .slice(0, 2)
          .join("");
  return out.toUpperCase();
}

/** A linked agent needs its animal; without one it reads as unlinked. */
const linkedFace = (a: CommentAuthor) =>
  a.kind === "agent" && a.linked === true && a.animal ? a.animal : null;

/** The tile itself: a linked agent's animal in a palette square, or the dashed
 * outline robot (no animal, no colour) when it is not linked. `small` is the
 * inline size for chips and lines. */
function AgentTile({
  animal,
  small = false,
  medium = false,
}: {
  animal: { id: string; color: number } | null;
  small?: boolean;
  /** 20px, for the participants group (#2174). */
  medium?: boolean;
}) {
  const box = medium
    ? "size-5 rounded-md"
    : small
      ? "size-4 rounded"
      : "size-6 rounded-md";
  const glyph = medium ? "size-3" : small ? "size-2.5" : "size-3.5";
  if (animal) {
    const n = PRESENCE_PALETTE_SIZE;
    const color = `var(--oa-presence-${((animal.color % n) + n) % n})`;
    return (
      <span
        aria-hidden="true"
        data-avatar="agent"
        data-linked="true"
        data-animal={animal.id}
        style={{ backgroundColor: color }}
        className={`flex ${box} shrink-0 items-center justify-center text-white`}
      >
        <AnimalIcon id={animal.id as never} className={glyph} />
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      data-avatar="agent"
      data-linked="false"
      className={`flex ${box} shrink-0 items-center justify-center border border-dashed border-muted-foreground bg-transparent text-muted-foreground`}
    >
      <Bot className={glyph} />
    </span>
  );
}

/**
 * The face of a mentioned or asked agent (#1890), small and inline,
 * the same tile as a comment author's. Nothing for a party with no identity
 * fields (a legacy payload renders as it always did) and nothing for a guest.
 */
export function PartyFace({
  p,
  guest = false,
  medium = false,
}: {
  p: { linked?: boolean; animal?: { id: string; color: number } };
  guest?: boolean;
  medium?: boolean;
}) {
  if (guest || p.linked === undefined) return null;
  return (
    <AgentTile
      small
      medium={medium}
      animal={p.linked && p.animal ? p.animal : null}
    />
  );
}

/** One face for a comment author: person = initials in a circle; linked agent =
 * its animal in a square tile; unlinked agent = a dashed outline robot. */
export function AuthorFace({
  a,
  small = false,
}: {
  a: CommentAuthor;
  small?: boolean;
}) {
  if (a.kind !== "agent") {
    return (
      <span
        aria-hidden="true"
        data-avatar=""
        className={`flex ${small ? "size-4 text-[8px]" : "size-6 text-[length:var(--oa-text-xs)]"} shrink-0 items-center justify-center rounded-full border border-primary/30 bg-primary/10 font-medium text-foreground`}
      >
        {initials(a.name)}
      </span>
    );
  }
  return <AgentTile animal={linkedFace(a)} />;
}

/** The agent's second line: "Claude Code · for Leo", or "not linked · for Leo". */
export function AuthorSub({ a }: { a: CommentAuthor }) {
  if (a.kind !== "agent") return null;
  const isLinked = linkedFace(a) !== null;
  const lead = isLinked ? a.product : "not linked";
  const text = [lead, a.for ? `for ${a.for}` : ""].filter(Boolean).join(" · ");
  if (!text) return null;
  return (
    <span
      data-for=""
      className="min-w-0 truncate text-[length:var(--oa-text-xs)] text-muted-foreground"
    >
      {isLinked && <span className="sr-only">linked, </span>}
      {text}
    </span>
  );
}
