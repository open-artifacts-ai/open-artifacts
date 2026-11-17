import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Doc,
  jsoncValue,
  parseJsonc,
  removeJsoncValue,
  setJsoncValue,
} from "@oa/bus-adapter-mcp-json";

/**
 * #1822: Claude Code runs a `headersHelper` command when it connects to an
 * HTTP MCP server and sends what it prints as headers. Ours prints the
 * session's link proof, so the instance can tell which bus agent is calling.
 * Every entry for this machine's instance in ~/.claude.json gets it (user
 * scope, and local scope under `projects[<dir>]`). A project-scope `.mcp.json`
 * is never edited: Claude skips helpers on untrusted project entries, and
 * there is no knowing every project folder.
 */
/** Claude's user config: `~/.claude.json`, or under CLAUDE_CONFIG_DIR. */
export const claudeConfigFile = (
  home: string,
  env: Record<string, string | undefined>,
) => join(env.CLAUDE_CONFIG_DIR ?? home, ".claude.json");

export const PROOF_COMMAND = "mcp-proof";

/** The token form's helper (packages/shared agent-clients.ts), and the file it reads. */
const TOKEN_HELPER =
  /^T=\$\(cat (.+)\) && printf '\{"Authorization":"Bearer %s"\}' "\$T"$/;

