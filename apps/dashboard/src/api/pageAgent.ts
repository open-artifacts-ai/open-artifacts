// #2610 part 2: a new comment notifies the page's agent by default.
//
// PROVISIONAL (OA Comments' proposal, until @oa/shared has it): this file is
// the one place that reads it.
// - GET R.artifact gains `pageAgent?: { key, name, for }`, sent to members
//   only: the agent that published the page (the server's pagePublisher).
//   Absent for a page a person published, a gone agent, guests and signed-out
//   visitors. `for` is the person whose agent it is; `me` says it is the
//   caller's own (as on a comment author).
// - POST R.comments (a new thread) takes `notifyPageAgent: false` to opt out.
import { z } from "zod";

export const PageAgentSchema = z.object({
  key: z.string(),
  name: z.string(),
  /** The person whose agent it is. */
  for: z.string().nullable().optional(),
  /** The caller's own agent. */
  me: z.boolean().optional(),
  /** The agent's face, when the server sends it (as on thread agents). */
  linked: z.boolean().optional(),
  animal: z
    .object({ id: z.string(), color: z.number().int().min(0) })
    .optional(),
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
  /** The design's glyph, "Notifying {agent} ✕". */
  remove: "✕",
} as const;

/** "Leo" from "Leo Urbina", for "{person}'s agent". */
export const firstOf = (name: string) => name.trim().split(/\s+/)[0] || name;
