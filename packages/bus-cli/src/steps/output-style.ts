// The "Artifacts Teammate" Claude Code output style (#1970), written to
// <claude config dir>/output-styles/artifacts-teammate.md next to the Claude
// skill, and turned on by setting `outputStyle` in settings.json, but only when
// that key is unset (absent, null or empty): a person's own choice is never replaced. What we did is
// recorded in install.json, and uninstall undoes exactly that, only while the
// value is still the one we set.
//
// Ownership is the skill step's rule: our marker is the line right after the
// closing frontmatter `---`. A file without it is the user's and is never
// replaced or removed. Symlinks (the style file, its folder, settings.json) are
// left alone, never written or deleted through. settings.json is edited with the
// JSONC helpers, so every other byte stays; an unparseable file is not touched.

import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  jsoncValue,
  parseJsonc,
  removeJsoncValue,
  setJsoncValue,
} from "@oa/bus-adapter-mcp-json";
import type { Harness } from "./adapters.ts";
import { writeAtomic } from "./skill.ts";
import { readInstallFile, updateInstallFile } from "./step.ts";

export const OUTPUT_STYLE_FILE = "artifacts-teammate.md";

/** Immediately after the frontmatter: the only file we may replace or remove. */
export const OUTPUT_STYLE_MARKER =
  "<!-- managed by the Open Artifacts bus installer: edits are replaced on reinstall. -->";

/** The style's name in its frontmatter: the value Claude Code's `outputStyle` takes. */
export const OUTPUT_STYLE_NAME = "Artifacts Teammate";

type Where = {
  home: string;
  env?: Record<string, string | undefined>;
  /** Where install.json lives. Without it nothing is remembered, so nothing is turned on. */
  busHome?: string;
};

export const claudeSettingsFile = (w: Where) =>
  join(w.env?.CLAUDE_CONFIG_DIR ?? join(w.home, ".claude"), "settings.json");

type StyleRecord = {
  set?: boolean;
  value?: string;
  /** The key before we set it: absent, null, or the exact empty string. */
  before?:
    | { state: "absent" }
    | { state: "null" }
    | { state: "empty"; value: string };
  createdFile?: boolean;
  file?: string;
};

const readRecord = (busHome: string | undefined): StyleRecord | undefined => {
  if (!busHome) return undefined;
  const r = readInstallFile(join(busHome, "install.json")).outputStyle;
  return typeof r === "object" && r !== null ? (r as StyleRecord) : undefined;
};

const writeRecord = (busHome: string, r: StyleRecord | undefined) =>
  updateInstallFile(join(busHome, "install.json"), { outputStyle: r });

const styleDir = (w: Where) =>
  join(w.env?.CLAUDE_CONFIG_DIR ?? join(w.home, ".claude"), "output-styles");

export const outputStyleFile = (w: Where) =>
  join(styleDir(w), OUTPUT_STYLE_FILE);

/**
 * The shipped text: assets/ next to dist/ in the package, the source file when
 * running from src/. The source is the only copy in the repo; the bundle step
 * copies it unchanged.
 */
export const outputStyleSource = (): string => {
  for (const rel of [
    "../assets/output-styles/artifacts-teammate.md",
    "../../output-style/artifacts-teammate.md",
  ]) {
    const path = fileURLToPath(new URL(rel, import.meta.url));
    if (existsSync(path)) return readFileSync(path, "utf8");
  }
  throw new Error("the Artifacts Teammate output style is missing");
};

const withMarker = (text: string): string => {
  const end = text.startsWith("---\n") ? text.indexOf("\n---\n", 3) : -1;
  if (end === -1) throw new Error("the output style has no frontmatter");
  const at = end + "\n---\n".length;
  return `${text.slice(0, at)}${OUTPUT_STYLE_MARKER}\n${text.slice(at)}`;
};

const isOurs = (text: string): boolean => {
  const m = /^---\n[\s\S]*?\n---\n/.exec(text.replace(/\r\n/g, "\n"));
  return (
    m !== null &&
    text.replace(/\r\n/g, "\n").slice(m[0].length).split("\n", 1)[0] ===
      OUTPUT_STYLE_MARKER
  );
};

const isLink = (path: string) => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

const exists = (path: string) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

export type OutputStyleResult = {
  written: string[];
  notes: string[];
  /** Written for the first time. */
  first?: boolean;
  /** "set": we turned it on in this run. "kept": the person's own choice stays (see `kept`). */
  settings?: "set" | "kept";
  kept?: string;
};

/** What settings.json holds, or why it must not be touched. */
type Settings =
  | { ok: true; text: string | undefined; style: unknown }
  | { ok: false; why: string };

const readSettings = (path: string): Settings => {
  if (isLink(path)) return { ok: false, why: "it is a symlink" };
  if (!exists(path)) return { ok: true, text: undefined, style: undefined };
  try {
    const text = readFileSync(path, "utf8");
    parseJsonc(text, path);
    return { ok: true, text, style: jsoncValue(text, ["outputStyle"]) };
  } catch {
    return { ok: false, why: "it is not valid JSON" };
  }
};

/**
 * Turns the style on when the key is absent. The record is written before the
 * file and dropped again if the file fails, so a change is never unrecorded.
 */
