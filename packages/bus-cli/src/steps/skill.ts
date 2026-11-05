// The skill file the bus installer writes next to the tools it wires, one per
// harness (Codex gets a marked block in AGENTS.md instead). The text is always
// fetched from the instance: there is no vendored copy, so a reinstall picks up
// the instance's current skill.
//
// Placement matters: pi and the other harnesses parse frontmatter from the
// first line, so the managed marker goes immediately after the closing `---`,
// never before it. Ownership is read from that marker line.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Harness } from "./adapters.ts";

/** Immediately after the frontmatter: the only file we may replace. */
export const SKILL_MARKER =
  "<!-- managed by the Open Artifacts bus installer: edits are replaced on reinstall. -->";

/** Codex 0.47 has no skills, so its text lives between these whole-line markers. */
export const CODEX_BEGIN =
  "<!-- BEGIN Open Artifacts skill (managed): edits inside are replaced on reinstall. -->";
export const CODEX_END = "<!-- END Open Artifacts skill -->";

/** 256 KB is far more than any served skill; more means the fetch is wrong. */
export const MAX_SKILL_BYTES = 256 * 1024;

export type SkillDeps = {
  /** The user's home: the harness paths under it. */
  home: string;
  env?: Record<string, string | undefined>;
  /** Fetch the skill text. Tests pass a fake, never the network. */
  fetchSkill: (url: string) => Promise<string>;
};

export type SkillResult = {
  written: string[];
  notes: string[];
  /** The URL whose fetch failed: the caller prints it and fails the run. */
  failedUrl?: string;
};

const env = (deps: SkillDeps) => deps.env ?? {};

/** The folder a harness reads skills from, honoring the same env overrides the adapters do. */
export const skillDir = (
  deps: Pick<SkillDeps, "home" | "env">,
  h: Harness,
): string => {
  const e = env(deps);
  const opencode =
    e.OPENCODE_CONFIG_DIR ??
    join(e.XDG_CONFIG_HOME ?? join(deps.home, ".config"), "opencode");
  const piAgent =
    e.PI_CODING_AGENT_DIR ??
    join(e.PI_CODING_AGENT_DIR ?? deps.home, ".pi/agent");
  const ompAgent = join(deps.home, ".agents");
  return {
    claude: join(e.CLAUDE_CONFIG_DIR ?? join(deps.home, ".claude"), "skills"),
    opencode: join(opencode, "skills"),
    pi: join(piAgent, "skills"),
    omp: join(ompAgent, "skills"),
    codex: join(e.CODEX_HOME ?? join(deps.home, ".codex"), "AGENTS.md"),
  }[h];
};

/** The frontmatter's `name`, the folder Agent Skills spec expects. */
export const skillFolder = (text: string): string | undefined => {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  const name = m?.[1]
    ? /^name:\s*"?([^"\n]+)"?\s*$/m.exec(m[1])?.[1]
    : undefined;
  return name && /^[a-z0-9][a-z0-9-]{0,62}$/.test(name) ? name : undefined;
};

/** Split a served skill into its frontmatter block and the rest. */
const withMarker = (text: string): string => {
  const end = text.startsWith("---\n") ? text.indexOf("\n---\n", 3) : -1;
  if (end === -1) return `${text.trimEnd()}\n\n${SKILL_MARKER}\n`;
  const at = end + "\n---\n".length;
  return `${text.slice(0, at)}${SKILL_MARKER}\n${text.slice(at)}`;
};

/** Ours only when the marker line is present. */
const isOurs = (text: string) => text.split("\n").includes(SKILL_MARKER);

/** Follows a symlink: write through it, keep the link. */
const targetOf = (path: string) => {
  try {
    return lstatSync(path).isSymbolicLink() ? realpathSync(path) : path;
  } catch {
    return path;
  }
};

