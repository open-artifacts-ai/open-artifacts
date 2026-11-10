// The skill file the bus installer writes next to the tools it wires, one per
// harness (Codex gets a marked block in AGENTS.md instead). The text is always
// fetched from the instance: there is no vendored copy, so a reinstall picks up
// the instance's current skill.
//
// Placement matters: pi and the other harnesses parse frontmatter from the
// first line, so the managed marker goes immediately after the closing `---`,
// never before it. Ownership is read from that marker line.

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { compareVersions } from "@oa/bus-adapter-opencode";
import { harnessSkills } from "@oa/shared/harness-skills";
import type { Harness } from "./adapters.ts";
import { codexHome } from "./codex.ts";
import { hermesHome } from "./hermes.ts";
import { openclawStateDir } from "./openclaw.ts";

/** Immediately after the frontmatter: the only file we may replace. */
export const SKILL_MARKER =
  "<!-- managed by the Open Artifacts bus installer: edits are replaced on reinstall. -->";

/** Codex 0.47 has no skills, so its text lives between these whole-line markers. */
export const CODEX_BEGIN =
  "<!-- BEGIN Open Artifacts skill (managed): edits inside are replaced on reinstall. -->";
export const CODEX_END = "<!-- END Open Artifacts skill -->";

/** Codex's skill loader (SKILL.md folders under $CODEX_HOME/skills) is in 0.76 and later. */
export const CODEX_SKILLS_MIN_VERSION = "0.76.0";

/** 256 KB is far more than any served skill; more means the fetch is wrong. */
export const MAX_SKILL_BYTES = 256 * 1024;

export type SkillDeps = {
  /** The user's home: the harness paths under it. */
  home: string;
  env?: Record<string, string | undefined>;
  /** Fetch the skill text. Tests pass a fake, never the network. */
  fetchSkill: (url: string) => Promise<string>;
  /** `codex --version`, when it could be read: 0.76 or later gets a skill file. */
  codexVersion?: string;
};

/** The Codex skill file for a skill folder name: under $CODEX_HOME/skills. */
export const codexSkillFile = (
  deps: Pick<SkillDeps, "home" | "env">,
  folder: string,
): string =>
  join(codexHome(deps.home, env(deps)), "skills", folder, "SKILL.md");

/** Does this Codex have a skill loader? Unreadable means no. */
export const codexHasSkills = (version: string | undefined): boolean =>
  version !== undefined &&
  (compareVersions(version, CODEX_SKILLS_MIN_VERSION) ?? -1) >= 0;

const blankLine = (l: string | undefined) => l?.replace(/\r$/, "") === "";

/**
 * `text` without any of our blocks, everything else byte for byte; undefined
 * when there is none. The blank line the install put before an appended block
 * goes with it, only when the block ends the file or a blank line follows it.
 */
export const withoutCodexBlock = (text: string): string | undefined => {
  let lines = text.split("\n");
  let removed = false;
  for (;;) {
    const start = lineIndex(lines, CODEX_BEGIN);
    if (start === -1) break;
    const end = lineIndex(lines, CODEX_END, start + 1);
    if (end === -1) break;
    const before = lines.slice(0, start);
    let after = lines.slice(end + 1);
    if (
      before.length > 0 &&
      blankLine(before[before.length - 1]) &&
      (after.length === 0 || blankLine(after[0]))
    )
      before.pop();
    // A block that ended the file leaves the line before it newline-terminated.
    if (after.length === 0 && before.length > 0) after = [""];
    lines = [...before, ...after];
    removed = true;
  }
  return removed ? lines.join("\n") : undefined;
};