function turnOn(deps: Where, out: OutputStyleResult) {
  const path = claudeSettingsFile(deps);
  const busHome = deps.busHome;
  if (!busHome) return;
  const cur = readSettings(path);
  if (!cur.ok) {
    out.notes.push(
      `Left ${path} alone: ${cur.why}, so the output style was not turned on. Pick it with /output-style.`,
    );
    return;
  }
  // Missing, null and an empty string are no choice. Anything else is the person's.
  const unset =
    cur.style === undefined ||
    cur.style === null ||
    (typeof cur.style === "string" && cur.style.trim() === "");
  if (!unset) {
    if (cur.style !== OUTPUT_STYLE_NAME) {
      out.settings = "kept";
      // Only a real style name is worth saying; "default" or a non-string is the default style.
      if (
        typeof cur.style === "string" &&
        cur.style.toLowerCase() !== "default"
      )
        out.kept = cur.style;
    }
    return;
  }
  // We set it once. If the person took it out since, that is their choice: never again.
  if (readRecord(busHome)?.set) return;
  try {
    writeRecord(busHome, {
      set: true,
      value: OUTPUT_STYLE_NAME,
      before:
        cur.style === undefined
          ? { state: "absent" }
          : cur.style === null
            ? { state: "null" }
            : { state: "empty", value: String(cur.style) },
      createdFile: cur.text === undefined,
      file: path,
    });
    const next =
      cur.text === undefined || cur.text.trim() === ""
        ? createdText()
        : setJsoncValue(cur.text, ["outputStyle"], OUTPUT_STYLE_NAME);
    writeAtomic(path, next);
    out.settings = "set";
  } catch (e) {
    try {
      writeRecord(busHome, undefined);
    } catch {
      // Nothing was recorded.
    }
    out.notes.push(
      `Left ${path} alone: could not edit it (${e instanceof Error ? e.message : String(e)}). Pick the style with /output-style.`,
    );
  }
}

/** Writes the style when Claude Code is wired; a file we do not own is never replaced. */
export function installOutputStyle(
  deps: Where & { text: string },
  harnesses: Harness[],
): OutputStyleResult {
  const out: OutputStyleResult = { written: [], notes: [], first: false };
  if (!harnesses.includes("claude")) return out;
  const dir = styleDir(deps);
  const path = outputStyleFile(deps);
  if (isLink(dir) || isLink(path)) {
    out.notes.push(
      `Left ${isLink(dir) ? dir : path} alone: it is a symlink, so the output style was not written there.`,
    );
    return out;
  }
  try {
    const there = exists(path);
    if (there && !isOurs(readFileSync(path, "utf8"))) {
      out.notes.push(
        `Left ${path} alone: it has no Open Artifacts marker, so it is not ours to replace.`,
      );
      return out;
    }
    writeAtomic(path, withMarker(deps.text));
    out.written.push(path);
    out.first = !there;
  } catch (e) {
    out.notes.push(
      `Could not write ${path}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return out;
  }
  turnOn(deps, out);
  return out;
}

/** What we write when there was no settings.json: a file still equal to this is only ours. */
const createdText = () =>
  `${JSON.stringify({ outputStyle: OUTPUT_STYLE_NAME }, null, 2)}\n`;

/**
 * Puts settings.json back. With our record: only if the value is still ours.
 * Without one (lost or corrupt install.json): the key goes only when it is our
 * exact style name, so the file never points at a style we removed.
 */
function turnOff(deps: Where, out: OutputStyleResult) {
  const busHome = deps.busHome;
  const rec = readRecord(busHome);
  const path = claudeSettingsFile(deps);
  try {
    const cur = readSettings(path);
    if (cur.ok && cur.text !== undefined && cur.style === OUTPUT_STYLE_NAME) {
      // Back to exactly what was there: the key absent, null, or the empty string.
      const was = rec?.set ? rec.before : undefined;
      const next =
        was?.state === "null"
          ? setJsoncValue(cur.text, ["outputStyle"], null)
          : was?.state === "empty"
            ? setJsoncValue(cur.text, ["outputStyle"], was.value)
            : removeJsoncValue(cur.text, ["outputStyle"]);
      // A file we created goes again only while it is byte for byte what we wrote.
      if (rec?.set && rec.createdFile && cur.text === createdText())
        rmSync(path);
      else writeAtomic(path, next);
    }
    if (busHome && rec) writeRecord(busHome, undefined);
  } catch (e) {
    out.notes.push(
      `Left ${path} alone: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/** Removes our marked file (and the folder only if then empty), and undoes what we set. */
export function uninstallOutputStyle(deps: Where): OutputStyleResult {
  const out: OutputStyleResult = { written: [], notes: [] };
  const dir = styleDir(deps);
  const path = outputStyleFile(deps);
  // The setting is undone only once our file is gone: never while a style of
  // that name still exists (a user's own file, a symlink).
  let gone = false;
  try {
    if (isLink(dir) || isLink(path)) {
      out.notes.push(
        `Left ${isLink(dir) ? dir : path} alone: it is a symlink, so the output style was not removed there.`,
      );
    } else if (!exists(path)) {
      gone = true;
    } else if (!isOurs(readFileSync(path, "utf8"))) {
      out.notes.push(
        `Left ${path} alone: it has no Open Artifacts marker, so it is not ours to replace.`,
      );
    } else {
      rmSync(path);
      out.written.push(path);
      gone = true;
      // Never recursive: the folder goes only when nothing else is in it.
      if (readdirSync(dir).length === 0) rmdirSync(dir);
    }
  } catch (e) {
    out.notes.push(
      `Left ${path} alone: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (gone) turnOff(deps, out);
  return out;
}

/** Where our style is installed and whether settings.json selects it; undefined when there is none of ours. */
export const outputStyleState = (
  deps: Where,
): { path: string; on: boolean } | undefined => {
  const path = outputStyleFile(deps);
  try {
    if (isLink(dirname(path)) || isLink(path)) return undefined;
    if (!isOurs(readFileSync(path, "utf8"))) return undefined;
    const s = readSettings(claudeSettingsFile(deps));
    return { path, on: s.ok && s.style === OUTPUT_STYLE_NAME };
  } catch {
    return undefined;
  }
};
