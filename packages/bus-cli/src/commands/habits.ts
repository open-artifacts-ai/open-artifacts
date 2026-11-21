// The always-on habits flow (#1583): the disclosure on install, and the
// --habits / --no-habits / --show-habits commands. The block itself, and the
// files it goes in, are steps/habits.ts.

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
  PROJECT_HABITS_FILE,
  type ProjectIo,
  pluginHabitsState,
  projectHabitsFileState,
  removeHabits,
  removeProjectHabits,
  setHabitsOptOut,
  setPluginHabits,
  writeHabits,
  writeProjectHabits,
} from "../steps/habits.ts";
import { readInstallFile, updateInstallFile } from "../steps/step.ts";

/** What a person reads once a plugin's habits are on or off. */
export const pluginOn = (p: PluginHarness) =>
  `Habits on in the ${p.label} plugin.`;
export const pluginOff = (p: PluginHarness) =>
  `Habits off in the ${p.label} plugin.`;

export type HabitsMode = "yes" | "no" | "show" | "project" | "project-off";
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
export const pluginStates = (ctx: Ctx): Record<string, PluginHabitsState> =>
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
/**
 * #2966: what the project mode needs from git. Undefined when git is missing or
 * the folder is not a work tree: then nothing is ignored (and nothing is
 * created that would need it, since a tracked file cannot be told apart either,
 * so a git-less folder writes its AGENTS.md and says so).
 */
/**
 * #2966 (Product's call): project habits belong at the top of a git work tree,
 * never in $HOME and never in a folder that is not a repository.
 */
async function isRepoTop(ctx: Ctx): Promise<{ root: string } | "home" | "no"> {
  if (!ctx.which("git")) return "no";
  const r = await ctx
    .exec("git", ["-C", ctx.cwd, "rev-parse", "--show-toplevel"], {
      timeoutMs: 5000,
    })
    .catch(() => undefined);
  if (r?.code !== 0) return "no";
  const root = realpathOr(r.stdout.trim());
  // Never $HOME, even when home is a repository: a block there reaches every
  // project under it through the harnesses that walk parent folders.
  if (root === realpathOr(ctx.userHome)) return "home";
  return { root };
}

/** The harnesses already told "per project is not possible here", per bus home. */
/** Per repository root, the harnesses already told "per project is not possible here". */
const readBlocked = (busHome: string): Record<string, string[]> => {
  const raw = (readInstallFile(join(busHome, "install.json")).habits ?? {}) as {
    projectBlocked?: unknown;
  };
  const out: Record<string, string[]> = {};
  if (typeof raw.projectBlocked === "object" && raw.projectBlocked !== null)
    for (const [root, list] of Object.entries(
      raw.projectBlocked as Record<string, unknown>,
    ))
      if (Array.isArray(list))
        out[root] = list.filter((h): h is string => typeof h === "string");
  return out;
};
const saveBlocked = (busHome: string, map: Record<string, string[]>): void => {
  updateInstallFile(join(busHome, "install.json"), {
    habits: { ...habitsRecord(busHome), projectBlocked: map },
  });
};

/** #2966: the "move them into projects" line is offered once per bus home. */
const habitsRecord = (busHome: string): Record<string, unknown> =>
  (readInstallFile(join(busHome, "install.json")).habits ?? {}) as Record<
    string,
    unknown
  >;
const pluginLineSaid = (busHome: string): boolean =>
  habitsRecord(busHome).pluginLineSaid === true;
const markPluginLineSaid = (busHome: string): void => {
  updateInstallFile(join(busHome, "install.json"), {
    habits: { ...habitsRecord(busHome), pluginLineSaid: true },
  });
};

/** A harness whose project file git tracks: said once per repository. */
const noteBlocked = (
  ctx: Ctx,
  folder: string,
  blocked: HabitsHarness[],
): void => {
  const said = readBlocked(ctx.home);
  const fresh = blocked.filter((h) => !(said[folder] ?? []).includes(h));
  if (fresh.length === 0) return;
  saveBlocked(ctx.home, {
    ...said,
    [folder]: [...(said[folder] ?? []), ...fresh],
  });
  say(
    ctx,
    `${fresh.join(", ")} read this project's AGENTS.md, but git tracks it, so the habits cannot go there without committing them. \`--habits\` adds them for all projects.`,
  );
};

/** #2966: a "no" is this repository's, so another project is still asked. */
const readDeclined = (busHome: string): Record<string, boolean> => {
  const raw = habitsRecord(busHome).projectDeclined;
  const out: Record<string, boolean> = {};
  if (typeof raw === "object" && raw !== null)
    for (const [root, v] of Object.entries(raw as Record<string, unknown>))
      if (v === true) out[root] = true;
  return out;
};
const setDeclined = (busHome: string, root: string, off: boolean): void => {
  const cur = readDeclined(busHome);
  if (off) cur[root] = true;
  else delete cur[root];
  updateInstallFile(join(busHome, "install.json"), {
    habits: { ...habitsRecord(busHome), projectDeclined: cur },
  });
};

