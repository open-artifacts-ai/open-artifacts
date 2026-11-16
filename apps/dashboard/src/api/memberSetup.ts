// #2632 slice 2: each person's setup on Settings, Members (item 5).
//
// PROVISIONAL until OA Self-Serve confirms the contract (issue #2632,
// comment 6904056554, item 4): GET R.members rows gain
// `setup?: { state, done, stalled?, remindedAt? }`, absent for guests and
// the owner. This file is the one place that reads it.
import { MemberSchema } from "@oa/shared";
import { z } from "zod";

export const MemberSetupSchema = z.object({
  state: z.enum(["set", "partial", "invited"]),
  /** Of 5. */
  done: z.number().int().min(0).max(5),
  /** The first step not done. */
  stalled: z.enum(["agent", "named", "artifact", "mention", "ask"]).optional(),
  /** When the one reminder went out (ISO). */
  remindedAt: z.string().optional(),
});
export type MemberSetup = z.infer<typeof MemberSetupSchema>;

/** A members row with its PROVISIONAL `setup`. */
export const MemberWithSetupSchema = MemberSchema.extend({
  setup: MemberSetupSchema.optional(),
});
export type MemberWithSetup = z.infer<typeof MemberWithSetupSchema>;

/** The design's words ("The words on each screen", wcL5Qbdtme52odvV). */
export const SETUP = {
  heading: "Setup",
  set: "Set up",
  of: (n: number) => `${n} of 5`,
  invited: "Invited",
  guest: "–",
  stalled: {
    agent: "no agent connected yet",
    named: "agent not named yet",
    artifact: "nothing published yet",
    mention: "no agent reply yet",
    ask: "ask not answered yet",
  },
  reminded: (date: string) => `Reminded ${date}`,
  copyLine: "Copy the setup line",
  copied: (first: string) => `Copied. Send it to ${first}.`,
} as const;

/** "15 Nov", as the screens show it. */
export const shortDate = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? null
    : d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
};
