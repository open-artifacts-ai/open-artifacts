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
 * Only the user-scope entry for this machine's instance gets it: Claude skips
 * helpers on untrusted project-scope entries.
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

/**
 * The user-scope entry that points at this instance's /mcp: HTTP, on `origin`.
 * Its name is the user's, so it is found by address.
 */
export function findEntry(
  doc: Doc,
  origin: string,
): { name: string; entry: Doc } | undefined {
  const servers = doc.mcpServers;
  if (!isRecord(servers)) return undefined;
  for (const [name, entry] of Object.entries(servers)) {
    if (!isRecord(entry) || typeof entry.url !== "string") continue;
    if (entry.type !== undefined && entry.type !== "http") continue;
    try {
      const u = new URL(entry.url);
      if (u.origin === origin && u.pathname.replace(/\/+$/, "") === "/mcp")
        return { name, entry };
    } catch {}
  }
  return undefined;
}

export type ProofRecord = { entry: string; original: string | null };
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

function readRecord(path: string): { rest: Doc; proof?: ProofRecord } {
  try {
    const v: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (isRecord(v)) {
      const { claudeProof, ...rest } = v;
      const p = claudeProof;
      if (
        isRecord(p) &&
        typeof p.entry === "string" &&
        (typeof p.original === "string" || p.original === null)
      )
        return { rest, proof: { entry: p.entry, original: p.original } };
      return { rest };
    }
  } catch {}
  return { rest: {} };
}

function writeRecord(io: ProofIo, rest: Doc, proof?: ProofRecord) {
  const out = proof ? { ...rest, claudeProof: proof } : rest;
  io.write(io.record, `${JSON.stringify(out, null, 2)}\n`, 0o600);
}

/**
 * Adds the helper to the instance's entry, keeping a token entry's
 * Authorization. Returns a note when it left the entry alone, or undefined.
 * Running again changes nothing.
 */
export function installProof(
  io: ProofIo,
  origin: string,
  busBin: string[],
  busHome?: string,
): string | undefined {
  const text = readText(io.file);
  if (text === "") return undefined;
  const found = findEntry(parseJsonc(text, io.file), origin);
  if (!found) return undefined;
  const cur = found.entry.headersHelper;
  const { rest, proof } = readRecord(io.record);
  let original: string | null;
  if (isProofHelper(cur) && proof?.entry === found.name)
    original = proof.original;
  else if (cur === undefined) original = null;
  else if (typeof cur === "string" && TOKEN_HELPER.test(cur)) original = cur;
  else
    return `left the headersHelper of ${found.name} in ${io.file} as it is: it is not one oa-bus knows`;
  const tokenFile = original?.match(TOKEN_HELPER)?.[1];
  const helper = proofHelper(busBin, {
    ...(tokenFile ? { tokenFile } : {}),
    ...(busHome ? { busHome } : {}),
  });
  if (cur === helper && proof?.entry === found.name) return undefined;
  writeRecord(io, rest, { entry: found.name, original });
  io.write(
    io.file,
    setJsoncValue(text, ["mcpServers", found.name, "headersHelper"], helper),
  );
  return undefined;
}

/** Puts the entry back as it was before `installProof`; false when there was nothing to undo. */
export function uninstallProof(io: ProofIo): boolean {
  const { rest, proof } = readRecord(io.record);
  if (!proof) return false;
  const text = readText(io.file);
  const path = ["mcpServers", proof.entry, "headersHelper"];
  let cur: unknown;
  try {
    cur = text === "" ? undefined : jsoncValue(text, path);
  } catch {
    cur = undefined;
  }
  // Only our own helper is taken back: anything else is the user's since.
  if (isProofHelper(cur))
    io.write(
      io.file,
      proof.original === null
        ? removeJsoncValue(text, path)
        : setJsoncValue(text, path, proof.original),
    );
  writeRecord(io, rest);
  return isProofHelper(cur);
}

/** Whether this machine's entry has the helper: `none` when there is no entry to give it to. */
export function proofState(
  file: string,
  origin: string,
): "helper" | "missing" | "none" {
  try {
    const found = findEntry(parseJsonc(readText(file), file), origin);
    if (!found) return "none";
    return isProofHelper(found.entry.headersHelper) ? "helper" : "missing";
  } catch {
    return "none";
  }
}
