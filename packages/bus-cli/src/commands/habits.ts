// The always-on habits flow (#1583): the disclosure on install, and the
// --habits / --no-habits / --show-habits commands. The block itself, and the
// files it goes in, are steps/habits.ts.

import { BUS_CMD } from "@oa/bus-protocol";
import { type Ctx, say, sayErr, tilde } from "../context.ts";
import { checkAdapters } from "../steps/adapters.ts";
import {
  type BlockState,
  HABITS_HARNESSES,
  HABITS_LINES,
  type HabitsHarness,
  type HabitsQuestion,
  habitsBlock,
  habitsFileState,
  habitsOn,
  habitsOptedOut,
  habitsQuestion,
  habitsQuestionLines,
  linkInfo,
  removeHabits,
  setHabitsOptOut,
  writeHabits,
} from "../steps/habits.ts";

export const HERMES_HABITS = "Hermes: provided by the plugin.";

export type HabitsMode = "yes" | "no" | "show";
/** What the step decided, for `--json`. */
export type HabitsOutcome = {
  state: "on" | "off" | "undecided" | "changed" | "none";
  files: string[];
  question: HabitsQuestion | null;
  hermes: boolean;
};

const deps = (ctx: Ctx) => ({
  home: ctx.userHome,
  env: ctx.env,
  busHome: ctx.home,
});

/** The harnesses wired now that have an always-on file we write, and whether Hermes is wired. */
function wired(ctx: Ctx): { targets: HabitsHarness[]; hermes: boolean } {
  const w = checkAdapters({
    home: ctx.userHome,
    busHome: ctx.home,
    env: ctx.env,
    which: ctx.which,
    codexApp: ctx.codexApp,
    busBin: ctx.service.argv?.(),
  });
  return {
    targets: HABITS_HARNESSES.filter((h) => w[h] === "configured"),
    hermes: w.hermes === "configured",
  };
}

const stamp = (ctx: Ctx) => new Date(ctx.now()).toISOString();
/** A file as shown to the user; a symlink names where it points. */
const one = (ctx: Ctx, f: string) => {
  const link = linkInfo({ home: ctx.userHome }, f);
  return link
    ? `${tilde(ctx, f)} (symlink to ${tilde(ctx, link.target)}${link.outside ? ", outside your home" : ""})`
    : tilde(ctx, f);
};
const shown = (ctx: Ctx, files: string[]) =>
  files.map((f) => one(ctx, f)).join(", ");

/** `--show-habits`: the exact block, as it would be written. */
const show = (ctx: Ctx): number => {
  say(ctx, habitsBlock());
  return 0;
};

/** `--habits`: write the block for the wired harnesses and clear any opt-out. */
function turnOn(ctx: Ctx): number {
  const { targets, hermes } = wired(ctx);
  if (targets.length === 0 && !hermes) {
    sayErr(ctx, [
      `No harness with an always-on instructions file is set up. Run ${BUS_CMD} install first.`,
    ]);
    return 1;
  }
  const r = writeHabits(deps(ctx), targets, { explicit: true });
  setHabitsOptOut(ctx.home, false, stamp(ctx));
  if (r.files.length > 0) say(ctx, `Habits on in ${shown(ctx, r.files)}`);
  if (hermes) say(ctx, HERMES_HABITS);
  for (const n of r.notes) say(ctx, n);
  return r.notes.length > 0 && r.files.length === 0 ? 1 : 0;
}

/** `--no-habits`: remove the block everywhere and remember the choice. */
function turnOff(ctx: Ctx): number {
  const r = removeHabits(deps(ctx));
  setHabitsOptOut(ctx.home, true, stamp(ctx));
  say(
    ctx,
    r.files.length > 0
      ? `Habits off. Removed from ${shown(ctx, r.files)}`
      : "Habits off. There was no block to remove.",
    "A reinstall will not add them back.",
  );
  for (const n of r.notes) say(ctx, n);
  return 0;
}

/** The lines a person reads before answering. */
function disclosure(
  ctx: Ctx,
  pending: { path: string; s: BlockState }[],
): string[] {
  const files = pending.map((p) => one(ctx, p.path));
  const changed = pending.filter((p) => p.s.state === "changed");
  if (changed.length === 0)
    return [
      `The bus adds ${HABITS_LINES.length} habits to ${files.join(" and ")} for sessions on the bus:`,
      ...HABITS_LINES.map((l) => `  ${l}`),
    ];
  const first = changed[0]?.s;
  return [
    `The habits the bus added to ${files.join(" and ")} changed in this release.`,
    "Now in the file:",
    ...(first?.state === "changed" ? first.old.map((l) => `  ${l}`) : []),
    "New:",
    ...HABITS_LINES.map((l) => `  ${l}`),
  ];
}

