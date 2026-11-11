// The always-on habits flow (#1583): the disclosure on install, and the
// --habits / --no-habits / --show-habits commands. The block itself, and the
// files it goes in, are steps/habits.ts.

import { join } from "node:path";
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
  OMP_NOTE,
  PLUGIN_HARNESSES,
  type PluginHabitsState,
  type PluginHarness,
  pluginHabitsState,
  removeHabits,
  setHabitsOptOut,
  setPluginHabits,
  writeHabits,
} from "../steps/habits.ts";

/** What a person reads once a plugin's habits are on or off. */
export const pluginOn = (p: PluginHarness) =>
  `Habits on in the ${p.label} plugin.`;
export const pluginOff = (p: PluginHarness) =>
  `Habits off in the ${p.label} plugin.`;

export type HabitsMode = "yes" | "no" | "show";
/** What the step decided, for `--json`. */
export type HabitsOutcome = {
  state: "on" | "off" | "undecided" | "changed" | "none";
  files: string[];
  question: HabitsQuestion | null;
  /** Each plugin harness's habits state (Hermes: on, off, not installed). */
  plugins: Record<string, PluginHabitsState>;
};

const deps = (ctx: Ctx) => ({
  home: ctx.userHome,
  env: ctx.env,
  busHome: ctx.home,
});

