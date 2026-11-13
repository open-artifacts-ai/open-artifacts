import {
  type CommentAuthor,
  type CommentThread,
  type PinBadge,
  PRESENCE_PALETTE_SIZE,
} from "@oa/shared";
import { Bot } from "lucide-react";
import { renderToStaticMarkup } from "react-dom/server";
import { AnimalIcon } from "../presence/animals";
import { initials } from "./AuthorFace";

/** The presence palette (viewer.css --oa-presence-0..8): an agent's tile colour. */
export const PRESENCE_HEX = [
  "#0e6e8c",
  "#1f6f5a",
  "#2456c4",
  "#4d6b12",
  "#5b48b8",
  "#7a3f99",
  "#8a4d0f",
  "#a3305f",
  "#b04a14",
] as const;

const strip = (svg: string) =>
  svg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "");
const robot = () => strip(renderToStaticMarkup(<Bot aria-hidden="true" />));

const icons = new Map<string, string | null>();
/** The inner markup of an animal's 24px line icon, cached (the frame rebuilds it from an allowlist). */
function iconMarkup(id: string): string | null {
  const hit = icons.get(id);
  if (hit !== undefined) return hit;
  const svg = renderToStaticMarkup(<AnimalIcon id={id as never} />);
  const inner = strip(svg);
  const out = inner && inner.length <= 6000 ? inner : null;
  icons.set(id, out);
  return out;
}

/**
 * What a pin's bubble shows (#2019), by the card's rules: a person is their
 * initials; a linked agent its animal; any other agent the dashed robot (an
 * agent never reads as a person). `plain` (a guest or capped viewer, #2004)
 * never shows a face, though the server already leaves the animal out for them.
 */
export function badgeFor(author: CommentAuthor, plain = false): PinBadge {
  const label = `Comment by ${author.name}`.slice(0, 120);
  if (author.kind !== "agent")
    return { initials: initials(author.name).slice(0, 4), label };
  if (!plain && author.linked === true && author.animal) {
    const inner = iconMarkup(author.animal.id);
    if (inner) {
      const n = PRESENCE_PALETTE_SIZE;
      return {
        icon: inner,
        color:
          PRESENCE_HEX[((author.animal.color % n) + n) % n] ?? PRESENCE_HEX[0],
        label,
      };
    }
  }
  return { icon: robot(), color: "#5f6670", dashed: true, label };
}

/** The initials of a name being typed, for the pin that is being placed. */
export const draftBadge = (name: string): PinBadge => ({
  initials: initials(name || "?").slice(0, 4),
});

export const threadBadge =
  (plain: boolean) =>
  (t: CommentThread): PinBadge | undefined => {
    const a = t.comments[0]?.author;
    return a ? badgeFor(a, plain) : undefined;
  };
