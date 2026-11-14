import type { Comment, CommentThread } from "@oa/shared";

/** #2381 S2: one decided ask on the page, as the Decisions tab lists it. */
export type Decision = {
  /** The ask's comment id. */
  id: string;
  thread: CommentThread;
  comment: Comment;
  ask: NonNullable<Comment["ask"]>;
  answer: NonNullable<NonNullable<Comment["ask"]>["answer"]>;
};

/**
 * Every decided ask of the threads, newest decision first. A decision still on
 * its way (the optimistic pick) is not one yet, and a thread that is resolved
 * keeps its decisions.
 */
export function decisionsOf(threads: readonly CommentThread[]): Decision[] {
  const out: Decision[] = [];
  for (const thread of threads)
    for (const comment of thread.comments) {
      const ask = comment.ask;
      const answer = ask?.answer;
      if (!ask || !answer) continue;
      if ((answer as { sending?: boolean }).sending === true) continue;
      out.push({ id: comment.id, thread, comment, ask, answer });
    }
  return out.sort((a, b) => b.answer.at.localeCompare(a.answer.at));
}

/** Weigh-ins on a decision: everyone's latest pick but the decider's own, and how many differed. */
export function weighIns(d: Decision): { n: number; differed: number } {
  const views = (d.ask.picks ?? []).filter((p) => p.by.id !== d.answer.by.id);
  return {
    n: views.length,
    differed: views.filter((p) => p.optionId !== d.answer.optionId).length,
  };
}
