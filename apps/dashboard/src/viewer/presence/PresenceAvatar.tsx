import { ANIMALS, type PresenceEntry } from "@oa/shared";
import { type CSSProperties, forwardRef } from "react";
import { initials } from "../../layout/UserAvatar";
import { AnimalIcon } from "./animals";

/** Names are plain text, cut to 80 characters (Review Focus 5). */
export const NAME_MAX = 80;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export const presenceName = (e: PresenceEntry) =>
  Array.from(graphemes.segment(e.name), (g) => g.segment)
    .slice(0, NAME_MAX)
    .join("");

const fromKey = (key: string) => key.slice(0, 2).toUpperCase();

/**
 * Initials for a face: a named person's, an agent's owner's, else two letters
 * from the opaque key. Never an email (`initials(name, "")`).
 */
export function presenceInitials(e: PresenceEntry): string {
  const name = e.kind === "agent" ? e.agent?.owner : e.named ? e.name : "";
  if (!name?.trim()) return fromKey(e.key);
  return initials(name, "");
}

const animalId = (e: PresenceEntry) =>
  ANIMALS.find((a) => a.id === e.animal)?.id;

type Props = {
  entry: PresenceEntry;
  size: 28 | 40;
  /** A button when the face opens something; a span otherwise. */
  as?: "span" | "button";
} & Omit<React.ComponentProps<"span">, "children" | "style">;

/** One face: a circle (people, anonymous viewers) or a rounded square (agents). */
export const PresenceAvatar = forwardRef<HTMLElement, Props>(
  ({ entry, size, as = "span", className, ...rest }, ref) => {
    const square = entry.kind === "agent";
    const animal = entry.kind === "anon" ? animalId(entry) : undefined;
    const style: CSSProperties = {
      width: size,
      height: size,
      borderRadius: square ? (size === 28 ? 7 : 10) : "50%",
      background: `var(--oa-presence-${entry.color})`,
      fontSize: size === 28 ? 11 : 15,
    };
    const props = {
      "data-shape": square ? "square" : "circle",
      className: `oa-pface ${className ?? ""}`,
      style,
      ref: ref as never,
      ...rest,
      children:
        entry.kind === "anon"
          ? animal && (
              <AnimalIcon
                id={animal}
                className={size === 28 ? "size-4" : "size-6"}
              />
            )
          : presenceInitials(entry),
    };
    return as === "button" ? (
      <button type="button" {...(props as object)} />
    ) : (
      <span {...props} />
    );
  },
);
PresenceAvatar.displayName = "PresenceAvatar";
