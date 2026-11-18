// PROVISIONAL (#2780): the shapes of the server's person @mentions, mirrored
// here until packages/shared carries them. When #2780 is merged, delete this
// file and import the same names from @oa/shared (CommentSchema,
// CommentThreadSchema, CommentListSchema, MentionCandidatesSchema,
// R.artifactMentionCandidates, MENTION_CANDIDATES_Q_MAX); `Comment.people`
// and the `people` body field become typed there.
import {
  type ArtifactAgent,
  type CommentAuthor,
  CommentAuthorSchema,
  type CommentMention,
  R,
  CommentSchema as SharedComment,
  CommentListSchema as SharedList,
  CommentThreadSchema as SharedThread,
} from "@oa/shared";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { z } from "zod";
import { api } from "../../api/client";

/** The longest `q` a candidates search takes. */
export const MENTION_CANDIDATES_Q_MAX = 40;
/** The most people one candidates answer holds. */
export const MENTION_CANDIDATES_MAX = 8;

/** GET ?q= -> { items }: people who can read the page, as faces (never an email). */
export const artifactMentionCandidates = (id: string) =>
  `${R.artifactAgents(id).replace(/\/agents$/, "")}/mention-candidates`;

export const MentionCandidatesSchema = z.object({
  items: z.array(CommentAuthorSchema).max(MENTION_CANDIDATES_MAX),
});

export const CommentSchema = SharedComment.extend({
  people: z.array(CommentAuthorSchema).optional(),
});
export const CommentThreadSchema = SharedThread.extend({
  comments: z.array(CommentSchema),
});
export const CommentListSchema = SharedList.extend({
  threads: z.array(CommentThreadSchema),
});

/** The people a posted comment @mentions (`Comment.people`). */
export const peopleOf = (c: object): CommentAuthor[] =>
  (c as { people?: CommentAuthor[] }).people ?? [];

/** A comment's mentions as the text chips draw them: its agents, then its people (with their initials). */
export const mentionsWithPeople = (c: {
  mentions?: readonly CommentMention[];
}): (CommentMention & { person?: CommentAuthor })[] => [
  ...(c.mentions ?? []),
  ...peopleOf(c).map((p) => ({
    key: personAsAgent(p).key,
    name: p.name,
    person: p,
  })),
];

/** A person in the composer's mention list: keyed apart from agents. */
export const PERSON_KEY = "person:";
export const isPersonKey = (k: string) => k.startsWith(PERSON_KEY);
export const personId = (k: string) => k.slice(PERSON_KEY.length);

/** A picked person as the entry the @-text matching works on (by name). */
export const personAsAgent = (p: CommentAuthor): ArtifactAgent => ({
  key: `${PERSON_KEY}${p.id ?? p.name}`,
  name: p.name,
  online: false,
});

/** The ids that go in `people` for the people named in the text. */
export const peopleIds = (keys: readonly string[]) =>
  keys.filter(isPersonKey).map(personId);

/** A value that settles `ms` after it stops changing. */
export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/**
 * The people matching `q` (debounced). Each new query cancels the one before
 * (its signal), and only the answer for the query shown is ever used. A
 * failure, or a server without the route, just means no people.
 */
export function useMentionCandidates(
  id: string,
  q: string | null,
  enabled: boolean,
): CommentAuthor[] {
  const typed = q?.trim() ?? "";
  const settled = useDebounced(typed, 150);
  const ask =
    enabled &&
    settled !== "" &&
    settled === typed &&
    settled.length <= MENTION_CANDIDATES_Q_MAX;
  const res = useQuery<z.infer<typeof MentionCandidatesSchema>>({
    enabled: ask,
    queryKey: ["mention-candidates", id, settled],
    retry: false,
    staleTime: 30_000,
    queryFn: ({ signal }) =>
      api.get(
        `${artifactMentionCandidates(id)}?q=${encodeURIComponent(settled)}`,
        MentionCandidatesSchema,
        signal,
      ),
  });
  return ask && res.data ? res.data.items : [];
}
