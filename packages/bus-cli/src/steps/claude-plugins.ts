// Our Claude Code plugins (#2095): the session shortcuts and the Artifacts
// Teammate output style, installed through Claude Code's own marketplace
// commands at user scope. Every `claude` call goes through the injected exec,
// with a timeout and a closed stdin, and asks for --json.
//
// Ownership: what we added is recorded in install.json as
//   claudePlugins: { marketplace: boolean, plugins: string[] }
// and uninstall reverses only that. A marketplace called "open-artifacts" that
// does not come from our repo is never touched. A plugin that was already
// installed is never recorded, so it is never removed.

import { join } from "node:path";
import type { Deps } from "../deps.ts";
import { selectOutputStyle } from "./output-style.ts";
import { readInstallFile, updateInstallFile } from "./step.ts";

export const MARKETPLACE = "open-artifacts";
export const STYLE_PLUGIN = `open-artifacts@${MARKETPLACE}`;
export const SHORTCUTS_PLUGIN = `open-artifacts-shortcuts@${MARKETPLACE}`;
export const PLUGIN_REPO = "open-artifacts-ai/open-artifacts";
export const PLUGIN_REPO_URL = `https://github.com/${PLUGIN_REPO}.git`;
/** The Mods API (the shortcuts plugin's hooks) needs this Claude Code. */
export const MIN_CLAUDE = "2.1.319";
export const DEFAULT_MCP_SERVER = "open-artifacts";
const SPARSE = [".claude-plugin", "plugins", "packages/claude-code-shortcuts"];
const CALL_MS = 120_000;
const MCP_LIST_MS = 20_000;

type Exec = Deps["exec"];

type Where = {
  home: string;
  busHome: string;
  env?: Record<string, string | undefined>;
  exec: Exec;
};

type Record_ = { marketplace?: boolean; plugins?: string[] };

export type ClaudePluginsResult = {
  /** Lines to show, already worded. */
  notes: string[];
  /** The Claude Code plugins are installed (or were already). */
  ok?: boolean;
  /** We turned the output style on in this run. */
  styleOn?: boolean;
  /** The person's own style choice, when it stays. */
  keptStyle?: string;
  keptStyleFirst?: boolean;
};

export const readRecord = (busHome: string): Record_ | undefined => {
  const r = readInstallFile(join(busHome, "install.json")).claudePlugins;
  return typeof r === "object" && r !== null ? (r as Record_) : undefined;
};

const writeRecord = (busHome: string, r: Record_ | undefined) =>
  updateInstallFile(join(busHome, "install.json"), { claudePlugins: r });

const cmp = (a: string, b: string) => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
};

/** `claude plugin marketplace add` source: the release tag that matches this CLI, else the default branch. */
export const marketplaceSource = (version: string): string =>
  /^\d+\.\d+\.\d+$/.test(version) && version !== "0.0.0"
    ? `${PLUGIN_REPO_URL}#v${version}`
    : PLUGIN_REPO_URL;

const json = (stdout: string): unknown => {
  // The result is the last line on stdout.
  const lines = stdout.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i] as string);
    } catch {}
  }
  try {
    return JSON.parse(stdout);
  } catch {
    return undefined;
  }
};

type Reply = {
  ok: boolean;
  code: string | undefined;
  message: string;
  data: unknown;
};

const claude = async (
  exec: Exec,
  args: string[],
  timeoutMs = CALL_MS,
): Promise<Reply & { missing: boolean }> => {
  const r = await exec("claude", args, { timeoutMs });
  const data = json(r.stdout);
  const o = (typeof data === "object" && data !== null ? data : {}) as Record<
    string,
    unknown
  >;
  const message =
    (typeof o.message === "string" ? o.message : undefined) ??
    (r.stderr.trim() || r.stdout.trim()).split("\n")[0] ??
    "";
  return {
    ok: r.code === 0 && (o.outcome === undefined || o.outcome === "ok"),
    code: typeof o.failureCode === "string" ? o.failureCode : undefined,
    message,
    data,
    missing: r.code !== 0 && /ENOENT|not found/i.test(r.stderr),
  };
};

/** The installed Claude Code version, or why there is none. */
export async function claudeVersion(
  exec: Exec,
): Promise<{ version: string } | { missing: true } | { unreadable: true }> {
  const r = await exec("claude", ["--version"], { timeoutMs: 20_000 });
  if (r.code !== 0)
    return /ENOENT/.test(r.stderr) ? { missing: true } : { unreadable: true };
  const m = /(\d+\.\d+\.\d+)/.exec(r.stdout);
  return m ? { version: m[1] as string } : { unreadable: true };
}

type Market = {
  name?: string;
  source?: string;
  repo?: string;
  url?: string;
  ref?: string;
};

const isOurs = (m: Market): boolean => {
  const norm = (u: string | undefined) =>
    (u ?? "")
      .replace(/^(https?:\/\/github\.com\/|git@github\.com:)/, "")
      .replace(/\.git$/, "")
      .toLowerCase();
  return (
    (m.source === "github" && norm(m.repo) === PLUGIN_REPO) ||
    (m.source === "git" && norm(m.url) === PLUGIN_REPO)
  );
};

