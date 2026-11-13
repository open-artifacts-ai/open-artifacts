import type { ReactNode } from "react";

/** One face in a stack: people are circles, agents are tiles. */
export type Face = { key: string; round: boolean; el: ReactNode };

/**
 * #2247: the one face stack (the participants pill and the delivery header).
 * Faces overlap by 3px, each ringed 1.5px in the card's colour, the first on
 * top so every face shows its full initials or mark. Decorative: the button
 * that holds it carries the name. `more` adds a "+N" after the faces that
 * did not fit in `shown`.
 */
export function FaceStack({
  faces,
  shown = 3,
  more = false,
  moreClass,
  attr = "data-face",
}: {
  faces: readonly Face[];
  shown?: number;
  more?: boolean;
  moreClass?: string;
  /** The marker each face carries, for tests and shots. */
  attr?: "data-face" | "data-participant-face";
}) {
  const top = faces.slice(0, shown);
  return (
    <>
      <span aria-hidden="true" className="inline-flex items-center">
        {top.map((f, i) => (
          <span
            key={f.key}
            {...{ [attr]: "" }}
            style={{ zIndex: top.length - i, marginLeft: i === 0 ? 0 : -3 }}
            className={`relative inline-flex shrink-0 bg-card ring-[1.5px] ring-card ${f.round ? "rounded-full" : "rounded-md"}`}
          >
            {f.el}
          </span>
        ))}
      </span>
      {more && faces.length > shown && (
        <span data-more="" aria-hidden="true" className={moreClass}>
          +{faces.length - shown}
        </span>
      )}
    </>
  );
}
