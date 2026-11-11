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

/** One face for a comment author: person = initials in a circle; linked agent =
 * its animal in a square tile; unlinked agent = a dashed outline robot. */
export function AuthorFace({
  a,
  small = false,
}: {
  a: CommentAuthor;
  /** The 18px face for a chip. */
  small?: boolean;
}) {
  const box = small ? "size-[18px]" : "size-6";
  const icon = small ? "size-3" : "size-3.5";
  if (a.kind !== "agent") {
    return (
      <span
        aria-hidden="true"
        data-avatar=""
        className={`flex ${box} shrink-0 items-center justify-center rounded-full border border-primary/30 bg-primary/10 text-[length:var(--oa-text-xs)] font-medium text-foreground`}
      >
        {initials(a.name)}
      </span>
    );
  }
  const animal = linkedFace(a);
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
        className={`flex ${box} shrink-0 items-center justify-center rounded-md text-white`}
      >
        <AnimalIcon id={animal.id as never} className={icon} />
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      data-avatar="agent"
      data-linked="false"
      className={`flex ${box} shrink-0 items-center justify-center rounded-md border border-dashed border-muted-foreground bg-transparent text-muted-foreground`}
    >
      <Bot className={icon} />
    </span>
  );
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