type Installed = { id?: string };

/** The ids of installed plugins, or undefined when the list could not be read. */
async function listInstalled(exec: Exec): Promise<string[] | undefined> {
  const r = await claude(exec, ["plugin", "list", "--json"]);
  if (!r.ok || !Array.isArray(r.data)) return undefined;
  return (r.data as Installed[]).flatMap((p) =>
    typeof p.id === "string" ? [p.id] : [],
  );
}

/**
 * The tool namespace of the person's own Open Artifacts connection: the line
 * of `claude mcp list` whose URL has the instance's origin. No secret is
 * read: the list shows name, URL and health only.
 */
export async function mcpNamespace(
  exec: Exec,
  origin: string,
): Promise<{ name: string } | { why: "timeout" | "none" }> {
  const r = await exec("claude", ["mcp", "list"], { timeoutMs: MCP_LIST_MS });
  if (r.code !== 0) return { why: "timeout" };
  for (const line of r.stdout.split("\n")) {
    const m = /^(.+?): (https?:\/\/\S+)/.exec(line.trim());
    if (!m) continue;
    try {
      if (new URL(m[2] as string).origin === origin)
        return { name: m[1] as string };
    } catch {}
  }
  return { why: "none" };
}

const originOf = (url: string): string | undefined => {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
};

/**
 * Adds our marketplace, installs both plugins, configures the shortcuts for
 * this instance, and moves the output style over to the plugin. Only when
 * Claude Code is among the harnesses. Never throws on a claude failure: the
 * result carries the notes.
 */
export async function installClaudePlugins(
  deps: Where & {
    version: string;
    /** The instance origin. Without it the shortcuts are installed but not configured. */
    origin: string | undefined;
    copy: ClaudeCopy;
  },
  harnesses: string[],
): Promise<ClaudePluginsResult> {
  const out: ClaudePluginsResult = { notes: [] };
  if (!harnesses.includes("claude")) return out;
  const { exec, copy } = deps;
  const v = await claudeVersion(exec);
  if ("missing" in v) {
    out.notes.push(...copy.pluginsNoClaude());
    return out;
  }
  if ("unreadable" in v || cmp(v.version, MIN_CLAUDE) < 0) {
    out.notes.push(
      ...copy.pluginsTooOld("version" in v ? v.version : undefined, MIN_CLAUDE),
    );
    return out;
  }
  const prior = readRecord(deps.busHome);

  // The marketplace: ours is reused, a foreign one of the same name is left alone.
  const listed = await claude(exec, [
    "plugin",
    "marketplace",
    "list",
    "--json",
  ]);
  if (!listed.ok || !Array.isArray(listed.data)) {
    out.notes.push(
      ...copy.pluginsFailed("read the marketplaces", listed.message),
    );
    return out;
  }
  const there = (listed.data as Market[]).find((m) => m.name === MARKETPLACE);
  if (there && !isOurs(there)) {
    out.notes.push(...copy.pluginsForeignMarketplace(MARKETPLACE));
    return out;
  }
  const source = marketplaceSource(deps.version);
  const wantRef = source.includes("#") ? source.split("#")[1] : undefined;
  let addedNow = false;
  if (!there || (wantRef && there.ref !== wantRef)) {
    const r = await claude(exec, [
      "plugin",
      "marketplace",
      "add",
      source,
      "--sparse",
      ...SPARSE,
      "--json",
    ]);
    if (!r.ok) {
      out.notes.push(...copy.pluginsFailed("add the plugin source", r.message));
      return out;
    }
    addedNow = !there;
  }
  const marketplace = (prior?.marketplace ?? false) || addedNow;

  // The plugins: only ones that were not there are ours.
  const before = await listInstalled(exec);
  if (before === undefined) {
    out.notes.push(...copy.pluginsFailed("list the plugins", "no list"));
    saveRecord(deps.busHome, marketplace, prior?.plugins ?? []);
    return out;
  }
  const mine = new Set(prior?.plugins ?? []);
  const live = new Set<string>();

  // The shortcuts' options. The namespace stays as it was when it cannot be found.
  const config: string[] = [];
  const fresh = !before.includes(SHORTCUTS_PLUGIN);
  const origin = deps.origin;
  if (origin) {
    config.push("--config", `instanceUrl=${origin}/mcp`);
    const ns = await mcpNamespace(exec, origin);
    if ("name" in ns) config.push("--config", `mcpServer=${ns.name}`);
    else {
      if (fresh) config.push("--config", `mcpServer=${DEFAULT_MCP_SERVER}`);
      out.notes.push(
        ...copy.pluginsNoNamespace(ns.why === "timeout", DEFAULT_MCP_SERVER),
      );
    }
  }
  for (const id of [STYLE_PLUGIN, SHORTCUTS_PLUGIN]) {
    const r = await claude(exec, [
      "plugin",
      "install",
      id,
      ...(id === SHORTCUTS_PLUGIN ? config : []),
      "--json",
    ]);
    if (!r.ok) {
      out.notes.push(...copy.pluginsFailed(`install ${id}`, r.message));
      continue;
    }
    live.add(id);
    if (!before.includes(id)) mine.add(id);
  }
  saveRecord(deps.busHome, marketplace, [...mine]);

  if (live.has(STYLE_PLUGIN)) {
    try {
      const style = selectOutputStyle({
        home: deps.home,
        env: deps.env,
        busHome: deps.busHome,
      });
      out.notes.push(...style.notes);
      if (style.settings === "set") out.styleOn = true;
      else if (style.settings === "kept") {
        out.keptStyle = style.kept;
        out.keptStyleFirst = !before.includes(STYLE_PLUGIN);
      }
    } catch (e) {
      out.notes.push(
        ...copy.pluginsFailed(
          "select the output style",
          e instanceof Error ? e.message : String(e),
        ),
      );
    }
  }
  out.ok = live.size === 2;
  return out;
}