let seq = 0;
/** Writes and cleans up on failure; a write error is a note upstream. */
const writeAtomic = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.oa-${process.pid}-${seq++}.tmp`;
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, path);
  } catch (e) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // Nothing to clean: the temp file was never created.
    }
    throw e;
  }
};

/** The Codex block, whole-line markers only, replaced in place and never doubled. */
export const withCodexBlock = (existing: string, text: string): string => {
  const lines = existing.split("\n");
  const start = lines.indexOf(CODEX_BEGIN);
  const end = lines.indexOf(CODEX_END, start + 1);
  const block = [CODEX_BEGIN, ...text.trimEnd().split("\n"), CODEX_END];
  if (start === -1) {
    const head = existing.trimEnd();
    return `${head}${head ? "\n\n" : ""}${block.join("\n")}\n`;
  }
  if (end === -1) throw new Error("unterminated");
  return [...lines.slice(0, start), ...block, ...lines.slice(end + 1)].join(
    "\n",
  );
};

/** BEGIN without END: leave the file alone and say so. */
const codexBroken = (text: string) => {
  const lines = text.split("\n");
  const start = lines.indexOf(CODEX_BEGIN);
  return start !== -1 && lines.indexOf(CODEX_END, start + 1) === -1;
};

/**
 * Writes the skill for each configured harness. A file without our marker is
 * never replaced; a failed fetch writes nothing and reports the URL.
 */
export async function installSkill(
  deps: SkillDeps,
  origin: string | undefined,
  harnesses: Harness[],
): Promise<SkillResult> {
  const written: string[] = [];
  const notes: string[] = [];
  if (harnesses.length === 0) return { written, notes };
  if (!origin) {
    notes.push(
      "No instance to fetch the skill from: skipped the skill file. Rerun the install once this machine is approved.",
    );
    return { written, notes };
  }
  for (const h of harnesses) {
    const url = `${origin}/skill.md?harness=${h}`;
    let text: string;
    try {
      text = await deps.fetchSkill(url);
    } catch {
      return { written, notes, failedUrl: url };
    }
    const folder = skillFolder(text);
    if (!folder)
      return {
        written,
        notes,
        failedUrl: url,
      };
    const base = skillDir(deps, h);
    const path = h === "codex" ? base : join(base, folder, "SKILL.md");
    const writing = targetOf(path);
    try {
      if (h === "codex") {
        const before = existsSync(writing) ? readFileSync(writing, "utf8") : "";
        if (codexBroken(before)) {
          notes.push(
            `Left ${writing} alone: its Open Artifacts block has no END marker.`,
          );
          continue;
        }
        writeAtomic(writing, withCodexBlock(before, text));
      } else {
        if (existsSync(writing) && !isOurs(readFileSync(writing, "utf8"))) {
          notes.push(
            `Left ${writing} alone: it has no Open Artifacts marker, so it is not ours to replace.`,
          );
          continue;
        }
        writeAtomic(writing, withMarker(text));
      }
      written.push(path);
    } catch (e) {
      notes.push(
        `Could not write ${writing}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return { written, notes };
}

/** Removes our marked files in every harness, and our Codex block, and nothing else. */
export const uninstallSkill = (
  deps: Pick<SkillDeps, "home" | "env">,
  harnesses: Harness[] = ["claude", "opencode", "pi", "omp", "codex"],
): SkillResult => {
  const written: string[] = [];
  const notes: string[] = [];
  for (const h of harnesses) {
    const base = skillDir(deps, h);
    if (h === "codex") {
      if (!existsSync(base)) continue;
      const text = readFileSync(base, "utf8");
      if (codexBroken(text)) {
        notes.push(`Left ${base} alone: its block has no END marker.`);
        continue;
      }
      try {
        const next = withCodexBlock(text, "");
        // An emptied block is no block: drop the markers too.
        const clean = next
          .split("\n")
          .filter((l) => l !== CODEX_BEGIN && l !== CODEX_END)
          .join("\n")
          .trimEnd();
        if (clean) writeAtomic(base, `${clean}\n`);
        else rmSync(base, { force: true });
        written.push(base);
      } catch {
        notes.push(`Left ${base} alone: its block could not be removed.`);
      }
      continue;
    }
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base)) {
      const file = join(base, entry, "SKILL.md");
      if (!existsSync(file)) continue;
      if (!isOurs(readFileSync(targetOf(file), "utf8"))) {
        notes.push(`Left ${file} alone: it has no Open Artifacts marker.`);
        continue;
      }
      rmSync(targetOf(file), { force: true });
      // rmdirSync, never recursive: the folder goes only if we left it empty.
      try {
        rmdirSync(join(base, entry));
      } catch {
        // Another file in there: leave the folder.
      }
      written.push(file);
    }
  }
  return { written, notes };
};
