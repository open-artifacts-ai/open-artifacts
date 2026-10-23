// A person's initials on their hue (shadcn Avatar): the same hue and initials
// as @oa/ui's Avatar, so a person looks the same everywhere.
import { avatarHue, displayName } from "@oa/ui";
import { Avatar, AvatarFallback } from "@oa/ui/shadcn";
import type { CSSProperties } from "react";

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

export function PersonAvatar({
  name,
  email,
}: {
  name?: string | null;
  email?: string | null;
}) {
  // Email keeps existing hues stable; anonymous users fall back to the name.
  const key = email?.trim() || name?.trim().replace(/\s+/g, " ");
  return (
    <Avatar
      size="sm"
      role="img"
      aria-label={displayName({ name, email })}
      style={key ? ({ "--hue": avatarHue(key) } as CSSProperties) : undefined}
    >
      <AvatarFallback
        className={`text-[10px] font-semibold ${key ? "bg-[hsl(var(--hue)_45%_30%)] text-white" : "bg-[var(--oa-sunken)] text-[var(--oa-text-2)]"}`}
      >
        {initials(name, email ?? "")}
      </AvatarFallback>
    </Avatar>
  );
}
