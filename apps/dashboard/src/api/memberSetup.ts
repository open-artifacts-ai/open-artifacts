// #2632 slice 2: each person's setup on Settings, Members (item 5).
//
// The contract (issue #2632: comment 6904056554 item 4, amended in
// 6905450077, confirmed by OA Self-Serve in 6909830141): GET R.members rows
// gain `setup?: { state, done, stalled?, remindedAt? }`, the owner's too,
// and only when the caller is an owner or admin; never for guests. `done`
// and `stalled` are the server's setupSteps(onboarding) (@oa/shared, the
// count the card and Welcome show); `state: "set"` is sticky from the
// person's `completed`. Field names stay PROVISIONAL until the server ships.
// This file is the one place that reads it.
import { MemberSchema, SETUP_STEPS } from "@oa/shared";
import { z } from "zod";

export const MemberSetupSchema = z.object({
  state: z.enum(["set", "partial", "invited"]),
  /** Of 5. */
  done: z.number().int().min(0).max(5),
  /** The first step not done: the server's setupSteps(onboarding).stalled. */
  stalled: z.enum(SETUP_STEPS).optional(),
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
