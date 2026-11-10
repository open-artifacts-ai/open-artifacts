// The "Artifacts Teammate" Claude Code output style (#1970), written to
// <claude config dir>/output-styles/artifacts-teammate.md next to the Claude
// skill. Never made the active style and settings.json is never touched: the
// user picks it with /output-style.
//
// Ownership is the skill step's rule: our marker is the line right after the
// closing frontmatter `---`. A file without it is the user's and is never
// replaced or removed. Symlinks (the file or the folder) are left alone, never
// written or deleted through.

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
import type { Harness } from "./adapters.ts";
import { writeAtomic } from "./skill.ts";

export const OUTPUT_STYLE_FILE = "artifacts-teammate.md";

/** Immediately after the frontmatter: the only file we may replace or remove. */
export const OUTPUT_STYLE_MARKER =
  "<!-- managed by the Open Artifacts bus installer: edits are replaced on reinstall. -->";

type Where = { home: string; env?: Record<string, string | undefined> };

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
  /** Written for the first time: the caller says how to turn it on. */
  first?: boolean;
};

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
  }
  return out;
}

/** Removes our marked file, and the folder only if it is then empty. */
export function uninstallOutputStyle(deps: Where): OutputStyleResult {
  const out: OutputStyleResult = { written: [], notes: [] };
  const dir = styleDir(deps);
  const path = outputStyleFile(deps);
  try {
    if (isLink(dir) || isLink(path)) {
      if (exists(path) || isLink(path))
        out.notes.push(
          `Left ${isLink(dir) ? dir : path} alone: it is a symlink.`,
        );
      return out;
    }
    if (!exists(path)) return out;
    if (!isOurs(readFileSync(path, "utf8"))) {
      out.notes.push(
        `Left ${path} alone: it is not an Open Artifacts output style.`,
      );
      return out;
    }
    rmSync(path);
    out.written.push(path);
    // Never recursive: the folder goes only when nothing else is in it.
    if (readdirSync(dir).length === 0) rmdirSync(dir);
  } catch (e) {
    out.notes.push(
      `Left ${path} alone: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return out;
}

/** Where our style is installed, or undefined when there is none of ours. */
export const outputStyleState = (deps: Where): string | undefined => {
  const path = outputStyleFile(deps);
  try {
    return !isLink(dirname(path)) &&
      !isLink(path) &&
      isOurs(readFileSync(path, "utf8"))
      ? path
      : undefined;
  } catch {
    return undefined;
  }
};