const moveOffered = (busHome: string): boolean =>
  habitsRecord(busHome).projectMoveOffered === true;
const markMoveOffered = (busHome: string): void => {
  updateInstallFile(join(busHome, "install.json"), {
    habits: { ...habitsRecord(busHome), projectMoveOffered: true },
  });
};

/** A path as the OS sees it, or as given when it does not exist. */
const realpathOr = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

export async function projectIo(ctx: Ctx): Promise<ProjectIo> {
  if (!ctx.which("git")) return {};
  const git = (args: string[]) =>
    ctx.exec("git", ["-C", ctx.cwd, ...args], { timeoutMs: 5000 });
  const inside = await git(["rev-parse", "--is-inside-work-tree"]).catch(
    () => undefined,
  );
  if (inside?.code !== 0 || inside.stdout.trim() !== "true") return {};
  // The path from the repo root to this folder, so the exclude line matches
  // wherever the command runs (a `/AGENTS.md` line does not cover apps/x).
  const prefixOut = await git(["rev-parse", "--show-prefix"]).catch(
    () => undefined,
  );
  if (prefixOut?.code !== 0) return {};
  const prefix = prefixOut.stdout.trim();
  // The exclude file git actually reads: the common dir, so a linked worktree
  // works too, and info/ may not exist yet.
  const pathOut = await git(["rev-parse", "--git-path", "info/exclude"]).catch(
    () => undefined,
  );
  if (pathOut?.code !== 0) return {};
  const raw = pathOut.stdout.trim();
  const excludeFile = raw.startsWith("/") ? raw : join(ctx.cwd, raw);
  const tracked = new Map<string, boolean>();
  for (const name of new Set(Object.values(PROJECT_HABITS_FILE))) {
    const rel = `${prefix}${name}`;
    const r = await git(["ls-files", "--error-unmatch", "--", rel]).catch(
      () => undefined,
    );
    tracked.set(rel, r?.code === 0);
  }
  return {
    rel: (name) => `${prefix}${name}`,
    tracked: (rel) => tracked.get(rel) === true,
    excludeFile,
    exclude: (line) => {
      let text = "";
      try {
        text = readFileSync(excludeFile, "utf8");
      } catch {
        mkdirSync(dirname(excludeFile), { recursive: true });
      }
      const lines = text.split("\n");
      if (lines.includes(line)) return false;
      const sep = text === "" || text.endsWith("\n") ? "" : "\n";
      writeFileSync(excludeFile, `${text}${sep}${line}\n`);
      return true;
    },
    unexclude: (line) => {
      try {
        const lines = readFileSync(excludeFile, "utf8").split("\n");
        writeFileSync(excludeFile, lines.filter((l) => l !== line).join("\n"));
      } catch {
        // Nothing to take back.
      }
    },
  };
}

/** #2966: writes the habits into this folder's own files, nothing global. */
export async function habitsProject(ctx: Ctx): Promise<HabitsOutcome> {
  const { targets, plugins } = wired(ctx);
  const none: HabitsOutcome = {
    state: "none",
    files: [],
    question: null,
    plugins: pluginStates(ctx),
  };
  if (targets.length === 0) {
    say(
      ctx,
      "No harness here has a project instruction file to put the habits in, so nothing was written. Install a harness first (Claude Code, Codex, pi or OpenCode), then run this again.",
    );
    return none;
  }
  const repo = await isRepoTop(ctx);
  if (repo === "home" || repo === "no") {
    say(
      ctx,
      repo === "home"
        ? "This is your home folder, not a project: habits written here would reach every project under it. Run this at the top of a project instead."
        : "This folder is not inside a git repository, so there is no project to write to. Run this inside a project.",
    );
    return none;
  }
  const io = await projectIo({ ...ctx, cwd: repo.root } as Ctx);
  const r = writeProjectHabits(
    { home: ctx.userHome, env: ctx.env, busHome: ctx.home, cwd: repo.root },
    targets,
    io,
  );
  // #2998 review: plugin habits are machine-wide, which is what #2966 moves
  // away from, so this command never turns them on and never clears the
  // person's own opt-out. It says so when a plugin harness is wired.
  if (plugins.length > 0)
    r.notes.push(
      `The ${plugins.map((p) => p.label).join(", ")} plugin carries the habits machine-wide, so this command leaves it alone. Turn those on or off with ${ctx.busCmd} install --habits and --no-habits.`,
    );
  setDeclined(ctx.home, repo.root, false);
  if (r.files.length > 0)
    say(ctx, `Habits on in this folder: ${shown(ctx, r.files)}`);
  for (const n of r.notes) say(ctx, n);
  return {
    ...none,
    state: r.files.length > 0 ? "on" : "off",
    files: r.files,
    plugins: pluginStates(ctx),
  };
}

