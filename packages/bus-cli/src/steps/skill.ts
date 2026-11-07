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
import { harnessSkills } from "@oa/shared/harness-skills";
import type { Harness } from "./adapters.ts";
import { codexHome } from "./codex.ts";
import { hermesHome } from "./hermes.ts";

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

const env = (deps: Pick<SkillDeps, "env">) => deps.env ?? {};

/** The folder a harness reads skills from, honoring the same env overrides the adapters do. */
export const skillDir = (
  deps: Pick<SkillDeps, "home" | "env">,
  h: Harness,
): string => {
  const e = env(deps);
  const opencode =
    e.OPENCODE_CONFIG_DIR ??
    join(e.XDG_CONFIG_HOME ?? join(deps.home, ".config"), "opencode");
  // pi and omp both read ~/.agents/skills (the shared table says so). Never
  // ~/.pi/agent/skills: pi reads both folders and warns about the collision.
  const agents = join(deps.home, ".agents", "skills");
  return {
    claude: join(e.CLAUDE_CONFIG_DIR ?? join(deps.home, ".claude"), "skills"),
    opencode: join(opencode, "skills"),
    pi: agents,
    omp: agents,
    codex: join(codexHome(deps.home, e), "AGENTS.md"),
    hermes: join(hermesHome(deps.home, e), "skills"),
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

/**
 * Ours only when the marker is the line right after the closing frontmatter
 * `---`, the folder is the frontmatter name, and the name is an open-artifacts one.
 */
const isOurs = (text: string, folder: string): boolean => {
  const t = text.replace(/\r\n/g, "\n");
  const m = /^---\n[\s\S]*?\n---\n/.exec(t);
  if (!m) return false;
  const name = skillFolder(t);
  return (
    name === folder &&
    name.startsWith("open-artifacts") &&
    t.slice(m[0].length).split("\n", 1)[0] === SKILL_MARKER
  );
};

/** Whole-line index of a marker, ignoring a trailing CR (CRLF files). */
const lineIndex = (lines: string[], marker: string, from = 0): number => {
  for (let i = from; i < lines.length; i++)
    if (lines[i]?.replace(/\r$/, "") === marker) return i;
  return -1;
};

/** A served text that quotes a marker line would corrupt ownership: refuse it. */
const quotesMarker = (text: string): boolean => {
  const lines = text.split("\n");
  return [SKILL_MARKER, CODEX_BEGIN, CODEX_END].some(
    (m) => lineIndex(lines, m) !== -1,
  );
};

const lstatOk = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

/** Is `path` a symlink whose target is missing? */
const brokenLink = (path: string): boolean => {
  try {
    return lstatSync(path).isSymbolicLink() && !existsSync(path);
  } catch {
    return false;
  }
};

/**
 * Fetches the skill text. Redirects are refused, the content type must be
 * markdown, and the 256 KB cap is enforced while reading, not after.
 */
export async function fetchSkillText(
  doFetch: typeof fetch,
  url: string,
): Promise<string> {
  const r = await doFetch(url, {
    headers: { accept: "text/markdown" },
    redirect: "error",
  });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  const type = r.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("text/markdown"))
    throw new Error(`unexpected content-type: ${type || "none"}`);
  const declared = Number(r.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_SKILL_BYTES) {
    await r.body?.cancel().catch(() => {});
    throw new Error("skill too large");
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = r.body?.getReader();
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_SKILL_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error("skill too large");
      }
      chunks.push(value);
    }
  }
  const text = new TextDecoder().decode(Buffer.concat(chunks));
  if (!text.startsWith("---\nname: "))
    throw new Error("not a skill: no frontmatter");
  return text;
}

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
  const start = lineIndex(lines, CODEX_BEGIN);
  const end = lineIndex(lines, CODEX_END, start + 1);
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
  const start = lineIndex(lines, CODEX_BEGIN);
  return start !== -1 && lineIndex(lines, CODEX_END, start + 1) === -1;
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
      "Skipped the skill file: this machine isn't approved on an instance yet. Rerun the install once it is.",
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
    if (!folder?.startsWith("open-artifacts") || quotesMarker(text))
      return {
        written,
        notes,
        failedUrl: url,
      };
    const base = skillDir(deps, h);
    const path = harnessSkills[h].agentsMd
      ? base
      : join(base, folder, "SKILL.md");
    if (brokenLink(path)) {
      notes.push(`Left ${path} alone: it is a broken symlink.`);
      continue;
    }
    const writing = targetOf(path);
    try {
      if (harnessSkills[h].agentsMd) {
        const before = existsSync(writing) ? readFileSync(writing, "utf8") : "";
        if (codexBroken(before)) {
          notes.push(
            `Left ${writing} alone: its Open Artifacts block has no END marker. Fix or remove the block, then rerun the install.`,
          );
          continue;
        }
        writeAtomic(writing, withCodexBlock(before, text));
      } else {
        if (
          existsSync(writing) &&
          !isOurs(readFileSync(writing, "utf8"), folder)
        ) {
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
  harnesses: Harness[] = ["claude", "opencode", "pi", "omp", "codex", "hermes"],
): SkillResult => {
  const written: string[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();
  const fail = (path: string, e: unknown) =>
    notes.push(
      `Left ${path} alone: ${e instanceof Error ? e.message : String(e)}`,
    );
  for (const h of harnesses) {
    const base = skillDir(deps, h);
    // pi and omp share a folder: visit it once.
    if (seen.has(base)) continue;
    seen.add(base);
    if (harnessSkills[h].agentsMd) {
      try {
        if (brokenLink(base) || !existsSync(base)) continue;
        const text = readFileSync(base, "utf8");
        if (codexBroken(text)) {
          notes.push(
            `Left ${base} alone: its Open Artifacts block has no END marker. Fix or remove the block, then rerun the install.`,
          );
          continue;
        }
        const next = withCodexBlock(text, "");
        // An emptied block is no block: drop the markers too.
        const clean = next
          .split("\n")
          .filter((l) => {
            const t = l.replace(/\r$/, "");
            return t !== CODEX_BEGIN && t !== CODEX_END;
          })
          .join("\n")
          .trimEnd();
        if (clean) writeAtomic(targetOf(base), `${clean}\n`);
        else rmSync(targetOf(base), { force: true });
        written.push(base);
      } catch (e) {
        fail(base, e);
      }
      continue;
    }
    let entries: string[];
    try {
      if (!existsSync(base)) continue;
      entries = readdirSync(base);
    } catch (e) {
      fail(base, e);
      continue;
    }
    for (const entry of entries) {
      const dir = join(base, entry);
      const file = join(dir, "SKILL.md");
      try {
        const st = lstatSync(dir);
        if (st.isSymbolicLink()) {
          if (existsSync(file))
            notes.push(`Left ${dir} alone: it is a symlinked folder.`);
          continue;
        }
        if (!st.isDirectory() || !lstatOk(file)) continue;
        if (!isOurs(readFileSync(targetOf(file), "utf8"), entry)) {
          notes.push(
            `Left ${file} alone: it is not an Open Artifacts skill file.`,
          );
          continue;
        }
        rmSync(targetOf(file), { force: true });
        // rmdirSync, never recursive: the folder goes only if we left it empty.
        try {
          rmdirSync(dir);
        } catch {
          // Another file in there: leave the folder.
        }
        written.push(file);
      } catch (e) {
        fail(file, e);
      }
    }
  }
  return { written, notes };
};
