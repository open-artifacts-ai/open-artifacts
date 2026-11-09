import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  briefOrigin,
  LEAD_TEMPLATE_MAX_BYTES,
  type LeadTemplate,
  LeadTemplateNameSchema,
  LeadTemplateSchema,
  leadTemplateHash,
} from "@oa/bus-protocol";
import { home } from "../config.ts";
import { type GroupCheck, ownGroup, readOwnFile } from "../own-file.ts";

/**
 * Lead templates (#1328). A template is read from `<OA_BUS_HOME>/leads/<name>.json`
 * and nowhere else: never from a repo, so a clone cannot supply one, and a
 * repo's `.oa-bus.json` (strict `{namespace?, global?}`) grants nothing here.
 * This module only reads and checks. It starts nothing.
 */

export const leadsDir = (h = home()): string => join(h, "leads");
export const leadTemplateFile = (name: string, h = home()): string =>
  join(leadsDir(h), `${name}.json`);

export type LeadTemplateResult =
  | {
      state: "ok";
      name: string;
      file: string;
      template: LeadTemplate;
      hash: string;
    }
  | { state: "none"; name: string }
  | { state: "refused"; name: string; why: string };

export type LoadOpts = {
  home?: string;
  /** The owner every file must have. Tests inject; defaults to the process's own. */
  uid?: number | undefined;
  /** The hub's origin: a brief on any other host is refused. */
  hubOrigin: string;
  /** The process's group and whether it is private (#1527). Tests inject. */
  group?: GroupCheck;
};

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;
/** Text from a file made safe to print: no control characters, bounded. */
const tame = (s: string): string => {
  const t = s.replace(CONTROL_RE, "?");
  return t.length > 160 ? `${t.slice(0, 159)}…` : t;
};

const refused = (name: string, why: string): LeadTemplateResult => ({
  state: "refused",
  name,
  why,
});

/** The leads folder must be a real folder of ours that nobody else can write. */
export function checkLeadsDir(
  dir: string,
  uid: number | undefined,
): string | undefined | "none" {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(dir);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return "none";
    return `the leads folder cannot be read (${code})`;
  }
  if (st.isSymbolicLink()) return "the leads folder is a symlink";
  if (!st.isDirectory()) return "the leads folder is not a folder";
  if (uid !== undefined && st.uid !== uid)
    return "the leads folder belongs to another user";
  if (st.mode & 0o022)
    return `the leads folder is writable by others: run chmod 700 ${dir}`;
  return undefined;
}

/**
 * A folder named by absolute path: its own real path (no symlink or alias),
 * not the root, a folder, ours, not world-writable, and group-writable only in
 * the process's own private group (#1527). The leads folder keeps the strict
 * rule. A template cannot point a lead at a folder
 * someone else can reshape.
 */
function checkRealDir(
  path: string,
  label: string,
  uid: number | undefined,
  group: GroupCheck,
): string | undefined {
  if (path === "/") return `${label} is the root folder`;
  let real: string;
  try {
    real = realpathSync.native(path);
  } catch {
    return `${label} does not exist`;
  }
  if (real !== path)
    return `${label} is not its own real path (a symlink or alias)`;
  try {
    const st = statSync(real);
    if (!st.isDirectory()) return `${label} is not a folder`;
    if (uid !== undefined && st.uid !== uid)
      return `${label} belongs to another user`;
    // World-write is always refused. Group-write only when the group is the
    // process's own and private (#1527): a repo on a 002-umask box is 775.
    if (st.mode & 0o002)
      return `${label} is writable by everyone: run chmod 700 ${path}`;
    if (st.mode & 0o020 && (st.gid !== group.gid || !group.isPrivate(st.gid)))
      return `${label} is writable by a group others share: run chmod 700 ${path}`;
  } catch {
    return `${label} cannot be read`;
  }
  return undefined;
}

/**
 * The harness binary: a regular, executable file, owned by this user or root,
 * not writable by group or others. The name is fixed by the schema. A
 * same-user replacement of the file (or of a symlink's target) is not stopped.
 */
function checkBinary(
  path: string,
  uid: number | undefined,
): string | undefined {
  try {
    const st = statSync(path);
    if (!st.isFile()) return "binary is not a regular file";
    if (uid !== undefined && st.uid !== uid && st.uid !== 0)
      return "binary belongs to another user";
    if (st.mode & 0o022) return "binary is writable by others";
    if (!(st.mode & 0o111)) return "binary is not executable";
  } catch {
    return "binary does not exist";
  }
  return undefined;
}

/**
 * Reads one template, safely ours or refused. In order: the name, the leads
 * folder, the file (never a symlink, a FIFO, another user's, or writable by
 * group or others, and no larger than the limit), strict JSON, the schema,
 * the brief's host, then the paths on disk. The hash is of the validated
 * template, so it does not depend on key order or spacing.
 */
export async function loadLeadTemplate(
  name: string,
  opts: LoadOpts,
): Promise<LeadTemplateResult> {
  if (!LeadTemplateNameSchema.safeParse(name).success)
    return refused(tame(name), "is not a valid template name");
  const h = opts.home ?? home();
  const uid = "uid" in opts ? opts.uid : process.getuid?.();
  const dir = checkLeadsDir(leadsDir(h), uid);
  if (dir === "none") return { state: "none", name };
  if (dir) return refused(name, dir);

  const file = leadTemplateFile(name, h);
  const own = readOwnFile(file, uid, { maxBytes: LEAD_TEMPLATE_MAX_BYTES });
  if (own.state === "none") return { state: "none", name };
  if (own.state === "unsafe") return refused(name, `file ${own.why}`);
  if (Buffer.byteLength(own.text, "utf8") > LEAD_TEMPLATE_MAX_BYTES)
    return refused(name, "file is too large");

  let raw: unknown;
  try {
    raw = JSON.parse(own.text);
  } catch {
    return refused(name, "is not valid JSON");
  }
  const parsed = LeadTemplateSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const at = issue?.path.map(String).join(".");
    return refused(
      name,
      tame(
        `${at ? `${at}: ` : ""}${issue?.message ?? "is not a valid template"}`,
      ),
    );
  }
  const t = parsed.data;

  const origin = briefOrigin(t.brief);
  if (origin !== opts.hubOrigin)
    return refused(name, "brief is not on this machine's hub");

  const group = opts.group ?? ownGroup();
  const bad =
    checkRealDir(t.repo, "repo", uid, group) ??
    (t.worktree_root
      ? checkRealDir(t.worktree_root, "worktree_root", uid, group)
      : undefined) ??
    checkBinary(t.binary, uid);
  if (bad) return refused(name, bad);

  return {
    state: "ok",
    name,
    file,
    template: t,
    hash: await leadTemplateHash(t),
  };
}

/**
 * Every template file in the leads folder, by name, in order. A `.json` file
 * whose name is not a valid template name is listed too (so it is reported
 * refused, not silently skipped); `config.json` is the machine's own and is
 * not a template. Reads the folder only.
 */
export function listLeadTemplateNames(h = home()): string[] {
  const dir = leadsDir(h);
  const state = checkLeadsDir(dir, process.getuid?.());
  if (state !== undefined) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((f) => f.endsWith(".json") && f !== "config.json")
    .map((f) => f.slice(0, -".json".length))
    .sort();
}