/** The harnesses wired now that have an always-on file we write, and the plugin ones. */
function wired(ctx: Ctx): {
  targets: HabitsHarness[];
  plugins: PluginHarness[];
} {
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
    plugins: PLUGIN_HARNESSES.filter((p) => w[p.name] === "configured"),
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

/** "Hermes plugin: on", "off" or "not installed". */
const pluginStateText = (ctx: Ctx, p: PluginHarness) =>
  `${p.label} plugin: ${pluginHabitsState(deps(ctx), p)}`;

/** `--show-habits`: the exact block, as it would be written, then each plugin's state. */
const show = (ctx: Ctx): number => {
  say(
    ctx,
    habitsBlock(),
    "",
    PLUGIN_HARNESSES.map((p) => pluginStateText(ctx, p)),
  );
  return 0;
};

/** `--habits`: write the block for the wired harnesses and clear any opt-out. */
function turnOn(ctx: Ctx): number {
  const { targets, plugins } = wired(ctx);
  if (targets.length === 0 && plugins.length === 0) {
    sayErr(ctx, [
      `No harness with an always-on instructions file is set up. Run ${ctx.busCmd} install first.`,
    ]);
    return 1;
  }
  const r = writeHabits(deps(ctx), targets, { explicit: true });
  const pl = setPluginHabits(deps(ctx), plugins, true);
  setHabitsOptOut(ctx.home, false, stamp(ctx));
  if (r.files.length > 0) say(ctx, `Habits on in ${shown(ctx, r.files)}`);
  for (const p of pl.changed) say(ctx, pluginOn(p));
  const notes = [...r.notes, ...pl.notes];
  for (const n of notes) say(ctx, n);
  return notes.length > 0 && r.files.length + pl.changed.length === 0 ? 1 : 0;
}

/** `--no-habits`: remove the block everywhere and remember the choice. */
function turnOff(ctx: Ctx): number {
  const r = removeHabits(deps(ctx));
  setHabitsOptOut(ctx.home, true, stamp(ctx));
  const pluginFiles = r.pluginFiles ?? [];
  const blocks = r.files.filter((f) => !pluginFiles.includes(f));
  const offIn = r.plugins ?? [];
  if (r.incomplete) {
    // Never "Habits off" while a marker may still be on.
    say(
      ctx,
      ...(blocks.length > 0 ? [`Removed from ${shown(ctx, blocks)}`] : []),
      "Habits are still on in some places (see below). Your opt-out is saved, so a reinstall won't add them back.",
    );
    for (const p of offIn) say(ctx, pluginOff(p));
    for (const n of r.notes) say(ctx, n);
    return 1;
  }
  say(
    ctx,
    blocks.length > 0
      ? `Habits off. Removed from ${shown(ctx, blocks)}`
      : "Habits off. There was no block to remove.",
    "A reinstall will not add them back.",
  );
  for (const p of offIn) say(ctx, pluginOff(p));
  for (const n of r.notes) say(ctx, n);
  return 0;
}

/** Each plugin harness's habits state, by name. */
const pluginStates = (ctx: Ctx): Record<string, PluginHabitsState> =>
  Object.fromEntries(
    PLUGIN_HARNESSES.map((p) => [p.name, pluginHabitsState(deps(ctx), p)]),
  );

/** The lines a person reads before answering. */
function disclosure(
  ctx: Ctx,
  pending: { path: string; label?: string; s: BlockState }[],
): string[] {
  const files = pending.map((p) => p.label ?? one(ctx, p.path));
  const changed = pending.filter((p) => p.s.state === "changed");
  if (changed.length === 0)
    return [
      `The bus would add ${HABITS_LINES.length} habits for sessions on the bus, to ${files.join(" and ")}:`,
      ...HABITS_LINES.map((l) => `  ${l}`),
      `  ${OMP_NOTE}`,
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
  const { targets, plugins } = wired(ctx);
  const none: HabitsOutcome = {
    state: "none",
    files: [],
    question: null,
    plugins: pluginStates(ctx),
  };
  if (habitsOptedOut(ctx.home))
    return { ...none, state: "off", question: null };
  if (targets.length === 0 && plugins.length === 0) return none;
  const states: { path: string; label?: string; s: BlockState }[] = [
    ...targets.map((h) => ({
      path: habitsFileState(deps(ctx), h).path,
      s: habitsFileState(deps(ctx), h) as BlockState,
    })),
    // A plugin has no block to compare: its marker is there ("current") or not.
    ...plugins.map((p) => ({
      path: join(p.dir(ctx.userHome, ctx.env), p.marker),
      label: `the ${p.label} plugin`,
      s: {
        state: pluginHabitsState(deps(ctx), p) === "on" ? "current" : "absent",
      } as BlockState,
    })),
  ];
  const pending = states.filter((p) => p.s.state !== "current");
  const have = states.filter((p) => p.s.state === "current").map((p) => p.path);
  if (pending.length === 0)
    return { ...none, state: "on", files: have, question: null };
  const changed = pending.some((p) => p.s.state === "changed");
  const state = changed ? "changed" : "undecided";
  const asked = pending.map((p) => p.path);
  const question = habitsQuestion(
    pending.map((p) => p.label ?? one(ctx, p.path)),
    // --json goes to an agent that may hand the commands to its user's own shell.
    json ? BUS_CMD : ctx.busCmd,
  );
  if (ctx.stdinIsTTY && ctx.readLine && !json) {
    say(ctx, "", disclosure(ctx, pending));
    // A symlink out of the home (a dotfiles or repo file) needs a typed yes: Enter is no.
    const outside = pending.some(
      (p) => !p.label && linkInfo({ home: ctx.userHome }, p.path)?.outside,
    );
    const a = (
      await ctx.readLine(
        `Add them? ${outside ? "[y/N]" : "[Y/n]"}   (the full block: ${ctx.busCmd} install --show-habits) `,
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
      const pl = setPluginHabits(
        deps(ctx),
        plugins.filter((p) =>
          asked.includes(join(p.dir(ctx.userHome, ctx.env), p.marker)),
        ),
        true,
      );
      if (!changed) setHabitsOptOut(ctx.home, false, stamp(ctx));
      if (r.files.length > 0) say(ctx, `Habits on in ${shown(ctx, r.files)}`);
      for (const p of pl.changed) say(ctx, pluginOn(p));
      for (const n of [...r.notes, ...pl.notes]) say(ctx, n);
      return {
        ...none,
        state: "on",
        files: [...have, ...r.files],
        question: null,
        plugins: pluginStates(ctx),
      };
    }
    if (a === "n" || a === "no") {
      // A first "no" is the user's choice; declining a changed block keeps the old one.
      if (!changed) {
        setHabitsOptOut(ctx.home, true, stamp(ctx));
        const off = setPluginHabits(deps(ctx), plugins, false);
        if (off.incomplete) {
          say(
            ctx,
            "Habits are still on in some places (see below). Your opt-out is saved, so a reinstall won't add them back.",
          );
          for (const n of off.notes) say(ctx, n);
          return { ...none, state: "on", plugins: pluginStates(ctx) };
        }
        say(ctx, "Habits off. A reinstall will not add them back.");
        return { ...none, state: "off", plugins: pluginStates(ctx) };
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
  const { targets, plugins } = wired(ctx);
  if (habitsOptedOut(ctx.home)) return "Habits: off (you opted out)";
  const on = habitsOn(deps(ctx));
  // "Hermes plugin: on" or "off", for each plugin harness in use (wired, or already on).
  const used = PLUGIN_HARNESSES.filter(
    (p) => plugins.includes(p) || pluginHabitsState(deps(ctx), p) === "on",
  );
  const states = used.map((p) => pluginStateText(ctx, p));
  const tail = states.length > 0 ? `; ${states.join("; ")}` : "";
  if (on.length > 0) return `Habits: on in ${shown(ctx, on)}${tail}`;
  if (used.some((p) => pluginHabitsState(deps(ctx), p) === "on"))
    return `Habits: ${states.join("; ")}`;
  if (targets.length > 0 || plugins.length > 0)
    return `Habits: not decided (${ctx.busCmd} install --habits to add them)${tail}`;
  return undefined;
}
