import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { daemonSocketPath } from "@oa/bus-adapter-claude-code";
import {
  type Doc,
  jsoncValue,
  parseJsonc,
  removeJsoncValue,
  setJsoncValue,
} from "@oa/bus-adapter-mcp-json";
import { canonicalAddress, MAIN_INSTANCE } from "@oa/bus-daemon";

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
/** #2793 S4: names the instance a proof is for. No flag means main. */
export const PROOF_INSTANCE_FLAG = "--instance";

/** The token form's helper (packages/shared agent-clients.ts), and the file it reads. */
const TOKEN_HELPER =
  /^T=\$\(cat (.+)\) && printf '\{"Authorization":"Bearer %s"\}' "\$T"$/;

const quote = (s: string) =>
  /^[A-Za-z0-9_./:@%+=,-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`;

/** The helper command line for an entry; `tokenFile` keeps a token entry's Authorization. */
export function proofHelper(
  busBin: string[],
  // `tokenFile` is shell text taken from the old helper, so it stays as it was.
  opts: { tokenFile?: string; busHome?: string; instance?: string },
): string {
  const run = [
    ...(opts.busHome ? [`OA_BUS_HOME=${quote(opts.busHome)}`] : []),
    ...busBin.map(quote),
    PROOF_COMMAND,
    ...(opts.instance ? [PROOF_INSTANCE_FLAG, quote(opts.instance)] : []),
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

/** The instance a helper of ours is for; undefined for the main form (no flag). */
export function helperInstance(helper: string): string | undefined {
  return new RegExp(
    ` ${PROOF_COMMAND} ${PROOF_INSTANCE_FLAG} ([a-z0-9-]{1,32})( |$)`,
  ).exec(helper)?.[1];
}

/**
 * The bus home a helper of ours runs for: its `OA_BUS_HOME`, or undefined for
 * the default home. Two buses on one hub each write their own, so a helper is
 * only ever adopted, refreshed or undone by the bus whose home it names.
 */
export function helperHome(helper: string): string | undefined {
  const m = /(?:^|[ {])OA_BUS_HOME=('(?:[^']|'\\'')*'|\S+)/.exec(helper)?.[1];
  if (m === undefined) return undefined;
  return resolve(
    m.startsWith("'") ? m.slice(1, -1).replaceAll("'\\''", "'") : m,
  );
}

/** Whether `helper` (one of ours) runs for the bus at `busHome` (undefined: the default home). */
const ownedBy = (helper: string, busHome: string | undefined): boolean =>
  helperHome(helper) === (busHome === undefined ? undefined : resolve(busHome));

/**
 * #3075: whether the bus whose home a helper names has stopped. Its helper
 * then reports to nobody, so the entry links no session.
 * - `retired` (the unattended daemon): the home is gone, or holds neither a
 *   daemon socket nor an install record. A clean stop or a restart also
 *   removes the socket, so a missing socket alone never lets the daemon take
 *   a live bus's entry mid-restart.
 * - otherwise (add and install, run by a person, who sees the note): the home
 *   is gone or holds no daemon socket.
 */
export function busStopped(
  owner: string | undefined,
  userHome: string,
  opts: { retired?: boolean } = {},
): boolean {
  const home = owner ?? join(userHome, ".oa-bus");
  try {
    if (!existsSync(home)) return true;
    if (existsSync(daemonSocketPath(home))) return false;
    return !opts.retired || !existsSync(join(home, "install.json"));
  } catch {
    return false;
  }
}

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

/** An added instance: its local name and the address saved for it. */
export type InstanceTarget = { name: string; hub: string };

/**
 * Whether `entry` is an HTTP server at the instance's /mcp, by canonical
 * address (ws and http, a trailing slash, the default port all compare equal).
 */
export function isEntryFor(entry: unknown, hub: string): boolean {
  if (!isRecord(entry) || typeof entry.url !== "string") return false;
  if (entry.type !== undefined && entry.type !== "http") return false;
  const want = canonicalAddress(hub);
  const got = canonicalAddress(entry.url);
  return want !== undefined && got !== undefined && got === `${want}/mcp`;
}

const matcherFor =
  (origin: string, instance?: InstanceTarget) =>
  (entry: unknown): boolean =>
    instance ? isEntryFor(entry, instance.hub) : isInstanceEntry(entry, origin);

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
export const findEntries = (
  doc: Doc,
  origin: string,
  instance?: InstanceTarget,
): Found[] =>
  allEntries(doc).filter((f) => matcherFor(origin, instance)(f.entry));

/** Entries on the instance's host whose address is not its /mcp (another path, port or scheme). */
export function findElsewhere(
  doc: Doc,
  origin: string,
  instance?: InstanceTarget,
): Found[] {
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return [];
  }
  const is = matcherFor(origin, instance);
  return allEntries(doc).filter((f) => {
    if (typeof f.entry.url !== "string" || is(f.entry)) return false;
    try {
      return new URL(f.entry.url).hostname === host;
    } catch {
      return false;
    }
  });
}

export type ProofRecord = {
  /** The Claude config the entry is in; an older record has none and means the install's own file. */
  file?: string;
  entry: string;
  /** The project folder of a local-scope entry; none for user scope. */
  project?: string;
  original: string | null;
};
export type ProofIo = {
  /** The Claude config (`~/.claude.json`, or under CLAUDE_CONFIG_DIR). */
  file: string;
  /** The install record file, which holds the rest of install's state. */
  record: string;
  write: (path: string, data: string, mode?: number) => void;
  /** Reads a file's text ("" when missing); the write guard reads the Claude config again through it. */
  read?: (path: string) => string;
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
  (p.file === undefined || typeof p.file === "string") &&
  (typeof p.original === "string" || p.original === null)
    ? {
        ...(typeof p.file === "string" ? { file: p.file } : {}),
        entry: p.entry,
        ...(typeof p.project === "string" ? { project: p.project } : {}),
        original: p.original,
      }
    : undefined;

/**
 * The install record's Claude part: the config file install used (`config`,
 * which the daemon edits and no other) and each entry it gave the helper.
 * An earlier install's single user-scope object reads as a list of one.
 */
export function readRecord(path: string): {
  rest: Doc;
  proofs: ProofRecord[];
  config?: string;
} {
  try {
    const v: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (isRecord(v)) {
      const { claudeProof, claudeConfig, ...rest } = v;
      const list = Array.isArray(claudeProof) ? claudeProof : [claudeProof];
      return {
        rest,
        proofs: list.map(asRecord).filter((r): r is ProofRecord => !!r),
        ...(typeof claudeConfig === "string" ? { config: claudeConfig } : {}),
      };
    }
  } catch {}
  return { rest: {}, proofs: [] };
}

function writeRecord(
  io: ProofIo,
  rest: Doc,
  proofs: ProofRecord[],
  config: string | undefined,
) {
  const out = {
    ...rest,
    ...(config ? { claudeConfig: config } : {}),
    ...(proofs.length ? { claudeProof: proofs } : {}),
  };
  io.write(io.record, `${JSON.stringify(out, null, 2)}\n`, 0o600);
}

const recordOf = (
  proofs: ProofRecord[],
  file: string,
  name: string,
  project?: string,
) =>
  proofs.findIndex(
    (r) =>
      (r.file ?? file) === file && r.entry === name && r.project === project,
  );

/** The token form's original, rebuilt from our own helper's `--token-file` (an adopted entry). */
const adoptedOriginal = (helper: string): string | null => {
  const f = /^T=\$\(cat (.+?)\) && \{ /.exec(helper)?.[1];
  return f
    ? `T=$(cat ${f}) && printf '{"Authorization":"Bearer %s"}' "$T"`
    : null;
};

export type Applied = { entry: string; scope: Scope };
export type ProofResult = {
  /** Why an entry was left alone. Never a header value. */
  notes: string[];
  /** The entries that were written. */
  changed: Applied[];
  /** Nothing was written: the file changed between the read and the write, or it is a symlink (guard only). */
  skipped?: true;
};

/**
 * Adds the helper to every entry for the instance in `io.file` (user scope and
 * each local scope), keeping a token entry's Authorization. Someone else's
 * helper is left alone, with a note. Running again changes nothing and writes
 * nothing. The file is recorded, so uninstall and the daemon use exactly it.
 * With `guard` (the unattended daemon): our own helper on an entry with no
 * record is not adopted, a symlinked file is not written, and the file is read
 * again just before the write, nothing written if it changed meanwhile:
 * Claude rewrites it while it runs.
 */
export function installProof(
  io: ProofIo,
  origin: string,
  busBin: string[],
  busHome?: string,
  opts: {
    guard?: boolean;
    instance?: InstanceTarget;
    /** #3075: another bus's helper is taken over when this says that bus has stopped. */
    stopped?: (owner: string | undefined) => boolean;
  } = {},
): ProofResult {
  const out: ProofResult = { notes: [], changed: [] };
  const read = io.read ?? readText;
  const text = read(io.file);
  const { rest, proofs, config } = readRecord(io.record);
  if (text === "") {
    // Recorded even before the file exists, so a later one is picked up.
    // An added instance never turns on main's automatic linking.
    if (!opts.guard && !opts.instance && config !== io.file)
      writeRecord(io, rest, proofs, io.file);
    return out;
  }
  const records = [...proofs];
  let next = text;
  for (const f of findEntries(
    parseJsonc(text, io.file),
    origin,
    opts.instance,
  )) {
    const at = recordOf(records, io.file, f.name, f.project);
    const rec = records[at];
    const cur = f.entry.headersHelper;
    let original: string | null;
    const foreign =
      typeof cur === "string" && isProofHelper(cur) && !ownedBy(cur, busHome);
    if (foreign && opts.stopped?.(helperHome(cur))) {
      // #3075: that bus no longer runs, so its helper links nothing. This bus
      // takes the entry, keeping a token entry's Authorization.
      original = adoptedOriginal(cur);
      out.notes.push(
        `took over the headersHelper of ${f.name} (${f.scope} scope) in ${io.file}: the bus at ${helperHome(cur) ?? "the default home"} no longer runs`,
      );
    } else if (foreign) {
      out.notes.push(
        `left the headersHelper of ${f.name} (${f.scope} scope) in ${io.file} as it is: it belongs to the bus at ${helperHome(cur) ?? "the default home"}`,
      );
      continue;
    } else if (isProofHelper(cur) && rec) original = rec.original;
    else if (isProofHelper(cur) && !opts.guard && typeof cur === "string")
      original = adoptedOriginal(cur);
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
      ...(opts.instance ? { instance: opts.instance.name } : {}),
    });
    if (cur === helper && rec) continue;
    const made: ProofRecord = {
      file: io.file,
      entry: f.name,
      ...(f.project === undefined ? {} : { project: f.project }),
      original,
    };
    if (at < 0) records.push(made);
    else records[at] = made;
    next = setJsoncValue(next, [...f.path, "headersHelper"], helper);
    out.changed.push({ entry: f.name, scope: f.scope });
  }
  const recorded = config === io.file;
  if (out.changed.length === 0 && (recorded || opts.guard || opts.instance))
    return out;
  if (opts.guard) {
    let link = false;
    try {
      link = lstatSync(io.file).isSymbolicLink();
    } catch {}
    if (link || read(io.file) !== text)
      return { notes: out.notes, changed: [], skipped: true };
  }
  // An added instance's entries are recorded for uninstall; main's config marker is left as it was.
  writeRecord(io, rest, records, opts.instance ? config : io.file);
  if (out.changed.length > 0) io.write(io.file, next);
  return out;
}

/** Puts every entry back as it was before `installProof`, in the file each was recorded in; false when there was nothing to undo. */
export function uninstallProof(io: ProofIo, busHome?: string): boolean {
  const { rest, proofs, config } = readRecord(io.record);
  if (proofs.length === 0) {
    if (config) writeRecord(io, rest, [], undefined);
    return false;
  }
  const texts = new Map<string, { before: string; text: string }>();
  let undone = false;
  for (const proof of proofs) {
    const file = proof.file ?? io.file;
    let t = texts.get(file);
    if (!t) {
      const before = (io.read ?? readText)(file);
      t = { before, text: before };
      texts.set(file, t);
    }
    const path = [
      ...(proof.project === undefined
        ? ["mcpServers"]
        : ["projects", proof.project, "mcpServers"]),
      proof.entry,
      "headersHelper",
    ];
    let cur: unknown;
    try {
      cur = t.text === "" ? undefined : jsoncValue(t.text, path);
    } catch {
      cur = undefined;
    }
    // Only our own helper is taken back: anything else is the user's since.
    if (
      typeof cur !== "string" ||
      !isProofHelper(cur) ||
      !ownedBy(cur, busHome)
    )
      continue;
    t.text =
      proof.original === null
        ? removeJsoncValue(t.text, path)
        : setJsoncValue(t.text, path, proof.original);
    undone = true;
  }
  for (const [file, t] of texts)
    if (t.text !== t.before) io.write(file, t.text);
  writeRecord(io, rest, [], undefined);
  return undone;
}

export type EntryState = {
  name: string;
  scope: Scope | "project";
  project?: string;
  state:
    | "helper"
    | "missing"
    | "foreign"
    | "unrecorded"
    | "other-bus"
    | "other-instance";
  /** For `other-bus`: the home that owns the helper; undefined is the default home. */
  owner?: string;
  /** Whether Claude trusts the folder, when its config says; undefined when it can't be read. */
  trusted?: boolean;
};

export type ProofReport = {
  entries: EntryState[];
  /** Same host, different address. */
  elsewhere: { name: string; scope: Scope | "project"; url: string }[];
  /** The Claude config is a symlink, which the daemon never writes through. */
  symlink: boolean;
};

const stateOf = (helper: unknown): "helper" | "missing" | "foreign" =>
  helper === undefined
    ? "missing"
    : isProofHelper(helper)
      ? "helper"
      : "foreign";

/**
 * Claude's trust flag for exactly this folder. A parent's does not count
 * (Claude lists it under "Trust that doesn't count"). Undefined when the config doesn't say.
 */
function trustOf(doc: Doc, dir: string): boolean | undefined {
  const p = isRecord(doc.projects) ? doc.projects[dir] : undefined;
  const t = isRecord(p) ? p.hasTrustDialogAccepted : undefined;
  return typeof t === "boolean" ? t : undefined;
}

/**
 * Read-only: every Claude entry for the instance, at user and local scope in
 * `file` and project scope in `projectFile` (the current folder's `.mcp.json`).
 * A project entry that a same-name local entry for `cwd` shadows is left out.
 * `recorded` is what install recorded: an entry with our helper that is not in
 * it was set up by another bus or an older install.
 */
export function proofReport(
  file: string,
  origin: string,
  opts: {
    projectFile?: string;
    cwd?: string;
    recorded?: ProofRecord[];
    /** This bus's home when it is not the default one. */
    busHome?: string;
    /** An added instance: entries are found by its address and need its own helper form. */
    instance?: InstanceTarget;
  } = {},
): ProofReport {
  const report: ProofReport = { entries: [], elsewhere: [], symlink: false };
  const read = (path: string): Doc | undefined => {
    try {
      const text = readText(path);
      return text === "" ? undefined : parseJsonc(text, path);
    } catch {
      return undefined;
    }
  };
  const doc = read(file);
  try {
    report.symlink = lstatSync(file).isSymbolicLink();
  } catch {}
  const localNames = new Set<string>();
  if (doc) {
    for (const f of findEntries(doc, origin, opts.instance)) {
      const base = stateOf(f.entry.headersHelper);
      const form =
        typeof f.entry.headersHelper === "string" && base === "helper"
          ? helperInstance(f.entry.headersHelper)
          : undefined;
      const wrongForm =
        base === "helper" &&
        (opts.instance
          ? form !== opts.instance.name
          : form !== undefined && form !== MAIN_INSTANCE);
      const known =
        opts.recorded === undefined ||
        recordOf(opts.recorded, file, f.name, f.project) >= 0;
      const trusted = trustOf(doc, f.project ?? "");
      const mine =
        typeof f.entry.headersHelper !== "string" ||
        !isProofHelper(f.entry.headersHelper) ||
        ownedBy(f.entry.headersHelper, opts.busHome);
      const owner =
        typeof f.entry.headersHelper === "string"
          ? helperHome(f.entry.headersHelper)
          : undefined;
      report.entries.push({
        name: f.name,
        scope: f.scope,
        ...(f.project === undefined ? {} : { project: f.project }),
        state: !mine
          ? "other-bus"
          : wrongForm
            ? "other-instance"
            : base === "helper" && !known
              ? "unrecorded"
              : base,
        ...(!mine && owner !== undefined ? { owner } : {}),
        ...(f.scope === "local" && trusted !== undefined ? { trusted } : {}),
      });
      if (f.scope === "local" && f.project === opts.cwd) localNames.add(f.name);
    }
    for (const f of findElsewhere(doc, origin, opts.instance))
      report.elsewhere.push({
        name: f.name,
        scope: f.scope,
        url: String(f.entry.url),
      });
  }
  const proj =
    opts.projectFile === undefined ? undefined : read(opts.projectFile);
  if (proj && isRecord(proj.mcpServers))
    for (const [name, entry] of Object.entries(proj.mcpServers)) {
      if (!isRecord(entry)) continue;
      if (matcherFor(origin, opts.instance)(entry)) {
        if (localNames.has(name)) continue;
        const trusted =
          doc && opts.cwd !== undefined ? trustOf(doc, opts.cwd) : undefined;
        report.entries.push({
          name,
          scope: "project",
          state: stateOf(entry.headersHelper),
          ...(trusted === undefined ? {} : { trusted }),
        });
      } else if (typeof entry.url === "string") {
        try {
          if (new URL(entry.url).hostname === new URL(origin).hostname)
            report.elsewhere.push({ name, scope: "project", url: entry.url });
        } catch {}
      }
    }
  return report;
}

/**
 * #2793 S4: after `oa-bus add`, gives the Claude entries whose address is the
 * new instance's the `--instance` helper. The same ownership rules as
 * installProof. `matched` counts the entries at that address, so the caller
 * can tell "none" from "left alone".
 */
export function addInstanceProof(
  io: ProofIo,
  target: InstanceTarget,
  busBin: string[],
  busHome?: string,
  stopped?: (owner: string | undefined) => boolean,
): ProofResult & { matched: number } {
  let matched = 0;
  try {
    const text = (io.read ?? readText)(io.file);
    if (text !== "")
      matched = findEntries(parseJsonc(text, io.file), "", target).length;
  } catch {}
  if (matched === 0) return { notes: [], changed: [], matched };
  return {
    ...installProof(io, "", busBin, busHome, {
      instance: target,
      ...(stopped ? { stopped } : {}),
    }),
    matched,
  };
}
