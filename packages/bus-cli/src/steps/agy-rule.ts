// agy S3: the one always-allow rule oa-bus saves in agy's settings, so the
// session can start its watcher outside agy's sandbox without asking the user
// every time (Leo's pick, 2026-11-26: "Save an always-allow rule at install").
//
// agy documents the CLI's rules as `permissions.allow` in
// ~/.gemini/antigravity-cli/settings.json: the Global scope of `/permissions`,
// the same list a prompt's "always allow (Persist to settings.json)" writes.
// We use this CLI scope, not the Shared one (`~/.gemini/config/config.json`,
// where agy 1.0.5 moved shared rules, which the Antigravity app also reads):
// the watcher needs the CLI's `agentapi` and runs only under the CLI, so the
// app has no use for the rule, and the CLI scope is the one whose format
// agy's docs give. The app never sees this rule. A `command(regex:...)` rule matches the whole raw line, so
// ours is anchored at both ends and matches the watcher's line and nothing
// else: never a prefix, never a wildcard. Only our string is added or
// removed; every other byte of the file stays as it was.

import { createHash, randomBytes } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { TOOLS } from "@oa/bus-adapter-claude-code";
import {
  jsoncValue,
  parseJsonc,
  removeIfEmpty,
  removeJsoncValue,
  setJsoncValue,
} from "@oa/bus-adapter-mcp-json";

export const agySettingsFile = (home: string) =>
  join(home, ".gemini", "antigravity-cli", "settings.json");

/** Where install writes down the rule it saved, so uninstall removes exactly that. */
export const agyRuleRecord = (busDir: string) => join(busDir, "agy-rule.json");

const reEscape = (s: string) => s.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");

/** The rule for exactly this command line: anchored, every character literal. */
export const agyWatchRule = (line: string): string =>
  `command(regex:^${reEscape(line)}$)`;

// Only these approved tools from the agy MCP server receive grants. New tools
// require their own decision before an installer can grant them.
const approvedTools = new Set([
  "fetch",
  "follow",
  "following",
  "list_agents",
  "self",
  "send_message",
  "set_status",
  "unfollow",
]);
const toolRules = TOOLS.filter(({ name }) => approvedTools.has(name)).map(
  ({ name }) => `mcp(oa_bus/${name})`,
);

type Lists = { allow: string[]; ask: string[]; deny: string[] };

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

