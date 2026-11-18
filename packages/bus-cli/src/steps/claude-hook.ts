// The Claude Code hook that refuses `oa-bus add` and `oa-bus use` from an agent
// (#2793 S5a). Install writes the script to <busHome>/hooks and adds one
// PreToolUse entry (matcher "Bash|Monitor") to Claude Code's settings.json. Ours is the
// entry whose command names HOOK_FILE: install is idempotent on it, and
// uninstall removes only it. A hook the person wrote is never touched. A
// settings.json that is a symlink or does not parse is left alone.
// Single-instance installs get it too: add and use are person-only commands.

import { lstatSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  jsoncValue,
  parseJsonc,
  removeIfEmpty,
  removeJsoncValue,
  setJsoncValue,
} from "@oa/bus-adapter-mcp-json";
import { HOOK_SCRIPT } from "./claude-hook-script.ts";
import { claudeSettingsFile } from "./output-style.ts";
import { writeAtomic } from "./skill.ts";
import { readInstallFile, updateInstallFile } from "./step.ts";

export const HOOK_FILE = "oa-bus-refuse-add-use.mjs";

type Where = {
  home: string;
  busHome: string;
  env?: Record<string, string | undefined>;
  /** The node that runs the script. */
  execPath: string;
};

type Result = { notes: string[]; changed: boolean };

const hookPath = (busHome: string) => join(busHome, "hooks", HOOK_FILE);
const q = (v: string) => JSON.stringify(v);

/** The hook command: quoted node, script, and the bus home (another way to name the bin). */
export const hookCommand = (w: Pick<Where, "busHome" | "execPath">) =>
  `${q(w.execPath)} ${q(hookPath(w.busHome))} ${q(w.busHome)}`;

const isOurs = (e: unknown): boolean => {
  const hooks = (e as { hooks?: unknown } | null)?.hooks;
  return (
    Array.isArray(hooks) &&
    hooks.some(
      (h) =>
        typeof (h as { command?: unknown } | null)?.command === "string" &&
        ((h as { command: string }).command as string).includes(HOOK_FILE),
    )
  );
};

const isLink = (p: string) => {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

type Read =
  | { ok: true; text: string | undefined; list: unknown[] }
  | { ok: false; why: string };

const read = (path: string): Read => {
  if (isLink(path)) return { ok: false, why: "it is a symlink" };
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { ok: true, text: undefined, list: [] };
  }
  try {
    parseJsonc(text, path);
    if (text.trim() === "") return { ok: true, text: undefined, list: [] };
    const hooks = jsoncValue(text, ["hooks"]);
    if (
      hooks !== undefined &&
      (typeof hooks !== "object" || hooks === null || Array.isArray(hooks))
    )
      return { ok: false, why: "hooks is not an object" };
    const list = jsoncValue(text, ["hooks", "PreToolUse"]);
    if (list !== undefined && !Array.isArray(list))
      return { ok: false, why: "hooks.PreToolUse is not a list" };
    return { ok: true, text, list: (list as unknown[] | undefined) ?? [] };
  } catch {
    return { ok: false, why: "it is not valid JSON" };
  }
};

const entry = (w: Where) => ({
  matcher: "Bash|Monitor",
  hooks: [{ type: "command", command: hookCommand(w) }],
});

/** Writes the script and adds our PreToolUse entry. Idempotent. */
export function installClaudeHook(w: Where): Result {
  const out: Result = { notes: [], changed: false };
  const path = claudeSettingsFile(w);
  const cur = read(path);
  if (!cur.ok) {
    out.notes.push(
      `Left ${path} alone: ${cur.why}, so the hook that keeps agents from running oa-bus add and oa-bus use was not added.`,
    );
    return out;
  }
  const want = entry(w);
  const i = cur.list.findIndex(isOurs);
  if (i >= 0 && JSON.stringify(cur.list[i]) === JSON.stringify(want)) {
    // Already there: only make sure the script is current.
    writeAtomic(hookPath(w.busHome), HOOK_SCRIPT);
    return out;
  }
  try {
    writeAtomic(hookPath(w.busHome), HOOK_SCRIPT);
    const base = cur.text ?? "{}\n";
    const next = setJsoncValue(
      base,
      ["hooks", "PreToolUse", i >= 0 ? i : cur.list.length],
      want,
    );
    writeAtomic(path, next);
    // A file that exists only because the output style step made it is ours to remove too.
    const styleMade =
      cur.text !== undefined &&
      Object.keys(parseJsonc(cur.text, path)).join() === "outputStyle" &&
      (
        readInstallFile(join(w.busHome, "install.json")).outputStyle as
          | { createdFile?: boolean }
          | undefined
      )?.createdFile === true;
    if (cur.text === undefined || styleMade)
      updateInstallFile(join(w.busHome, "install.json"), {
        claudeHook: { createdFile: true },
      });
    out.changed = true;
  } catch (e) {
    out.notes.push(
      `Left ${path} alone: could not edit it (${e instanceof Error ? e.message : String(e)}).`,
    );
  }
  return out;
}

/** Removes only our entry (and what it leaves empty), and our script. */
export function uninstallClaudeHook(w: Omit<Where, "execPath">): Result {
  const out: Result = { notes: [], changed: false };
  const path = claudeSettingsFile(w);
  const cur = read(path);
  if (!cur.ok) {
    out.notes.push(`Left ${path} alone: ${cur.why}.`);
  } else if (cur.text !== undefined) {
    const mine = cur.list.flatMap((e, i) => (isOurs(e) ? [i] : []));
    if (mine.length > 0) {
      try {
        let next = cur.text;
        for (const i of mine.reverse())
          next = removeJsoncValue(next, ["hooks", "PreToolUse", i]);
        if (cur.list.length === mine.length) {
          next = removeIfEmpty(next, ["hooks", "PreToolUse"]);
          next = removeIfEmpty(next, ["hooks"]);
        }
        // A file we created (see install) goes when nothing is left.
        const rec = readInstallFile(join(w.busHome, "install.json"));
        const made = (k: string) =>
          (rec[k] as { createdFile?: boolean } | undefined)?.createdFile ===
          true;
        const created = made("claudeHook");
        const empty = JSON.stringify(parseJsonc(next, path)) === "{}";
        if (created && empty && !/\/\/|\/\*/.test(next)) rmSync(path);
        else writeAtomic(path, next);
        out.changed = true;
      } catch (e) {
        out.notes.push(
          `Left ${path} alone: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }
  try {
    rmSync(hookPath(w.busHome), { force: true });
    updateInstallFile(join(w.busHome, "install.json"), {
      claudeHook: undefined,
    });
  } catch {}
  return out;
}