/**
 * #2966: turns the habits off in this folder only, and leaves every other
 * project and the global files as they are. The precondition for flipping the
 * install default to per project: without it the only way out is uninstall.
 */
export function habitsProjectOff(ctx: Ctx): number {
  // Real paths on both sides: the same folder through a symlinked path
  // (/tmp vs /private/tmp) is the same folder, and install recorded the other.
  const real = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  const cwd = real(ctx.cwd);
  const r = removeProjectHabits(
    { home: ctx.userHome, env: ctx.env, busHome: ctx.home },
    (path) => dirname(real(path)) === cwd,
  );
  if (r.files.length === 0 && r.notes.length === 0) {
    say(ctx, `No bus habits here to remove in ${tilde(ctx, cwd)}.`);
    return 0;
  }
  if (r.files.length > 0)
    say(ctx, `Habits off in this folder: ${shown(ctx, r.files)}`);
  for (const n of r.notes) say(ctx, n);
  return 0;
}

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
  // #2966 (Product): a plugin's habits are machine-wide, so they are never part
  // of a per-project question. Said once, where to change them.
  if (plugins.length > 0 && !json && !pluginLineSaid(ctx.home)) {
    say(
      ctx,
      `The ${plugins.map((p) => p.label).join(", ")} plugin carries the habits machine-wide; change that with install --habits and --no-habits.`,
    );
    markPluginLineSaid(ctx.home);
  }
  // #2966: ~ is not a project. Writing AGENTS.md there would reach every
  // project under home through pi and the others that walk parent folders.
  const repoTop = await isRepoTop(ctx);
  const folder =
    repoTop === "home" || repoTop === "no" ? ctx.cwd : repoTop.root;
  // A target git tracks is not ours to write; asking for it would be a Yes that
  // does nothing, on every install.
  const io = await projectIo({ ...ctx, cwd: folder } as Ctx);
  const nameOf = (h: HabitsHarness) =>
    io.rel?.(PROJECT_HABITS_FILE[h]) ?? PROJECT_HABITS_FILE[h];
  const writable = targets.filter((h) => io.tracked?.(nameOf(h)) !== true);
  const blocked = targets.filter((h) => io.tracked?.(nameOf(h)) === true);
  // #2966 (Product's call): someone whose global block is already on has
  // decided. Do not ask again in every folder, keep that block fresh, and
  // offer the move to per project once, in words.
  const globalStates = targets.map((h) => habitsFileState(deps(ctx), h));
  const globalPending = globalStates.filter(
    (st) => st.state === "changed" || st.state === "broken",
  );
  const globalOn = globalStates.filter((st) => st.state === "current");
  if (globalOn.length > 0 && globalPending.length === 0) {
    // Decided, on this machine. Offered once, never as part of --json.
    if (!json && !moveOffered(ctx.home)) {
      say(
        ctx,
        "Habits are on for every project on this machine. To keep them in projects only, run install --habits-project in a project and install --no-habits for these global ones.",
      );
      markMoveOffered(ctx.home);
    }
    return {
      ...none,
      state: "on",
      files: globalStates.map((st) => st.path),
      question: null,
    };
  }
  if (globalPending.length > 0) {
    // A changed global block is asked about exactly as before (#2966: keep
    // today's ask), and only a typed yes rewrites it.
    const changedGlobals = targets.filter(
      (h) => habitsFileState(deps(ctx), h).state === "changed",
    );
    if (ctx.stdinIsTTY && ctx.readLine && !json) {
      say(
        ctx,
        "",
        disclosure(
          ctx,
          globalPending.map((st) => ({ path: st.path, s: st as BlockState })),
        ),
      );
      const a = (await ctx.readLine("Update them? [Y/n] "))
        .trim()
        .toLowerCase();
      if (a === "" || a === "y" || a === "yes") {
        writeHabits(deps(ctx), changedGlobals, { explicit: a !== "" });
        say(ctx, "Habits updated for every project on this machine.");
      }
      return {
        ...none,
        state: "changed",
        files: globalStates.map((st) => st.path),
        question: null,
      };
    }
    // No terminal: hand the agent today's hand-off, the global files with the
    // "changed in this release" line, never silence.
    const q = habitsQuestion(
      globalStates.map((st) => one(ctx, st.path)),
      json ? BUS_CMD : ctx.busCmd,
    );
    q.note = `These are for every project on this machine. ${q.note}`;
    return {
      ...none,
      state: "changed",
      files: globalStates.map((st) => st.path),
      question: q,
    };
  }
  if (
    repoTop !== "home" &&
    repoTop !== "no" &&
    readDeclined(ctx.home)[folder]
  ) {
    return { ...none, state: "off", files: [], question: null };
  }
  const states: { path: string; label?: string; s: BlockState }[] = [
    ...writable.map((h) => {
      const st = projectHabitsFileState(folder, h);
      return { path: st.path, s: st as BlockState };
    }),
  ];
  const whyBlocked = (list: HabitsHarness[]) =>
    `${list.join(", ")} read this project's AGENTS.md, but git tracks it, so the habits cannot go there without committing them. \`--habits\` adds them for all projects.`;
  const pending = states.filter((p) => p.s.state !== "current");
  const have = states.filter((p) => p.s.state === "current").map((p) => p.path);
  if (pending.length === 0) {
    if (writable.length === 0 && blocked.length > 0) {
      noteBlocked(ctx, folder, blocked);
      return { ...none, state: "undecided", files: have, question: null };
    }
    return { ...none, state: "on", files: have, question: null };
  }
  const changed = pending.some((p) => p.s.state === "changed");
  const state = changed ? "changed" : "undecided";
  // #2966 (Product's call): only at the top of a git work tree, never $HOME.
  if (repoTop === "home" || repoTop === "no") {
    const why =
      repoTop === "home"
        ? "This is your home folder, not a project: habits written here would reach every project under it. Run the install at the top of a project instead."
        : "This folder is not inside a git repository, so there is no project to write the habits to.";
    if (ctx.stdinIsTTY && ctx.readLine && !json) {
      say(ctx, why);
      return { ...none, state, files: have, question: null };
    }
    // No terminal: say why, and hand out no question, since a Yes here would
    // only refuse.
    say(ctx, why);
    return { ...none, state, files: have, question: null };
  }
  const asked = pending.map((p) => p.path);
  const question = habitsQuestion(
    pending.map((p) => p.label ?? one(ctx, p.path)),
    // --json goes to an agent that may hand the commands to its user's own shell.
    json ? BUS_CMD : ctx.busCmd,
  );
  if (blocked.length > 0) {
    const said = readBlocked(ctx.home);
    const root = folder;
    const fresh = blocked.filter((h) => !(said[root] ?? []).includes(h));
    if (fresh.length > 0) {
      question.note = `${whyBlocked(fresh)} ${question.note}`;
      saveBlocked(ctx.home, {
        ...said,
        [root]: [...(said[root] ?? []), ...fresh],
      });
    }
  }
  if (plugins.length > 0)
    question.note = `${question.note} The ${plugins
      .map((p) => p.label)
      .join(
        ", ",
      )} plugin carries them machine-wide; change that with install --habits and --no-habits.`;
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
      const r = writeProjectHabits(
        { home: ctx.userHome, env: ctx.env, busHome: ctx.home, cwd: folder },
        writable.filter((h) =>
          asked.includes(projectHabitsFileState(folder, h).path),
        ),
        io,
      );
      // #2966/#2998: plugin habits are machine-wide, so a yes to "this project
      // only" must not turn them on. Said, not done.
      const pl = { changed: [], notes: [], pluginFiles: [], incomplete: false };
      if (!changed) setDeclined(ctx.home, folder, false);
      if (r.files.length > 0) say(ctx, `Habits on in ${shown(ctx, r.files)}`);
      // Product's call: the plugin harnesses are machine-wide, so a yes that
      // means "this project only" does not touch them.
      if (plugins.length > 0)
        say(
          ctx,
          `The ${plugins.map((p) => p.label).join(", ")} plugin carries the habits machine-wide, so it was left as it is. Change it with install --habits and --no-habits.`,
        );
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
      // #2966 (Product): No is this project's answer. Another project is still
      // asked, and the plugins (machine-wide) are left alone; only
      // `--no-habits` turns them off everywhere and stops the question.
      if (!changed) {
        setDeclined(ctx.home, folder, true);
        say(
          ctx,
          "Habits stay off in this project. Other projects will still be asked; install --no-habits turns them off everywhere and never asks again.",
        );
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
export async function habitsCommand(
  mode: HabitsMode,
  ctx: Ctx,
): Promise<number> {
  say(ctx, ctx.copy.header(ctx.version), "");
  if (mode === "show") return show(ctx);
  if (mode === "project-off") return habitsProjectOff(ctx);
  if (mode === "project") {
    // #2966: the per-folder install. Awaited, so its work cannot be cut off
    // and a failure is not reported as success.
    try {
      const r = await habitsProject(ctx);
      return r.files.length > 0 || r.state === "on" ? 0 : 1;
    } catch (e) {
      sayErr(ctx, `Could not set up the habits here: ${String(e)}`);
      return 1;
    }
  }
  return mode === "yes" ? turnOn(ctx) : turnOff(ctx);
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
