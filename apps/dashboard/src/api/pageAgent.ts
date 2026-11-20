// #2610 part 2: a new comment notifies the page's agent by default.
//
// PROVISIONAL (#2610): the shapes of the server PR #2949's final contract,
// until @oa/shared has them. This file is the one place that reads it.
// - GET R.artifact gains optional `pageAgent: { key, name, for, me }`, members
//   only: `key` is the roster key @mentions use, `name` the agent's name, `for`
//   the person's public name ("Member" when they have none; never an email),
//   `me` true when the agent is the caller's own. Absent when a person
//   published the page, the agent is unlinked, or its person can no longer
//   open the page. No face fields (linked, animal) are sent.
// - POST R.comments (a new thread) takes optional `notifyPageAgent: boolean`
//   (default true for a note, text or pin); false opts out.
import { z } from "zod";

export const PageAgentSchema = z.object({
  key: z.string(),
  name: z.string(),
  /** The person whose agent it is. */
  for: z.string(),
  /** The caller's own agent. */
  me: z.boolean(),
});
export type PageAgent = z.infer<typeof PageAgentSchema>;

/** The GET R.artifact field. */
export const pageAgentField = {
  pageAgent: PageAgentSchema.nullable().optional(),
};

/** The opt-out a new thread's body carries when the chip is removed. */
export const optOut = (notify: boolean) =>
  notify ? {} : { notifyPageAgent: false as const };

/** The design's words (#2610, artifact Wa9SkazkDRMywSjE), word for word. */
export const NOTIFY = {
  lead: "Notifying",
  /** A teammate's agent: "{agent} · {person}'s agent". */
  teammate: (agent: string, person: string) => `${agent} · ${person}'s agent`,
  stop: (agent: string) => `Stop notifying ${agent} in this thread`,
} as const;

/** "Leo" from "Leo Urbina", for "{person}'s agent". */
export const firstOf = (name: string) => name.trim().split(/\s+/)[0] || name;