/** Removes our blocks from AGENTS.md at `agentsPath`; the file itself always stays. */
const dropCodexBlock = (agentsPath: string, notes: string[]): boolean => {
  if (brokenLink(agentsPath) || !existsSync(agentsPath)) return false;
  const text = readFileSync(agentsPath, "utf8");
  if (codexBroken(text)) {
    notes.push(
      `Left ${agentsPath} alone: its Open Artifacts block has no END marker. Fix or remove the block, then rerun the install.`,
    );
    return false;
  }
  const next = withoutCodexBlock(text);
  if (next === undefined) return false;
  // Never deleted, even when empty: the file (or the link's target) is the user's.
  writeAtomic(targetOf(agentsPath), next);
  return true;
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
    // OpenClaw's managed skills folder, in its state dir.
    openclaw: join(openclawStateDir(deps.home, e), "skills"),
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
export const lineIndex = (
  lines: string[],
  marker: string,
  from = 0,
): number => {
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
export const brokenLink = (path: string): boolean => {
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
export const targetOf = (path: string) => {
  try {
    return lstatSync(path).isSymbolicLink() ? realpathSync(path) : path;
  } catch {
    return path;
  }
};

let seq = 0;
/** Writes and cleans up on failure; a write error is a note upstream. */
export const writeAtomic = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.oa-${process.pid}-${seq++}.tmp`;
  try {
    // The replacement keeps the file's mode: a 0600 file must not become 0664.
    let mode: number | undefined;
    try {
      mode = statSync(path).mode & 0o7777;
    } catch {
      // A new file: the default mode.
    }
    writeFileSync(tmp, text);
    if (mode !== undefined) chmodSync(tmp, mode);
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

/** A block we cannot edit safely: a BEGIN with no END, or an edited BEGIN line. */
const codexBroken = (text: string) => {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]?.replace(/\r$/, "") ?? "";
    const bare = t.trim();
    if (t !== CODEX_BEGIN && bare.startsWith("<!-- BEGIN Open Artifacts skill"))
      return true;
    if (t !== CODEX_END && bare === CODEX_END) return true;
    if (t === CODEX_BEGIN) {
      const end = lineIndex(lines, CODEX_END, i + 1);
      if (end === -1) return true;
      i = end;
    }
  }
  return false;
};

const realOrResolved = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/** Where a folder really is, and where a (possibly dangling) link in its place points. */
const placesOf = (p: string): string[] => {
  const out = [realOrResolved(p)];
  try {
    if (lstatSync(p).isSymbolicLink())
      out.push(realOrResolved(resolve(dirname(p), readlinkSync(p))));
  } catch {
    // Not a link, or not there.
  }
  return out;
};

/** Is Codex's skills folder the one pi and omp read? Then a file there is theirs too. */
export const codexSkillsShared = (
  deps: Pick<SkillDeps, "home" | "env">,
): boolean => {
  const mine = placesOf(dirname(dirname(codexSkillFile(deps, "x"))));
  const theirs = placesOf(skillDir(deps, "pi"));
  return mine.some((m) => theirs.includes(m));
};

const ourSkillFile = (path: string, folder: string): boolean => {
  try {
    return isOurs(readFileSync(path, "utf8"), folder);
  } catch {
    return false;
  }
};

/**
 * Codex's copy: a file under its skills folder when it can load one (0.76+, or
 * our file is already there and the version cannot be read), else the marked
 * block in AGENTS.md. One copy only, so the skill never loads twice.
 */
const installCodex = (
  deps: SkillDeps,
  folder: string,
  text: string,
  written: string[],
  notes: string[],
) => {
  const agentsPath = skillDir(deps, "codex");
  const filePath = codexSkillFile(deps, folder);
  let before: string;
  try {
    before = existsSync(targetOf(agentsPath))
      ? readFileSync(targetOf(agentsPath), "utf8")
      : "";
  } catch (e) {
    // Never write over what we could not read.
    notes.push(
      `Left ${agentsPath} alone: could not read it (${e instanceof Error ? e.message : String(e)}).`,
    );
    return;
  }
  const ourFile = ourSkillFile(filePath, folder);
  let asFile =
    codexHasSkills(deps.codexVersion) ||
    (deps.codexVersion === undefined && ourFile);
  const shared = codexSkillsShared(deps);
  if (asFile && shared) {
    asFile = false;
    notes.push(
      `Kept the Codex skill in ${agentsPath}: Codex shares its skills folder with pi and omp, and writing there would overwrite their skill.`,
    );
  }
  if (codexBroken(before)) {
    notes.push(
      `Left ${agentsPath} alone: its Open Artifacts block has no END marker. Fix or remove the block, then rerun the install.`,
    );
    return;
  }
  if (asFile) {
    if (brokenLink(filePath)) {
      notes.push(`Left ${filePath} alone: it is a broken symlink.`);
      return;
    }
    const writing = targetOf(filePath);
    try {
      if (existsSync(writing) && !ourSkillFile(writing, folder)) {
        notes.push(
          `Left ${writing} alone: it has no Open Artifacts marker, so it is not ours to replace.`,
        );
        return;
      }
      writeAtomic(writing, withMarker(text));
    } catch (e) {
      notes.push(
        `Could not write ${writing}: ${e instanceof Error ? e.message : String(e)}`,
      );
      return;
    }
    written.push(filePath);
    // Moved to a file: our old block goes, the user's other text stays.
    try {
      dropCodexBlock(agentsPath, notes);
    } catch (e) {
      notes.push(
        `Could not update ${agentsPath}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    return;
  }
  if (brokenLink(agentsPath)) {
    notes.push(`Left ${agentsPath} alone: it is a broken symlink.`);
    return;
  }
  const writing = targetOf(agentsPath);
  try {
    writeAtomic(writing, withCodexBlock(before, text));
  } catch (e) {
    notes.push(
      `Could not write ${writing}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return;
  }
  written.push(agentsPath);
  // Back to the block (an older Codex): our file goes, so only one copy loads.
  if (ourFile && !shared) {
    try {
      rmSync(targetOf(filePath), { force: true });
      try {
        rmdirSync(dirname(filePath));
      } catch {
        // Another file in there: leave the folder.
      }
    } catch (e) {
      notes.push(
        `Could not remove ${filePath}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
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
    if (h === "codex") {
      installCodex(deps, folder, text, written, notes);
      continue;
    }
    const base = skillDir(deps, h);
    const path = join(base, folder, "SKILL.md");
    if (brokenLink(path)) {
      notes.push(`Left ${path} alone: it is a broken symlink.`);
      continue;
    }
    const writing = targetOf(path);
    try {
      if (existsSync(writing) && !ourSkillFile(writing, folder)) {
        notes.push(
          `Left ${writing} alone: it has no Open Artifacts marker, so it is not ours to replace.`,
        );
        continue;
      }
      writeAtomic(writing, withMarker(text));
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
  harnesses: Harness[] = [
    "claude",
    "opencode",
    "pi",
    "omp",
    "codex",
    "hermes",
    "openclaw",
  ],
): SkillResult => {
  const written: string[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();
  const fail = (path: string, e: unknown) =>
    notes.push(
      `Left ${path} alone: ${e instanceof Error ? e.message : String(e)}`,
    );
  const scan = (base: string) => {
    let entries: string[];
    try {
      if (!existsSync(base)) return;
      entries = readdirSync(base);
    } catch (e) {
      fail(base, e);
      return;
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
  };
  for (const h of harnesses) {
    const base = skillDir(deps, h);
    // pi and omp share a folder: visit it once.
    if (seen.has(base)) continue;
    seen.add(base);
    if (harnessSkills[h].agentsMd) {
      // Codex: our block in AGENTS.md, and our file under its skills folder.
      try {
        if (dropCodexBlock(base, notes)) written.push(base);
      } catch (e) {
        fail(base, e);
      }
      scan(join(dirname(base), "skills"));
      continue;
    }
    scan(base);
  }
  return { written, notes };
};

/** Codex's copies of our skill: our file, and our AGENTS.md block. Both is a double load. */
export const codexSkillState = (
  deps: Pick<SkillDeps, "home" | "env">,
): { file?: string; block?: string; shared: boolean } => {
  const out: { file?: string; block?: string; shared: boolean } = {
    shared: codexSkillsShared(deps),
  };
  try {
    const dir = join(dirname(skillDir(deps, "codex")), "skills");
    for (const entry of readdirSync(dir)) {
      const file = join(dir, entry, "SKILL.md");
      if (ourSkillFile(file, entry)) {
        out.file = file;
        break;
      }
    }
  } catch {
    // No skills folder.
  }
  try {
    const agents = skillDir(deps, "codex");
    if (withoutCodexBlock(readFileSync(agents, "utf8")) !== undefined)
      out.block = agents;
  } catch {
    // No AGENTS.md.
  }
  return out;
};
