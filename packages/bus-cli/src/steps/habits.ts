// Bus habits (#1583, #3043): the bus now sends its rules to sessions directly,
// so nothing is written to harness instruction files or plugin folders. This
// module only removes old managed blocks and leftover plugin markers left by
// earlier installs, and handles the opt-out.
//
// Legacy block and marker locations, by harness:
//   claude    $CLAUDE_CONFIG_DIR/CLAUDE.md, else ~/.claude/CLAUDE.md
//   codex     $CODEX_HOME/AGENTS.override.md and AGENTS.md
//   pi        <agent dir>/AGENTS.override.md and AGENTS.md
//   opencode  $OPENCODE_CONFIG_DIR, else $XDG_CONFIG_HOME/opencode, else
//             ~/.config/opencode, then AGENTS.md
//   hermes    legacy plugin folder's habits.on marker (PLUGIN_HARNESSES below)
//   openclaw  legacy plugin folder's habits.on marker (PLUGIN_HARNESSES below)

import { existsSync, lstatSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { codexHome } from "./codex.ts";
import {
  HERMES_HABITS_MARKER,
  hermesPluginDir,
  hermesPluginDirs,
  hermesProfilesScan,
  pluginState,
} from "./hermes.ts";
import {
  OPENCLAW_HABITS_MARKER,
  openclawManifestIsOurs,
  openclawPluginDir,
  openclawPluginDirs,
  openclawPluginState,
} from "./openclaw.ts";
import { brokenLink, lineIndex, targetOf, writeAtomic } from "./skill.ts";
import { readInstallFile, updateInstallFile } from "./step.ts";

type Env = Record<string, string | undefined>;

/** The harnesses whose always-on instruction files older installs wrote to. */
export type HabitsHarness = "claude" | "codex" | "pi" | "opencode";
export const HABITS_HARNESSES: HabitsHarness[] = [
  "claude",
  "codex",
  "pi",
  "opencode",
];

export const HABITS_BEGIN =
  "<!-- BEGIN Open Artifacts bus habits (managed). Written by `oa-bus install`; replaced on reinstall.";
export const HABITS_END = "<!-- END Open Artifacts bus habits -->";

/** PI_CODING_AGENT_DIR as pi reads it (`~` expanded), else ~/.pi/agent. */
const piAgentDir = (home: string, env: Env): string => {
  const d = env.PI_CODING_AGENT_DIR;
  if (!d) return join(home, ".pi", "agent");
  if (d === "~") return home;
  return resolve(d.startsWith("~/") ? join(home, d.slice(2)) : d);
};

/** Every file an older install's block may live in for `h`. */
export function habitsFiles(
  deps: { home: string; env?: Env },
  h: HabitsHarness,
): string[] {
  const env = deps.env ?? {};
  const pair = (dir: string) => {
    const override = join(dir, "AGENTS.override.md");
    const plain = join(dir, "AGENTS.md");
    return existsSync(override) ? [override, plain] : [plain, override];
  };
  switch (h) {
    case "claude":
      return [
        join(env.CLAUDE_CONFIG_DIR ?? join(deps.home, ".claude"), "CLAUDE.md"),
      ];
    case "codex":
      return pair(codexHome(deps.home, env));
    case "pi":
      return pair(piAgentDir(deps.home, env));
    case "opencode":
      return [
        join(
          env.OPENCODE_CONFIG_DIR ??
            join(env.XDG_CONFIG_HOME ?? join(deps.home, ".config"), "opencode"),
          "AGENTS.md",
        ),
      ];
  }
}

const cr = (s: string) => s.replace(/\r$/, "");

type Span = { start: number; end: number };

/** Where our block sits in `lines`; `broken` when BEGIN has no END. */
const spanOf = (lines: string[]): Span | "broken" | undefined => {
  const start = lineIndex(lines, HABITS_BEGIN);
  if (start === -1) return undefined;
  const end = lineIndex(lines, HABITS_END, start + 1);
  return end === -1 ? "broken" : { start, end };
};

/** What an older install put between the file's own text and our block: exact undo needs it. */
export const separatorFor = (existing: string): string => {
  if (existing === "") return "";
  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  let sep = "";
  if (!existing.endsWith("\n")) sep += eol;
  if (!/\n\r?\n$/.test(existing + sep)) sep += eol;
  return sep;
};

/**
 * `existing` with our block removed. Bytes outside the markers are kept.
 * Throws "unterminated" when BEGIN has no END. Takes `added`, the separator
 * an older install wrote with the block, and undoes exactly it; without it a
 * trailing blank line is dropped.
 */
export function withoutHabits(existing: string, added?: string): string {
  const lines = existing.split("\n");
  const span = spanOf(lines);
  if (span === "broken") throw new Error("unterminated");
  if (span === undefined) return existing;
  let before = lines.slice(0, span.start);
  const after = lines.slice(span.end + 1);
  const atEnd = after.every((l) => l === "");
  if (added !== undefined) {
    const head = before.length > 0 ? `${before.join("\n")}\n` : "";
    const out = head + after.join("\n");
    return atEnd && added !== "" && head.endsWith(added)
      ? head.slice(0, head.length - added.length) + after.join("\n")
      : out;
  }
  // No record: a removed block at the end takes one separating blank line with it.
  if (
    atEnd &&
    before.length > 0 &&
    cr(before[before.length - 1] as string) === ""
  )
    before = before.slice(0, -1);
  return [...before, ...after].join("\n");
}

const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** `busHome` is where install.json lives; without it nothing is remembered. */
export type HabitsDeps = { home: string; env?: Env; busHome?: string };
export type HabitsResult = {
  files: string[];
  notes: string[];
  /** removeHabits: the plugin harnesses whose marker was removed, and each marker path (also in `files`). */
  plugins?: PluginHarness[];
  pluginFiles?: string[];
  /** removeHabits: a plugin marker may still be on (unreachable, unremovable, behind a symlink). */
  incomplete?: boolean;
};

const isLink = (path: string): boolean => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

/** What an older installer remembered about a file it wrote the block into. */
type FileRecord = { added: string; created: boolean };

const record = (busHome: string | undefined) => {
  const raw = busHome
    ? readInstallFile(join(busHome, "install.json")).habits
    : undefined;
  const h = (typeof raw === "object" && raw !== null ? raw : {}) as {
    optedOut?: boolean;
    at?: string;
    files?: Record<string, FileRecord>;
    pluginDirs?: unknown;
    project?: unknown;
  };
  return {
    optedOut: h.optedOut === true,
    at: h.at,
    files: h.files ?? {},
    pluginDirs: pluginDirsOf(h.pluginDirs),
    // #2966: legacy per-project blocks, and the exclude lines added for them.
    project: projectOf(h.project),
  };
};

/** The plugin folders the marker was written into, by harness; an old or odd record has none. */
const pluginDirsOf = (v: unknown): Record<string, string[]> => {
  const out: Record<string, string[]> = {};
  if (typeof v !== "object" || v === null || Array.isArray(v)) return out;
  for (const [name, list] of Object.entries(v))
    if (Array.isArray(list))
      out[name] = list.filter((d): d is string => typeof d === "string");
  return out;
};

const saveRecord = (
  busHome: string | undefined,
  patch: {
    optedOut?: boolean;
    at?: string;
    files?: Record<string, FileRecord>;
    pluginDirs?: Record<string, string[]>;
    project?: ProjectRecord;
  },
) => {
  if (!busHome) return;
  const cur = record(busHome);
  updateInstallFile(join(busHome, "install.json"), {
    habits: { ...cur, ...patch },
  });
};

/** One line an older install added to a repository's exclude file. */
export type ExcludeEntry = {
  file: string;
  line: string;
  /** The project file it was added for. */
  for?: string;
};

type ProjectRecord = {
  files: Record<string, FileRecord>;
  /** Per repository file, so a line the person had is never taken away. */
  exclude: ExcludeEntry[];
};

/** The project slice of the record, tolerating an older shape. */
const projectOf = (v: unknown): ProjectRecord => {
  const p = (typeof v === "object" && v !== null ? v : {}) as {
    files?: Record<string, FileRecord>;
    exclude?: unknown;
  };
  const exclude: ExcludeEntry[] = [];
  if (Array.isArray(p.exclude))
    for (const e of p.exclude)
      if (
        typeof e === "object" &&
        e !== null &&
        typeof (e as ExcludeEntry).file === "string" &&
        typeof (e as ExcludeEntry).line === "string"
      )
        exclude.push({
          file: (e as ExcludeEntry).file,
          line: (e as ExcludeEntry).line,
          ...(typeof (e as ExcludeEntry).for === "string"
            ? { for: (e as ExcludeEntry).for }
            : {}),
        });
  return { files: p.files ?? {}, exclude };
};

/**
 * #2966: takes back exactly what the record says an older install wrote, in
 * every project it ran in: our block, a file it created, and the exclude lines
 * it added. Nothing else, and nothing that is not recorded.
 */
export function removeProjectHabits(
  deps: HabitsDeps,
  only?: (path: string) => boolean,
): HabitsResult {
  const files: string[] = [];
  const notes: string[] = [];
  const cur = record(deps.busHome).project;
  const kept = { ...cur.files };
  const exclude = [...cur.exclude];
  /** The files whose block actually came out: only their exclude line goes. */
  const cleaned = new Set<string>();
  for (const [path, rec] of Object.entries(cur.files)) {
    if (only !== undefined && !only(path)) continue;
    try {
      // Nothing of ours is in that file any more: the person removed it, or
      // the block with it. Its exclude line goes too, or it would hide a file
      // they create later.
      if (brokenLink(path) || !existsSync(path) || isLink(path)) {
        delete kept[path];
        cleaned.add(path);
        continue;
      }
      const before = readFileSync(path, "utf8");
      if (spanOf(before.split("\n")) === undefined) {
        delete kept[path];
        cleaned.add(path);
        continue;
      }
      const after = withoutHabits(before, rec?.added);
      if (rec?.created && after.trim() === "") rmSync(path, { force: true });
      else writeAtomic(path, after);
      delete kept[path];
      cleaned.add(path);
      files.push(path);
    } catch (e) {
      notes.push(
        e instanceof Error && e.message === "unterminated"
          ? `Left ${path} alone: its Open Artifacts habits block has no END marker. Fix or remove the block.`
          : `Could not update ${path}: ${reason(e)}`,
      );
    }
  }
  // The exclude lines last: only the exact ones we recorded, from their own
  // files, and only for the files this call is about.
  for (const e of [...exclude]) {
    if (only !== undefined && (e.for === undefined || !only(e.for))) continue;
    // A block left alone (no END marker, unreadable) keeps its line: the file
    // still holds habits, so it must stay out of git's way.
    if (e.for !== undefined && !cleaned.has(e.for)) continue;
    try {
      const text = readFileSync(e.file, "utf8");
      const lines = text.split("\n");
      if (!lines.includes(e.line)) {
        exclude.splice(exclude.indexOf(e), 1);
        continue;
      }
      // Never remove git's own exclude file, even when the line was the last.
      writeAtomic(e.file, lines.filter((l) => l !== e.line).join("\n"));
      exclude.splice(exclude.indexOf(e), 1);
    } catch {
      // Gone, or not ours to write: nothing to take back.
      exclude.splice(exclude.indexOf(e), 1);
    }
  }
  if (deps.busHome && existsSync(join(deps.busHome, "install.json")))
    saveRecord(deps.busHome, { project: { files: kept, exclude } });
  return { files, notes };
}

/**
 * Removes our block from every file a harness may have it in, restoring the
 * file's own bytes. A file goes only when install created it and it is not a link.
 * Set `opts.plugins` to `false` to leave the Hermes/OpenClaw plugin markers alone.
 */
export function removeHabits(
  deps: HabitsDeps,
  harnesses: HabitsHarness[] = HABITS_HARNESSES,
  opts: { plugins?: boolean } = {},
): HabitsResult {
  const files: string[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();
  const kept = { ...record(deps.busHome).files };
  const visit = (path: string) => {
    if (seen.has(path)) return;
    seen.add(path);
    try {
      if (brokenLink(path) || !existsSync(path)) {
        delete kept[path];
        return;
      }
      const real = targetOf(path);
      const before = readFileSync(real, "utf8");
      if (spanOf(before.split("\n")) === undefined) {
        delete kept[path];
        return;
      }
      const rec = kept[path];
      const after = withoutHabits(before, rec?.added);
      if (rec?.created && !isLink(path) && after.trim() === "")
        rmSync(real, { force: true });
      else writeAtomic(real, after);
      delete kept[path];
      files.push(path);
    } catch (e) {
      notes.push(
        e instanceof Error && e.message === "unterminated"
          ? `Left ${path} alone: its Open Artifacts habits block has no END marker. Fix or remove the block.`
          : `Could not update ${path}: ${reason(e)}`,
      );
    }
  };
  for (const h of harnesses) {
    for (const path of habitsFiles(deps, h)) visit(path);
  }
  for (const path of Object.keys(kept)) visit(path);
  let p:
    | {
        changed: PluginHarness[];
        notes: string[];
        markers: string[];
        incomplete: boolean;
      }
    | undefined;
  if (opts.plugins !== false) {
    // Plugin harnesses have no instruction file above: any legacy marker goes here (also on uninstall).
    p = removePluginHabits(deps, PLUGIN_HARNESSES);
    files.push(...p.markers);
    notes.push(...p.notes);
  }
  // Uninstall must not create a record in a folder that has none (it would make
  // a foreign OA_BUS_HOME look like ours to --purge).
  if (deps.busHome && existsSync(join(deps.busHome, "install.json")))
    saveRecord(deps.busHome, { files: kept });
  return {
    files,
    notes,
    ...(p
      ? {
          plugins: p.changed,
          pluginFiles: p.markers,
          incomplete: p.incomplete,
        }
      : {}),
  };
}

/**
 * #3043: removes old managed habit blocks from every global harness file and
 * every recorded per-project file, without touching the Hermes/OpenClaw plugin
 * markers.
 */
export function removeHabitsBlocks(deps: HabitsDeps): {
  files: string[];
  notes: string[];
} {
  const global = removeHabits(deps, HABITS_HARNESSES, { plugins: false });
  const project = removeProjectHabits(deps);
  return {
    files: [...new Set([...global.files, ...project.files])],
    notes: [...global.notes, ...project.notes],
  };
}

/**
 * Harnesses whose bus is a plugin with its own folder: earlier installs wrote
 * a `habits.on` marker in `dir`. Current versions ask the daemon for habits
 * over IPC, so only cleanup of leftover markers remains here.
 */
export type PluginHarness = {
  /** The key in checkAdapters' result. */
  name: "hermes" | "openclaw";
  /** As shown to the user. */
  label: string;
  dir: (home: string, env: Env) => string;
  /** Every folder the plugin may be in, across profiles: cleanup sweeps them all. */
  dirs: (home: string, env: Env) => string[];
  /** What reading the folder `dirs` walks through said; unread means profiles went unswept. */
  scan?: (home: string, env: Env) => { note?: string; incomplete: boolean };
  marker: string;
  /** Whether `dir` is our plugin folder (it carries our ownership marker). */
  ours: (dir: string) => boolean;
  /** Cleanup only: a looser test, since deleting the one marker file there is harmless. */
  offOurs?: (dir: string) => boolean;
};
export const PLUGIN_HARNESSES: PluginHarness[] = [
  {
    name: "hermes",
    label: "Hermes",
    dir: hermesPluginDir,
    dirs: hermesPluginDirs,
    scan: hermesProfilesScan,
    marker: HERMES_HABITS_MARKER,
    ours: (dir) => pluginState(dir, undefined) !== "foreign" && !isLink(dir),
  },
  {
    name: "openclaw",
    label: "OpenClaw",
    dir: openclawPluginDir,
    dirs: openclawPluginDirs,
    marker: OPENCLAW_HABITS_MARKER,
    ours: (dir) =>
      openclawPluginState(dir, undefined) !== "foreign" && !isLink(dir),
    // An install cut short can leave our manifest and no ownership marker.
    offOurs: (dir) =>
      (openclawPluginState(dir, undefined) !== "foreign" ||
        openclawManifestIsOurs(dir)) &&
      !isLink(dir),
  },
];

/**
 * Removes any leftover legacy `habits.on` marker from each given plugin's
 * folders (never writes one). Only touches folders that are ours; a symlinked
 * marker is unlinked without following, and a symlinked folder is left alone
 * with a note.
 */
export function removePluginHabits(
  deps: { home: string; env?: Env; busHome?: string },
  plugins: PluginHarness[] = PLUGIN_HARNESSES,
): {
  changed: PluginHarness[];
  notes: string[];
  markers: string[];
  /** A marker may still be there (unreachable, unremovable or behind a symlink). */
  incomplete: boolean;
} {
  const changed: PluginHarness[] = [];
  const notes: string[] = [];
  const markers: string[] = [];
  let incomplete = false;
  for (const p of plugins) {
    // Every profile's folder, and every folder a marker was recorded in by an
    // earlier install (the env that chose it may be gone), so none is left behind.
    const recorded = record(deps.busHome).pluginDirs[p.name] ?? [];
    const dirs = [
      ...new Set([...p.dirs(deps.home, deps.env ?? {}), ...recorded]),
    ];
    // Recorded folders whose marker is now verified gone: the only ones forgotten.
    const done = new Set<string>();
    const left = (msg: string) => {
      notes.push(msg);
      incomplete = true;
    };
    const scan = p.scan?.(deps.home, deps.env ?? {});
    if (scan?.note !== undefined) {
      if (scan.incomplete) left(scan.note);
      else notes.push(scan.note);
    }
    for (const dir of dirs) {
      const marker = join(dir, p.marker);
      const d = probe(dir);
      // Absent stays listed: an unmounted volume reads as absent too.
      if (d.k === "absent") continue;
      if (d.k === "error") {
        left(
          `Couldn't reach the ${p.label} plugin folder ${dir} (${d.code}), so its habits may still be on there.`,
        );
        continue;
      }
      if (d.k === "file") {
        done.add(dir);
        continue;
      }
      // Looked at before ownership: an unreadable folder must not read as "not ours".
      // Through a symlink the path resolves to what is behind it.
      const m = probe(marker);
      if (m.k === "error") {
        left(
          `Couldn't reach ${marker} (${m.code}), so ${p.label} habits may still be on there.`,
        );
        continue;
      }
      // Nothing there, or a folder: no marker file to remove.
      if (m.k === "absent" || m.k === "dir") {
        done.add(dir);
        continue;
      }
      if (d.k === "link") {
        left(
          `Left the ${p.label} plugin alone: ${dir} is a symlink, so its habits may still be on. To turn them off, delete ${dir}/${p.marker}.`,
        );
        continue;
      }
      // Not a folder of ours: nothing of ours is there to remove.
      if (!(p.offOurs ?? p.ours)(dir)) {
        done.add(dir);
        continue;
      }
      try {
        rmSync(marker, { force: true });
      } catch (e) {
        left(
          `Could not remove ${marker} (${reason(e)}): ${p.label} habits are still on there. Delete it, then rerun.`,
        );
        continue;
      }
      if (probe(marker).k !== "absent") {
        left(
          `Could not remove ${marker}: ${p.label} habits are still on there. Delete it, then rerun.`,
        );
        continue;
      }
      markers.push(marker);
      done.add(dir);
      if (!changed.includes(p)) changed.push(p);
    }
    // Forget only what is verified gone. Never creates a record that is not there.
    if (deps.busHome && existsSync(join(deps.busHome, "install.json"))) {
      const { pluginDirs } = record(deps.busHome);
      const had = pluginDirs[p.name];
      if (had !== undefined) {
        const kept = had.filter((d) => !done.has(d));
        const { [p.name]: _old, ...rest } = pluginDirs;
        if (kept.length !== had.length)
          saveRecord(deps.busHome, {
            pluginDirs: kept.length > 0 ? { ...rest, [p.name]: kept } : rest,
          });
      }
    }
  }
  return { changed, notes, markers, incomplete };
}

type Probe =
  | { k: "absent" | "link" | "dir" | "file" }
  | { k: "error"; code: string };

/** What is at `path`, telling "not there" apart from "cannot look" (EACCES, EIO). */
const probe = (path: string): Probe => {
  try {
    const st = lstatSync(path);
    return {
      k: st.isSymbolicLink() ? "link" : st.isDirectory() ? "dir" : "file",
    };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? "error";
    return code === "ENOENT" || code === "ENOTDIR"
      ? { k: "absent" }
      : { k: "error", code };
  }
};

/** The opt-out lives in the install record, so a reinstall keeps it. */
export const habitsOptedOut = (busHome: string): boolean =>
  record(busHome).optedOut;

export const setHabitsOptOut = (
  busHome: string,
  optedOut: boolean,
  at: string,
): void => saveRecord(busHome, { optedOut, at });
