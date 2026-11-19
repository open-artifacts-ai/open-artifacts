// PROVISIONAL (#2895): "Something else" with a typed answer on every ask. The
// shapes of OA Backend-3's server contract, mirrored here until
// packages/shared carries them. When it does, delete this file and import the
// same names from @oa/shared.
//   - POST the pick with { ownWords: { text } } and no optionId, on the same
//     route; the text is trimmed, 1 to 1000 characters. Both optionId and
//     ownWords is a 400.
//   - `answer.ownWords: { text }` (no optionId) on the answer and on `picks[]`
//     entries; `answer.yes` is false for it.
//   - A refusal is 400 bad_request with details.path "ownWords.text" and reason
//     "empty" | "too_long".
//   - The card always adds "Something else" last. An agent's own "Something
//     else" or "Other" stays a normal option with no box.
import { z } from "zod";

export const OWN_WORDS_MAX = 1000;
/** The counter shows from here to the limit. */
export const OWN_WORDS_COUNT_FROM = 900;
export const OWN_LABEL = "Something else";
export const OWN_PLACEHOLDER = "Say what you'd like instead";

/** The card's own option: never an id the agent could post, never sent to the server. */
export const OWN_ID = "__own";

const OwnText = z.object({ text: z.string() });

/** What a server with own words adds to an answer and to picks. */
export const OwnWordsExtra = z.object({
  answer: z.object({ ownWords: OwnText.optional() }).optional(),
  picks: z.array(z.object({ ownWords: OwnText.optional() })).optional(),
});

/** An own-words answer or pick has no optionId: give it ours, so the shared schema reads it. */
const withOwnId = (x: unknown) =>
  x && typeof x === "object" && "ownWords" in x && !("optionId" in x)
    ? { ...x, optionId: OWN_ID }
    : x;

const normalize = (raw: unknown) => {
  if (!raw || typeof raw !== "object") return raw;
  const a = raw as { answer?: unknown; picks?: unknown };
  return {
    ...a,
    ...(a.answer ? { answer: withOwnId(a.answer) } : {}),
    ...(Array.isArray(a.picks) ? { picks: a.picks.map(withOwnId) } : {}),
  };
};

/** The ask schema with the own-words fields read (the rest is the shared one). */
export const withOwnWords = <T extends z.ZodType>(ask: T) =>
  z.preprocess(normalize, ask.and(OwnWordsExtra));

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

/** Why the server refused the words, in plain words; null when it was not about them. */
export function ownWordsRefusal(e: unknown): string | null {
  const d = (e as { details?: { path?: unknown; reason?: unknown } } | null)
    ?.details;
  if (!d || d.path !== "ownWords.text") return null;
  return d.reason === "empty"
    ? "Write your answer first."
    : d.reason === "too_long"
      ? `That is over ${OWN_WORDS_MAX.toLocaleString("en")} characters. Shorten it.`
      : "Couldn't send your words. Try again.";
}