/**
 * After a plain install. A person at a terminal is shown the lines and asked;
 * with no terminal (an agent ran it) nothing is written and the question is
 * printed for the agent to put to its user.
 */
export async function habitsAfterInstall(
  ctx: Ctx,
  json: boolean,
): Promise<HabitsOutcome> {
  const { targets, hermes } = wired(ctx);
  const none: HabitsOutcome = {
    state: "none",
    files: [],
    question: null,
    hermes,
  };
  if (habitsOptedOut(ctx.home))
    return { ...none, state: "off", question: null };
  if (targets.length === 0) return none;
  const states = targets.map((h) => ({
    path: habitsFileState(deps(ctx), h).path,
    s: habitsFileState(deps(ctx), h) as BlockState,
  }));
  const pending = states.filter((p) => p.s.state !== "current");
  const have = states.filter((p) => p.s.state === "current").map((p) => p.path);
  if (pending.length === 0)
    return { ...none, state: "on", files: have, question: null };
  const changed = pending.some((p) => p.s.state === "changed");
  const state = changed ? "changed" : "undecided";
  const asked = pending.map((p) => p.path);
  const question = habitsQuestion(asked.map((f) => one(ctx, f)));
  if (ctx.stdinIsTTY && ctx.readLine && !json) {
    say(ctx, "", disclosure(ctx, pending));
    // A symlink out of the home (a dotfiles or repo file) needs a typed yes: Enter is no.
    const outside = pending.some(
      (p) => linkInfo({ home: ctx.userHome }, p.path)?.outside,
    );
    const a = (
      await ctx.readLine(
        `Add them? ${outside ? "[y/N]" : "[Y/n]"}   (the full block: ${BUS_CMD} install --show-habits) `,
      )
    )
      .trim()
      .toLowerCase();
    if (a === "" && outside) {
      say(
        ctx,
        "Nothing was written: a file above is a symlink outside your home, so it needs a typed y.",
      );
      return { ...none, state, files: have, question };
    }
    if (a === "" || a === "y" || a === "yes") {
      const r = writeHabits(
        deps(ctx),
        targets.filter((h) =>
          asked.includes(habitsFileState(deps(ctx), h).path),
        ),
        { explicit: a !== "" },
      );
      if (!changed) setHabitsOptOut(ctx.home, false, stamp(ctx));
      if (r.files.length > 0) say(ctx, `Habits on in ${shown(ctx, r.files)}`);
      for (const n of r.notes) say(ctx, n);
      return {
        ...none,
        state: "on",
        files: [...have, ...r.files],
        question: null,
      };
    }
    if (a === "n" || a === "no") {
      // A first "no" is the user's choice; declining a changed block keeps the old one.
      if (!changed) {
        setHabitsOptOut(ctx.home, true, stamp(ctx));
        say(ctx, "Habits off. A reinstall will not add them back.");
        return { ...none, state: "off" };
      }
      say(ctx, "Left the habits as they were.");
      return { ...none, state, files: have, question: null };
    }
    say(ctx, `Did not understand "${a}". Nothing was written.`);
    return { ...none, state, files: have, question };
  }
  // No terminal: an agent ran this. Write nothing; hand it the question.
  if (!json) say(ctx, "", habitsQuestionLines(question));
  return { ...none, state, files: have, question };
}

/** `install --habits | --no-habits | --show-habits`: only the block, nothing else reruns. */
export function habitsCommand(mode: HabitsMode, ctx: Ctx): number {
  say(ctx, ctx.copy.header(ctx.version), "");
  return mode === "show"
    ? show(ctx)
    : mode === "yes"
      ? turnOn(ctx)
      : turnOff(ctx);
}

/** The status and doctor line: "Habits: on in …", "off (you opted out)", or not decided. */
export function habitsLine(ctx: Ctx): string | undefined {
  const { targets, hermes } = wired(ctx);
  if (habitsOptedOut(ctx.home)) return "Habits: off (you opted out)";
  const on = habitsOn(deps(ctx));
  if (on.length > 0)
    return `Habits: on in ${shown(ctx, on)}${hermes ? "; Hermes: provided by the plugin" : ""}`;
  if (targets.length > 0)
    return `Habits: not decided (${BUS_CMD} install --habits to add them)`;
  return hermes ? "Habits: Hermes: provided by the plugin" : undefined;
}