function readText(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

function lists(text: string, file: string): Lists {
  const p = parseJsonc(text, file).permissions;
  if (
    p !== undefined &&
    (typeof p !== "object" || p === null || Array.isArray(p))
  )
    throw new Error(`${file}: permissions is not an object; left it untouched`);
  const doc = (p ?? {}) as Record<string, unknown>;
  for (const k of ["allow", "ask", "deny"])
    if (doc[k] !== undefined && !Array.isArray(doc[k]))
      throw new Error(
        `${file}: permissions.${k} is not a list; left it untouched`,
      );
  return {
    allow: strings(doc.allow),
    ask: strings(doc.ask),
    deny: strings(doc.deny),
  };
}

type Recorded = {
  file: string;
  rule: string;
  previousRules?: string[];
  toolRules: string[];
  made: string[][];
};

function readRecorded(busDir: string): Recorded | undefined {
  try {
    const v = JSON.parse(
      readFileSync(agyRuleRecord(busDir), "utf8"),
    ) as Recorded;
    if (typeof v.file === "string" && typeof v.rule === "string")
      return {
        file: v.file,
        rule: v.rule,
        previousRules: v.previousRules && strings(v.previousRules),
        toolRules: strings(v.toolRules).filter((r) => toolRules.includes(r)),
        made: Array.isArray(v.made) ? v.made : [],
      };
  } catch {}
  return undefined;
}

function writeAtomic(file: string, text: string, mode: number) {
  mkdirSync(dirname(file), { recursive: true });
  try {
    if (lstatSync(file).isSymbolicLink())
      throw new Error(`${file} is a symlink; left it untouched`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  let m = mode;
  try {
    m = statSync(file).mode & 0o777;
  } catch {}
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, text, { mode: m, flag: "wx" });
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** Removes one string from `permissions.allow`, by value, with its comma. */
function without(text: string, rule: string, file: string): string {
  let out = text;
  for (;;) {
    const i = lists(out, file).allow.indexOf(rule);
    if (i < 0) return out;
    // Index in the raw array (non-strings count too).
    const raw = jsoncValue(out, ["permissions", "allow"]) as unknown[];
    out = removeJsoncValue(out, ["permissions", "allow", raw.indexOf(rule)]);
  }
}

const routinePageTools = [
  "publish_artifact",
  "add_comment",
  "get_artifact",
  "list_artifacts",
  "search_artifacts",
  "list_versions",
  "list_comments",
  "edit_comment",
  "resolve_comment",
  "withdraw_ask",
  "get_comment_picture",
  "create_upload",
  "artifact_data_get",
  "artifact_data_list",
  "artifact_data_query",
  "artifact_data_set",
  "artifact_data_update",
  "artifact_data_delete",
  "bus_role_propose",
  "list_spaces",
] as const;

/** Called under the agy config lock. Each generated alias shares one ownership
 * record across bus homes. Only allow entries the installer added are removed. */
export function setAgyPageGrants(
  file: string,
  name: string,
  homeRecord: string,
  operation: "claim" | "release" | "invalidate",
  currentDigest: string | undefined,
) {
  // Names containing rule syntax cannot safely form an exact permission.
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) return;
  const stamp =
    file +
    ".oa-pages-" +
    createHash("sha256").update(name).digest("hex") +
    ".json";
  const data = readText(stamp);
  const enable = operation === "claim";
  if (!enable && data === undefined) return;
  const record: {
    digest?: string;
    homes: string[];
    tools: string[];
    made: string[][];
  } =
    data === undefined ? { homes: [], tools: [], made: [] } : JSON.parse(data);
  // A change of entry invalidates every claim tied to its old contents. A
  // stale home must also leave a newer, independently claimed entry intact.
  const changed =
    record.digest !== undefined
      ? record.digest !== currentDigest
      : operation === "invalidate";
  if (!enable && !changed && !record.homes.includes(homeRecord)) return;
  const text = readText(file) ?? "";
  let out = text;
  let homes = changed ? [] : record.homes.filter((h) => h !== homeRecord);
  if (enable) {
    homes = changed
      ? [homeRecord]
      : [...new Set([...record.homes, homeRecord])];
    record.digest = currentDigest;
    const perms = lists(text, file);
    if (!data)
      record.made = [["permissions", "allow"], ["permissions"]].filter(
        (p) => jsoncValue(text, p) === undefined,
      );
    const raw = jsoncValue(text, ["permissions", "allow"]);
    let next = Array.isArray(raw) ? raw.length : 0;
    for (const tool of routinePageTools) {
      const rule = `mcp(${name}/${tool})`;
      if (
        perms.allow.includes(rule) ||
        perms.ask.includes(rule) ||
        perms.deny.includes(rule)
      )
        continue;
      out = setJsoncValue(out, ["permissions", "allow", next++], rule);
      if (!record.tools.includes(tool)) record.tools.push(tool);
    }
  } else if (!homes.length) {
    for (const tool of [...routinePageTools].reverse()) {
      if (!record.tools.includes(tool)) continue;
      const raw = jsoncValue(out, ["permissions", "allow"]);
      const i = Array.isArray(raw) ? raw.indexOf(`mcp(${name}/${tool})`) : -1;
      if (i >= 0) out = removeJsoncValue(out, ["permissions", "allow", i]);
    }
    for (const path of record.made) out = removeIfEmpty(out, path);
  }
  // Journal additions before settings publication. On final removal retain
  // the last claim until settings commit, so uninstall can be retried.
  const nextRecord = JSON.stringify({ ...record, homes }) + "\n";
  if (homes.length && data !== nextRecord)
    writeAtomic(stamp, nextRecord, 0o600);
  if (out !== text) writeAtomic(file, out, 0o600);
  if (!homes.length) rmSync(stamp, { force: true });
}

/**
 * Saves our rule for `line`; true when the file changed. A rule an earlier
 * install saved for another line (a moved bus) is replaced, nothing else is.
 */
export function installAgyRule(
  home: string,
  busDir: string,
  line: string,
): boolean {
  const file = agySettingsFile(home);
  const rule = agyWatchRule(line);
  const text = readText(file) ?? "";
  const old = readRecorded(busDir);
  let out = text;
  const previousRules = new Set<string>();
  if (old?.file === file) {
    const allowed = lists(text, file).allow;
    for (const previous of [old.rule, ...(old.previousRules ?? [])]) {
      if (previous !== rule && allowed.includes(previous)) {
        previousRules.add(previous);
        out = without(out, previous, file);
      }
    }
  }
  const made =
    old?.file === file
      ? old.made
      : ([["permissions"], ["permissions", "allow"]] as string[][]).filter(
          (p) => jsoncValue(text, p) === undefined,
        );
  if (!lists(out, file).allow.includes(rule)) {
    const raw = jsoncValue(out, ["permissions", "allow"]);
    const n = Array.isArray(raw) ? raw.length : 0;
    out = setJsoncValue(out, ["permissions", "allow", n], rule);
  }
  const owned = new Set(old?.file === file ? old.toolRules : []);
  const allow = jsoncValue(out, ["permissions", "allow"]) as unknown[];
  let next = allow.length;
  for (const grant of toolRules) {
    if (allow.includes(grant)) continue;
    out = setJsoncValue(out, ["permissions", "allow", next++], grant);
    owned.add(grant);
  }
  mkdirSync(busDir, { recursive: true });
  const rec: Recorded = { file, rule, toolRules: [...owned], made };
  // Until settings are atomically replaced, either watcher's rule may be on disk.
  const pending = previousRules.size
    ? { ...rec, previousRules: [...previousRules] }
    : rec;
  const recordFile = agyRuleRecord(busDir);
  if (JSON.stringify(old) !== JSON.stringify(pending))
    writeAtomic(recordFile, `${JSON.stringify(pending)}\n`, 0o600);
  if (out !== text) writeAtomic(file, out, 0o600);
  if (previousRules.size)
    writeAtomic(recordFile, `${JSON.stringify(rec)}\n`, 0o600);
  return out !== text;
}

/**
 * Removes the rule install saved, and the containers install made for it when
 * they are empty again; true when the file changed. Without a record it
 * removes only the rule for `line`, when given.
 */
export function uninstallAgyRule(
  home: string,
  busDir: string,
  line?: string,
): boolean {
  const file = agySettingsFile(home);
  const rec = readRecorded(busDir);
  const rules = new Set<string>();
  if (rec?.file === file) {
    rules.add(rec.rule);
    for (const previous of rec.previousRules ?? []) rules.add(previous);
  }
  if (line !== undefined) rules.add(agyWatchRule(line));
  const text = readText(file);
  let out = text;
  if (text !== undefined) {
    if (rec?.file === file) {
      for (const grant of [...rec.toolRules].reverse()) {
        const allow = jsoncValue(out as string, ["permissions", "allow"]);
        const i = Array.isArray(allow) ? allow.indexOf(grant) : -1;
        if (i >= 0)
          out = removeJsoncValue(out as string, ["permissions", "allow", i]);
      }
    }
    for (const r of rules) out = without(out as string, r, file);
    if (out !== text)
      for (const p of [...(rec?.made ?? [])].sort(
        (a, b) => b.length - a.length,
      ))
        out = removeIfEmpty(out as string, p);
    if (out !== text) writeAtomic(file, out as string, 0o600);
  }
  rmSync(agyRuleRecord(busDir), { force: true });
  return out !== text;
}

/**
 * Doctor: `present` (ours, in the allow list, and no ask or deny rule names
 * it), `missing` (no rule of ours), `altered` (a rule for the watcher that is
 * not exactly ours, or ours also in ask or deny).
 */
export type AgyRuleState = "present" | "missing" | "altered";

export function agyRuleState(
  home: string,
  busDir: string,
  line: string | undefined,
): { state: AgyRuleState; file: string; missingTools: string[] } {
  const file = agySettingsFile(home);
  let l: Lists;
  try {
    l = lists(readText(file) ?? "", file);
  } catch {
    return { state: "altered", file, missingTools: [...toolRules] };
  }
  const missingTools = toolRules.filter(
    (r) => !l.allow.includes(r) || l.ask.includes(r) || l.deny.includes(r),
  );
  const rec = readRecorded(busDir);
  const want = line === undefined ? rec?.rule : agyWatchRule(line);
  const watcherRule = (r: string) => /agy-watch/.test(r);
  const all = [...l.allow, ...l.ask, ...l.deny];
  if (want !== undefined && l.allow.includes(want)) {
    const elsewhere = l.ask.includes(want) || l.deny.includes(want);
    const others = all.filter((r) => watcherRule(r) && r !== want);
    return {
      state: elsewhere || others.length ? "altered" : "present",
      file,
      missingTools,
    };
  }
  return {
    state: all.some(watcherRule) ? "altered" : "missing",
    file,
    missingTools,
  };
}
