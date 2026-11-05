// The skill file the bus installer writes next to the tools it wires, one per
// harness (Codex gets a marked block in AGENTS.md instead). The text is always
// fetched from the instance: there is no vendored copy, so a reinstall picks up
// the instance's current skill. One source of the paths and names:
// `harnessSkills` in @oa/shared, the same table `/skill.md?harness=` renders from.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { BUS_CMD } from "@oa/bus-ipc";
import { harnessSkills, type Harness as SkillHarness } from "@oa/shared";
import type { Harness } from "./adapters.ts";

/** First line of every file we write: the only file we are allowed to replace. */
export const SKILL_HEADER =
  "<!-- Managed by the Open Artifacts bus installer: rerun it to refresh, edits are replaced. -->";

/** Codex 0.47 has no skills, so its text lives between these markers. */
export const CODEX_BEGIN =
  "<!-- BEGIN Open Artifacts skill (managed by the bus installer): edits inside are replaced on reinstall. -->";
export const CODEX_END = "<!-- END Open Artifacts skill -->";

export const RERUN = `${BUS_CMD} install`;

export type SkillDeps = {
  /** The user's home: the harness paths under it. */
  home: string;
  env?: Record<string, string | undefined>;
  /** Fetch the skill text; tests pass a fake, never the network. */
  fetchSkill: (url: string) => Promise<string>;
};

export type SkillResult = {
  written: string[];
  notes: string[];
  /** The URL whose fetch failed: the caller prints it and exits non-zero. */
  failedUrl?: string;
};

const expand = (home: string, p: string) =>
  p.startsWith("~/") ? join(home, p.slice(2)) : p;

/** The skill path for a harness, with `~` resolved against the user's home. */
export const skillPathFor = (
  deps: Pick<SkillDeps, "home">,
  h: Harness,
): string => expand(deps.home, harnessSkills[h as SkillHarness].skillPath);

const withHeader = (text: string) => `${SKILL_HEADER}\n\n${text.trimEnd()}\n`;

/** The marked block, replacing an existing one in place and never duplicating. */
export const withCodexBlock = (existing: string, text: string): string => {
  const block = `${CODEX_BEGIN}\n${text.trimEnd()}\n${CODEX_END}`;
  const start = existing.indexOf(CODEX_BEGIN);
  if (start === -1) {
    const head = existing.trimEnd();
    return `${head}${head ? "\n\n" : ""}${block}\n`;
  }
  const endAt = existing.indexOf(CODEX_END, start);
  const end = endAt === -1 ? existing.length : endAt + CODEX_END.length;
  return `${existing.slice(0, start)}${block}${existing.slice(end)}`;
};

const writeAtomic = (file: string, text: string) => {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.oa-tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
};

/**
 * Writes the skill for each configured harness. A file without our header is
 * never replaced: it is someone else's, and the note says so. A failed fetch
 * stops the skill step (the caller fails and prints the URL) and leaves every
 * file already written alone, because they were written from a good fetch.
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
      `No instance to fetch the skill from: skipped the skill file. ${RERUN} once this machine is approved.`,
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
    const path = skillPathFor(deps, h);
    if (harnessSkills[h as SkillHarness].agentsMd) {
      const before = existsSync(path) ? readFileSync(path, "utf8") : "";
      writeAtomic(path, withCodexBlock(before, text));
      written.push(path);
      continue;
    }
    if (existsSync(path)) {
      const current = readFileSync(path, "utf8");
      if (!current.startsWith(SKILL_HEADER)) {
        notes.push(
          `Left ${path} alone: it has no Open Artifacts header, so it is not ours to replace.`,
        );
        continue;
      }
    }
    writeAtomic(path, withHeader(text));
    written.push(path);
  }
  return { written, notes };
}

/** Removes exactly what installSkill wrote: our header's files and our block. */
export const uninstallSkill = (
  deps: Pick<SkillDeps, "home">,
  harnesses: Harness[],
): SkillResult => {
  const written: string[] = [];
  const notes: string[] = [];
  for (const h of harnesses) {
    const path = skillPathFor(deps as SkillDeps, h);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    if (harnessSkills[h as SkillHarness].agentsMd) {
      const start = text.indexOf(CODEX_BEGIN);
      if (start === -1) continue;
      const endAt = text.indexOf(CODEX_END, start);
      const end = endAt === -1 ? text.length : endAt + CODEX_END.length;
      const next = `${text.slice(0, start)}${text.slice(end)}`.trimEnd();
      if (next) writeAtomic(path, `${next}\n`);
      else rmSync(path, { force: true });
      written.push(path);
      continue;
    }
    if (!text.startsWith(SKILL_HEADER)) {
      notes.push(`Left ${path} alone: it has no Open Artifacts header.`);
      continue;
    }
    rmSync(path, { force: true });
    // A skills folder we created does not outlive the file it held.
    const dir = dirname(path);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A shared folder (other skills): leave it.
    }
    written.push(path);
  }
  return { written, notes };
};
