// Bus habits (#1583, #3043): the bus sends its rules to sessions directly,
// never writing to harness instruction files. This module handles --habits,
// --no-habits, --show-habits, old-block cleanup on install, and the status line.

import { BRIEF_RULES } from "@oa/bus-protocol";
import { type Ctx, say } from "../context.ts";
import {
  habitsOptedOut,
  type PluginHarness,
  removeHabits,
  removeHabitsBlocks,
  removePluginHabits,
  removeProjectHabits,
  setHabitsOptOut,
} from "../steps/habits.ts";

/** What a person reads once a legacy plugin marker is removed on --no-habits. */
export const pluginOff = (p: PluginHarness) =>
  `Habits off in the ${p.label} plugin.`;

export const HABITS_MOVED_LINE = (n: number): string =>
  `Bus habits now come with the bus; removed the old block from ${n === 1 ? "1 file" : `${n} files`}.`;

export type HabitsMode = "yes" | "no" | "show";

const deps = (ctx: Ctx) => ({
  home: ctx.userHome,
  env: ctx.env,
  busHome: ctx.home,
});

const stamp = (ctx: Ctx) => new Date(ctx.now()).toISOString();

/**
 * #3043: removes old managed habit blocks from global and recorded per-project
 * instruction files. Prints one line when at least one file was cleaned, plus
 * any notes for blocks that could not be removed. Never asks anything.
 */
export function removeOldHabits(
  ctx: Ctx,
  pre?: { files: string[]; notes: string[] },
): number {
  const r = pre ?? removeHabitsBlocks(deps(ctx));
  const n = r.files.length;
  if (n > 0) say(ctx, HABITS_MOVED_LINE(n));
  for (const note of r.notes) say(ctx, note);
  return n;
}

/** `--show-habits`: prints BRIEF_RULES verbatim, nothing else. */
const show = (ctx: Ctx): number => {
  ctx.stdout.write(BRIEF_RULES);
  return 0;
};

/** `--habits`: clear the opt-out, remove old file blocks and any leftover plugin markers. */
function turnOn(ctx: Ctx): number {
  setHabitsOptOut(ctx.home, false, stamp(ctx));
  const removed = removeHabitsBlocks(deps(ctx));
  removePluginHabits(deps(ctx));
  say(
    ctx,
    "Habits: on, sent by the bus. Nothing is written to your instruction files.",
    ...(removed.files.length > 0
      ? [HABITS_MOVED_LINE(removed.files.length)]
      : []),
  );
  for (const n of removed.notes) say(ctx, n);
  return 0;
}

/** `--no-habits`: opt out of bus-sent rules, remove old file blocks and leftover plugin markers. */
function turnOff(ctx: Ctx): number {
  const r = removeHabits(deps(ctx));
  const proj = removeProjectHabits(deps(ctx));
  setHabitsOptOut(ctx.home, true, stamp(ctx));
  const pluginFiles = r.pluginFiles ?? [];
  const blocks = [
    ...new Set([
      ...r.files.filter((f) => !pluginFiles.includes(f)),
      ...proj.files,
    ]),
  ];
  const offIn = r.plugins ?? [];
  const notes = [...r.notes, ...proj.notes];
  if (r.incomplete) {
    // Never "Habits off" while a legacy plugin marker may still be on.
    say(
      ctx,
      ...(blocks.length > 0 ? [HABITS_MOVED_LINE(blocks.length)] : []),
      "Habits are still on in some places (see below). Your opt-out is saved, so the bus won't send its rules to your sessions.",
    );
    for (const p of offIn) say(ctx, pluginOff(p));
    for (const n of notes) say(ctx, n);
    return 1;
  }
  say(
    ctx,
    `Habits off: the bus won't send its rules to your sessions. ${ctx.busCmd} install --habits turns them back on.`,
    ...(blocks.length > 0 ? [HABITS_MOVED_LINE(blocks.length)] : []),
  );
  for (const p of offIn) say(ctx, pluginOff(p));
  for (const n of notes) say(ctx, n);
  return 0;
}

/** `install --habits | --no-habits | --show-habits`: only the habits setting, nothing else reruns. */
export async function habitsCommand(
  mode: HabitsMode,
  ctx: Ctx,
): Promise<number> {
  if (mode === "show") return show(ctx);
  say(ctx, ctx.copy.header(ctx.version), "");
  return mode === "yes" ? turnOn(ctx) : turnOff(ctx);
}

/** The status and doctor line: always on (sent by the bus) or off (you opted out). */
export function habitsLine(ctx: Ctx): string {
  return habitsOptedOut(ctx.home)
    ? "Habits: off (you opted out)"
    : "Habits: on, sent by the bus";
}