function saveRecord(busHome: string, marketplace: boolean, plugins: string[]) {
  if (!marketplace && plugins.length === 0) return;
  writeRecord(busHome, { marketplace, plugins });
}

/** The lines the step prints; supplied by copy.ts so Product owns the wording. */
export type ClaudeCopy = {
  pluginsNoClaude: () => string[];
  pluginsTooOld: (found: string | undefined, min: string) => string[];
  pluginsForeignMarketplace: (name: string) => string[];
  pluginsFailed: (what: string, why: string) => string[];
  pluginsNoNamespace: (timedOut: boolean, fallback: string) => string[];
};

/**
 * Removes what we recorded: our plugins, then the marketplace when we added it
 * and no other plugin from it remains. Notes carry the manual commands when
 * claude cannot run.
 */
export async function uninstallClaudePlugins(
  deps: Where & { copy: ClaudeUninstallCopy },
): Promise<{ notes: string[] }> {
  const notes: string[] = [];
  const rec = readRecord(deps.busHome);
  if (!rec) return { notes };
  const { exec, copy } = deps;
  const ids = rec.plugins ?? [];
  const manual = [
    ...ids.map((id) => `claude plugin uninstall ${id}`),
    ...(rec.marketplace
      ? [`claude plugin marketplace remove ${MARKETPLACE}`]
      : []),
  ];
  const v = await claudeVersion(exec);
  if (!("version" in v)) {
    notes.push(...copy.pluginsUninstallNoClaude(manual));
    writeRecord(deps.busHome, undefined);
    return { notes };
  }
  let failed = false;
  for (const id of ids) {
    const r = await claude(exec, ["plugin", "uninstall", id, "--json"]);
    if (!r.ok && r.code !== "not_installed") {
      failed = true;
      notes.push(...copy.pluginsUninstallFailed(id, r.message));
    }
  }
  if (rec.marketplace && !failed) {
    const left = await listInstalled(exec);
    const others = (left ?? [`?@${MARKETPLACE}`]).filter((id) =>
      id.endsWith(`@${MARKETPLACE}`),
    );
    if (others.length === 0) {
      const r = await claude(exec, [
        "plugin",
        "marketplace",
        "remove",
        MARKETPLACE,
        "--json",
      ]);
      if (!r.ok && r.code !== "not_configured")
        notes.push(...copy.pluginsUninstallFailed(MARKETPLACE, r.message));
    }
  }
  // Kept when a step failed, so a rerun finishes the job.
  if (!failed) writeRecord(deps.busHome, undefined);
  return { notes };
}

export type ClaudeUninstallCopy = {
  pluginsUninstallNoClaude: (manual: string[]) => string[];
  pluginsUninstallFailed: (what: string, why: string) => string[];
};

export type PluginsState = {
  /** Recorded plugins that are missing from Claude Code's list. */
  missing: string[];
  /** The shortcuts have no instance URL. */
  unconfigured: boolean;
  /** Claude Code could not be asked. */
  unknown?: true;
};

/** For doctor: undefined when we installed nothing. Read-only. */
export async function claudePluginsState(
  deps: Where,
): Promise<PluginsState | undefined> {
  const rec = readRecord(deps.busHome);
  if (!rec?.plugins?.length) return undefined;
  const listed = await listInstalled(deps.exec);
  if (listed === undefined)
    return { missing: [], unconfigured: false, unknown: true };
  const missing = rec.plugins.filter((id) => !listed.includes(id));
  let unconfigured = false;
  if (
    rec.plugins.includes(SHORTCUTS_PLUGIN) &&
    !missing.includes(SHORTCUTS_PLUGIN)
  ) {
    const c = await claude(deps.exec, [
      "plugin",
      "configure",
      SHORTCUTS_PLUGIN,
      "--json",
    ]);
    const d = c.data as { inputs?: { instanceUrl?: string } } | undefined;
    unconfigured = !(
      c.ok && originOf(d?.inputs?.instanceUrl ?? "") !== undefined
    );
  }
  return { missing, unconfigured };
}
