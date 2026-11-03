// A person's avatar on shadcn's Avatar: initials on a hue taken from their
// email (else their name), 24px or 32px, named for assistive tech.
import { avatarHue } from "@oa/ui";
import { Avatar, AvatarFallback } from "@oa/ui/shadcn";
import type { CSSProperties } from "react";
import { isReleased, personName } from "./person";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const graphemes = (s: string) =>
  Array.from(segmenter.segment(s), (g) => g.segment);
// Uppercasing can expand a grapheme (ß → SS), so cut again afterwards.
const two = (s: string) =>
  graphemes(graphemes(s).slice(0, 2).join("").toUpperCase())
    .slice(0, 2)
    .join("");

/** Two initials from the name, else from the email's local part, else "?". */
export function initials(name: string | null | undefined, email: string) {
  const words = name?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (words.length > 0)
    return two(
      words
        .slice(0, 2)
        .map((w) => graphemes(w)[0])
        .join(""),
    );
  return two(email.trim().split("@")[0] ?? "") || "?";
}

export function UserAvatar({
  name,
  email,
  size = 24,
}: {
  name?: string | null;
  email?: string | null;
  size?: 24 | 32;
}) {
  // Email keeps hues stable; anonymous users fall back to the name.
  const key = email?.trim() || name?.trim().replace(/\s+/g, " ");
  const style: CSSProperties | undefined = key
    ? { backgroundColor: `hsl(${avatarHue(key)} 45% 30%)`, color: "white" }
    : undefined;
  // Nobody to hash: the quiet sunken tone.
  const quiet = key ? "" : " bg-[var(--oa-sunken)] text-[var(--oa-text-2)]";
  return (
    <Avatar
      role="img"
      aria-label={personName({ name, email })}
      size={size === 24 ? "sm" : "default"}
    >
      <AvatarFallback
        style={style}
        className={`text-[13px] font-semibold group-data-[size=sm]/avatar:text-[10px]${quiet}`}
      >
        {initials(
          isReleased({ email }) ? personName({ name, email }) : name,
          email ?? "",
        )}
      </AvatarFallback>
    </Avatar>
  );
}