const quote = (s: string) =>
  /^[A-Za-z0-9_./:@%+=,-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`;

/** The helper command line for an entry; `tokenFile` keeps a token entry's Authorization. */
export function proofHelper(
  busBin: string[],
  // `tokenFile` is shell text taken from the old helper, so it stays as it was.
  opts: { tokenFile?: string; busHome?: string },
): string {
  const run = [
    ...(opts.busHome ? [`OA_BUS_HOME=${quote(opts.busHome)}`] : []),
    ...busBin.map(quote),
    PROOF_COMMAND,
    ...(opts.tokenFile ? ["--token-file", opts.tokenFile] : []),
  ].join(" ");
  // A token entry must keep its Authorization when oa-bus cannot run (its
  // install deleted): fall back to the plain header the old helper printed.
  return opts.tokenFile
    ? `T=$(cat ${opts.tokenFile}) && { ${run} 2>/dev/null || printf '{"Authorization":"Bearer %s"}' "$T"; }`
    : run;
}

/** Whether `helper` is one of ours. */
export const isProofHelper = (helper: unknown): boolean =>
  typeof helper === "string" && / mcp-proof( |$)/.test(helper);

const isRecord = (v: unknown): v is Doc =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export type Scope = "user" | "local";
export type Found = {
  name: string;
  entry: Doc;
  scope: Scope;
  /** The project folder of a local-scope entry. */
  project?: string;
  /** The entry's JSON path in ~/.claude.json. */
  path: string[];
};

/** Whether `entry` is an HTTP server at this instance's /mcp (a trailing slash is fine). */
export function isInstanceEntry(entry: unknown, origin: string): boolean {
  if (!isRecord(entry) || typeof entry.url !== "string") return false;
  if (entry.type !== undefined && entry.type !== "http") return false;
  try {
    const u = new URL(entry.url);
    return u.origin === origin && u.pathname.replace(/\/+$/, "") === "/mcp";
  } catch {
    return false;
  }
}

/** Every server entry in the file with its scope: top-level (user) and `projects[dir]` (local). */
function allEntries(doc: Doc): Found[] {
  const out: Found[] = [];
  const add = (servers: unknown, scope: Scope, project?: string) => {
    if (!isRecord(servers)) return;
    for (const [name, entry] of Object.entries(servers))
      if (isRecord(entry))
        out.push({
          name,
          entry,
          scope,
          ...(project === undefined ? {} : { project }),
          path:
            project === undefined
              ? ["mcpServers", name]
              : ["projects", project, "mcpServers", name],
        });
  };
  add(doc.mcpServers, "user");
  if (isRecord(doc.projects))
    for (const [dir, p] of Object.entries(doc.projects))
      if (isRecord(p)) add(p.mcpServers, "local", dir);
  return out;
}

/** The entries that point at this instance's /mcp, at user and local scope. Their names are the user's, so they are found by address. */
export const findEntries = (doc: Doc, origin: string): Found[] =>
  allEntries(doc).filter((f) => isInstanceEntry(f.entry, origin));

/** Entries on the instance's host whose address is not its /mcp (another path, port or scheme). */
export function findElsewhere(doc: Doc, origin: string): Found[] {
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return [];
  }
  return allEntries(doc).filter((f) => {
    if (typeof f.entry.url !== "string" || isInstanceEntry(f.entry, origin))
      return false;
    try {
      return new URL(f.entry.url).hostname === host;
    } catch {
      return false;
    }
  });
}

export type ProofRecord = {
  entry: string;
  /** The project folder of a local-scope entry; none for user scope. */
  project?: string;
  original: string | null;
};
export type ProofIo = {
  /** The Claude config (`~/.claude.json`). */
  file: string;
  /** The install record file, which holds the rest of install's state. */
  record: string;
  write: (path: string, data: string, mode?: number) => void;
};

const readText = (path: string): string => {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw e;
  }
};

const asRecord = (p: unknown): ProofRecord | undefined =>
  isRecord(p) &&
  typeof p.entry === "string" &&
  (p.project === undefined || typeof p.project === "string") &&
  (typeof p.original === "string" || p.original === null)
    ? {
        entry: p.entry,
        ...(typeof p.project === "string" ? { project: p.project } : {}),
        original: p.original,
      }
    : undefined;

/** The record holds a list; an earlier install's single user-scope object reads as a list of one. */
function readRecord(path: string): { rest: Doc; proofs: ProofRecord[] } {
  try {
    const v: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (isRecord(v)) {
      const { claudeProof, ...rest } = v;
      const list = Array.isArray(claudeProof) ? claudeProof : [claudeProof];
      return {
        rest,
        proofs: list.map(asRecord).filter((r): r is ProofRecord => !!r),
      };
    }
  } catch {}
  return { rest: {}, proofs: [] };
}

function writeRecord(io: ProofIo, rest: Doc, proofs: ProofRecord[]) {
  const out = proofs.length ? { ...rest, claudeProof: proofs } : rest;
  io.write(io.record, `${JSON.stringify(out, null, 2)}\n`, 0o600);
}

const same = (r: ProofRecord, name: string, project?: string) =>
  r.entry === name && r.project === project;

export type Applied = { entry: string; scope: Scope };
export type ProofResult = {
  /** Why an entry was left alone. Never a header value. */
  notes: string[];
  /** The entries that were written. */
  changed: Applied[];
  /** The file changed between the read and the write, so nothing was written (guard only). */
  skipped?: true;
};

/**
 * Adds the helper to every entry for the instance (user scope and each local
 * scope), keeping a token entry's Authorization. Someone else's helper is
 * left alone, with a note. Running again changes nothing and writes nothing.
 * With `guard`, the file is read again just before the write and nothing is
 * written if it changed meanwhile: Claude rewrites it while it runs.
 */
export function installProof(
  io: ProofIo,
  origin: string,
  busBin: string[],
  busHome?: string,
  opts: { guard?: boolean } = {},
): ProofResult {
  const out: ProofResult = { notes: [], changed: [] };
  const text = readText(io.file);
  if (text === "") return out;
  const { rest, proofs } = readRecord(io.record);
  const records = [...proofs];
  let next = text;
  for (const f of findEntries(parseJsonc(text, io.file), origin)) {
    const rec = records.find((r) => same(r, f.name, f.project));
    const cur = f.entry.headersHelper;
    let original: string | null;
    if (isProofHelper(cur) && rec) original = rec.original;
    else if (isProofHelper(cur)) continue;
    else if (cur === undefined) original = null;
    else if (typeof cur === "string" && TOKEN_HELPER.test(cur)) original = cur;
    else {
      out.notes.push(
        `left the headersHelper of ${f.name} (${f.scope} scope) in ${io.file} as it is: it is not one oa-bus knows`,
      );
      continue;
    }
    const tokenFile = original?.match(TOKEN_HELPER)?.[1];
    const helper = proofHelper(busBin, {
      ...(tokenFile ? { tokenFile } : {}),
      ...(busHome ? { busHome } : {}),
    });
    if (cur === helper && rec) continue;
    const at = records.findIndex((r) => same(r, f.name, f.project));
    const made: ProofRecord = {
      entry: f.name,
      ...(f.project === undefined ? {} : { project: f.project }),
      original,
    };
    if (at < 0) records.push(made);
    else records[at] = made;
    next = setJsoncValue(next, [...f.path, "headersHelper"], helper);
    out.changed.push({ entry: f.name, scope: f.scope });
  }
  if (out.changed.length === 0) return out;
  if (opts.guard && readText(io.file) !== text)
    return { notes: out.notes, changed: [], skipped: true };
  writeRecord(io, rest, records);
  io.write(io.file, next);
  return out;
}

/** Puts every entry back as it was before `installProof`; false when there was nothing to undo. */
export function uninstallProof(io: ProofIo): boolean {
  const { rest, proofs } = readRecord(io.record);
  if (proofs.length === 0) return false;
  let text = readText(io.file);
  const before = text;
  let undone = false;
  for (const proof of proofs) {
    const path = [
      ...(proof.project === undefined
        ? ["mcpServers"]
        : ["projects", proof.project, "mcpServers"]),
      proof.entry,
      "headersHelper",
    ];
    let cur: unknown;
    try {
      cur = text === "" ? undefined : jsoncValue(text, path);
    } catch {
      cur = undefined;
    }
    // Only our own helper is taken back: anything else is the user's since.
    if (!isProofHelper(cur)) continue;
    text =
      proof.original === null
        ? removeJsoncValue(text, path)
        : setJsoncValue(text, path, proof.original);
    undone = true;
  }
  if (text !== before) io.write(io.file, text);
  writeRecord(io, rest, []);
  return undone;
}

export type EntryState = {
  name: string;
  scope: Scope | "project";
  project?: string;
  state: "helper" | "missing" | "foreign";
};

export type ProofReport = {
  entries: EntryState[];
  /** Same host, different address. */
  elsewhere: { name: string; scope: Scope | "project"; url: string }[];
};

const stateOf = (helper: unknown): EntryState["state"] =>
  helper === undefined
    ? "missing"
    : isProofHelper(helper)
      ? "helper"
      : "foreign";

/**
 * Read-only: every Claude entry for the instance, at user and local scope in
 * `file` and project scope in `projectFile` (the current folder's `.mcp.json`).
 */
export function proofReport(
  file: string,
  origin: string,
  projectFile?: string,
): ProofReport {
  const report: ProofReport = { entries: [], elsewhere: [] };
  const read = (path: string): Doc | undefined => {
    try {
      const text = readText(path);
      return text === "" ? undefined : parseJsonc(text, path);
    } catch {
      return undefined;
    }
  };
  const doc = read(file);
  if (doc) {
    for (const f of findEntries(doc, origin))
      report.entries.push({
        name: f.name,
        scope: f.scope,
        ...(f.project === undefined ? {} : { project: f.project }),
        state: stateOf(f.entry.headersHelper),
      });
    for (const f of findElsewhere(doc, origin))
      report.elsewhere.push({
        name: f.name,
        scope: f.scope,
        url: String(f.entry.url),
      });
  }
  const proj = projectFile === undefined ? undefined : read(projectFile);
  if (proj && isRecord(proj.mcpServers))
    for (const [name, entry] of Object.entries(proj.mcpServers)) {
      if (!isRecord(entry)) continue;
      if (isInstanceEntry(entry, origin))
        report.entries.push({
          name,
          scope: "project",
          state: stateOf(entry.headersHelper),
        });
      else if (typeof entry.url === "string") {
        try {
          if (new URL(entry.url).hostname === new URL(origin).hostname)
            report.elsewhere.push({ name, scope: "project", url: entry.url });
        } catch {}
      }
    }
  return report;
}
