// #2632 slice 2: each person's setup on Settings, Members (item 5). The
// field is @oa/shared's MemberSchema `setup` (#2639): owners and admins get
// it on every row but a guest's; `done` and `stalled` are setupSteps(); `set`
// is sticky from that person's `completed`. This file keeps the design's
// words and the date format.

/** The design's words ("The words on each screen", wcL5Qbdtme52odvV). */
export const SETUP = {
  heading: "Setup",
  set: "Set up",
  of: (n: number, total = 5) => `${n} of ${total}`,
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
