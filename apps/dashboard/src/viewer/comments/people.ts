// Client helpers for person @mentions; the server shapes are in @oa/shared.
import {
  type ArtifactAgent,
  type CommentAuthor,
  type CommentMention,
  MENTION_CANDIDATES_Q_MAX,
  MentionCandidatesSchema,
  R,
} from "@oa/shared";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { z } from "zod";
import { api } from "../../api/client";

/** A comment's mentions as the text chips draw them: its agents, then its people (with their initials). */
export const mentionsWithPeople = (c: {
  mentions?: readonly CommentMention[];
  people?: readonly CommentAuthor[];
}): (CommentMention & { person?: CommentAuthor })[] => [
  ...(c.mentions ?? []),
  ...(c.people ?? []).map((p) => ({
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
      api.send(
        "POST",
        R.artifactMentionCandidates(id),
        { q: settled },
        MentionCandidatesSchema,
        signal,
      ),
  });
  return ask && res.data ? res.data.items : [];
}
