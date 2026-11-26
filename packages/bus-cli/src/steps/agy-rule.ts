// agy S3: the one always-allow rule oa-bus saves in agy's settings, so the
// session can start its watcher outside agy's sandbox without asking the user
// every time (Leo's pick, 2026-11-26: "Save an always-allow rule at install").
//
// agy documents the CLI's rules as `permissions.allow` in
// ~/.gemini/antigravity-cli/settings.json: the Global scope of `/permissions`,
// the same list a prompt's "always allow (Persist to settings.json)" writes.
// (The Shared scope lives in the app's binary user_settings.pb, which is not
// ours to edit.) A `command(regex:...)` rule matches the whole raw line, so
// ours is anchored at both ends and matches the watcher's line and nothing
// else: never a prefix, never a wildcard. Only our string is added or
// removed; every other byte of the file stays as it was.

import { randomBytes } from "node:crypto";
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

type Recorded = { file: string; rule: string; made: string[][] };

function readRecorded(busDir: string): Recorded | undefined {
  try {
    const v = JSON.parse(
      readFileSync(agyRuleRecord(busDir), "utf8"),
    ) as Recorded;
    if (typeof v.file === "string" && typeof v.rule === "string")
      return {
        file: v.file,
        rule: v.rule,
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
  if (old && old.file === file && old.rule !== rule)
    out = without(out, old.rule, file);
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
  if (out !== text) writeAtomic(file, out, 0o600);
  mkdirSync(busDir, { recursive: true });
  const rec: Recorded = { file, rule, made };
  if (JSON.stringify(old) !== JSON.stringify(rec))
    writeAtomic(agyRuleRecord(busDir), `${JSON.stringify(rec)}\n`, 0o600);
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
  if (rec?.file === file) rules.add(rec.rule);
  if (line !== undefined) rules.add(agyWatchRule(line));
  const text = readText(file);
  let out = text;
  if (text !== undefined) {
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
): { state: AgyRuleState; file: string } {
  const file = agySettingsFile(home);
  let l: Lists;
  try {
    l = lists(readText(file) ?? "", file);
  } catch {
    return { state: "altered", file };
  }
  const rec = readRecorded(busDir);
  const want = line === undefined ? rec?.rule : agyWatchRule(line);
  const watcherRule = (r: string) => /agy-watch/.test(r);
  const all = [...l.allow, ...l.ask, ...l.deny];
  if (want !== undefined && l.allow.includes(want)) {
    const elsewhere = l.ask.includes(want) || l.deny.includes(want);
    const others = all.filter((r) => watcherRule(r) && r !== want);
    return { state: elsewhere || others.length ? "altered" : "present", file };
  }
  return { state: all.some(watcherRule) ? "altered" : "missing", file };
}
