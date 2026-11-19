// "Something else": a typed answer on every ask (#2895). The shapes are in
// @oa/shared: a pick body `{ ownWords: { text } }` (no optionId), and
// `answer.ownWords` / `picks[].ownWords` with no optionId. The card always adds
// "Something else" last; an agent's own "Something else" or "Other" stays a
// normal option with no box.
export const OWN_WORDS_MAX = 1000;
/** The counter shows from here to the limit. */
export const OWN_WORDS_COUNT_FROM = 900;
export const OWN_LABEL = "Something else";
export const OWN_PLACEHOLDER = "Say what you'd like instead";

/** The card's own option: never an id the agent could post, never sent to the server. */
export const OWN_ID = "__own";

type Opt = { id: string; label: string; detail?: string };

/** The options as the card draws them: the ask's own, then "Something else" last. */
export const optionsWithOwn = <O extends Opt>(ask: { options: O[] }) => [
  ...ask.options,
  { id: OWN_ID, label: OWN_LABEL } as Opt,
];

/** The typed words on an answer or a pick, if it has any. */
export const textOf = (x: object | undefined): string | undefined => {
  const t = (x as { ownWords?: { text?: unknown } } | undefined)?.ownWords
    ?.text;
  return typeof t === "string" && t.trim() !== "" ? t : undefined;
};

/**
 * The option an answer or a pick landed on: its own, or the card's "Something
 * else" for an own-words one (which has no optionId).
 */
export const optionIdOf = (
  x: { optionId?: string | undefined } | undefined,
): string | undefined =>
  x?.optionId ?? (textOf(x) !== undefined ? OWN_ID : undefined);

/** Why the server refused the words, in plain words; null when it was not about them. */
export function ownWordsRefusal(e: unknown): string | null {
  const d = (e as { details?: { path?: unknown; reason?: unknown } } | null)
    ?.details;
  if (!d || d.path !== "ownWords.text") return null;
  return d.reason === "empty"
    ? "Write your answer first."
    : d.reason === "too_long"
      ? `That's over ${OWN_WORDS_MAX.toLocaleString("en")} characters. Shorten it.`
      : "Couldn't send your answer. Try again.";
}
