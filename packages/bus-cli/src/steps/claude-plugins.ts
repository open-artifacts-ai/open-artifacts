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

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Deps } from "../deps.ts";
import { claudeSettingsFile, selectOutputStyle } from "./output-style.ts";
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

export const cmpVersion = (a: string, b: string) => {
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
  // `list --json` prints one multi-line document; the others print one line.
  try {
    return JSON.parse(stdout);
  } catch {}
  // Otherwise the result is the last line on stdout.
  const lines = stdout.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i] as string);
    } catch {}
  }
  return undefined;
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
 * Whether the person's Open Artifacts MCP server (`claude mcp get open-artifacts`)
 * points at this instance. `get` asks about one server only, so no other one
 * (a stdio server, say) is started. No secret is read: the output shows the
 * name, type and URL. A non-zero exit that is not "no such server" is an
 * error, not a timeout.
 */
export async function mcpNamespace(
  exec: Exec,
  origin: string,
): Promise<{ name: string } | { why: "timeout" | "none" | "error" }> {
  const r = await exec("claude", ["mcp", "get", DEFAULT_MCP_SERVER], {
    timeoutMs: MCP_LIST_MS,
  });
  if (r.code !== 0) {
    const text = `${r.stdout}\n${r.stderr}`;
    if (/No MCP server named/i.test(text)) return { why: "none" };
    return { why: /timed out/i.test(text) ? "timeout" : "error" };
  }
  const m = /^\s*URL:\s*(\S+)/m.exec(r.stdout);
  if (m && originOf(m[1] as string) === origin)
    return { name: DEFAULT_MCP_SERVER };
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
  if ("unreadable" in v || cmpVersion(v.version, MIN_CLAUDE) < 0) {
    out.notes.push(
      ...copy.pluginsTooOld("version" in v ? v.version : undefined, MIN_CLAUDE),
    );
    return out;
  }
  let prior = readRecord(deps.busHome);

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
    // The marketplace of that name is not ours any more: uninstall must not remove it.
    if (prior?.marketplace)
      writeRecord(
        deps.busHome,
        prior.plugins?.length
          ? { marketplace: false, plugins: prior.plugins }
          : undefined,
      );
    return out;
  }
  const source = marketplaceSource(deps.version);
  const wantRef = source.includes("#") ? source.split("#")[1] : undefined;
  const addSource = () =>
    claude(exec, [
      "plugin",
      "marketplace",
      "add",
      source,
      "--sparse",
      ...SPARSE,
      "--json",
    ]);
  let marketplace = prior?.marketplace ?? false;
  if (!there) {
    const r = await addSource();
    if (!r.ok) {
      // A timed-out add may still have landed: if it did, it is ours and recorded.
      const again = await claude(exec, [
        "plugin",
        "marketplace",
        "list",
        "--json",
      ]);
      const landed =
        again.ok &&
        Array.isArray(again.data) &&
        (again.data as Market[]).some(
          (m) => m.name === MARKETPLACE && isOurs(m),
        );
      if (landed) saveRecord(deps.busHome, true, prior?.plugins ?? []);
      out.notes.push(...copy.pluginsFailed("add the plugin source", r.message));
      return out;
    }
    marketplace = true;
  } else if (wantRef && there.ref !== wantRef) {
    // Claude Code refuses to re-add the same name from another source ("declared"), so
    // moving to this release means removing ours first. That uninstalls its plugins, so
    // it is done only when we added the marketplace and every plugin from it is ours.
    const have = await listInstalled(exec);
    const ours = new Set(prior?.plugins ?? []);
    const fromIt = (have ?? []).filter((id) => id.endsWith(`@${MARKETPLACE}`));
    const mayRepin =
      prior?.marketplace === true &&
      have !== undefined &&
      fromIt.every((id) => ours.has(id));
    if (!mayRepin) {
      out.notes.push(...copy.pluginsKeptSource(there.ref));
    } else {
      const gone = await claude(exec, [
        "plugin",
        "marketplace",
        "remove",
        MARKETPLACE,
        "--json",
      ]);
      if (!gone.ok && gone.code !== "not_configured") {
        out.notes.push(
          ...copy.pluginsFailed("move the plugin source", gone.message),
        );
        return out;
      }
      // Nothing of ours is left in Claude Code; the record follows.
      writeRecord(deps.busHome, undefined);
      prior = undefined;
      marketplace = false;
      const r = await addSource();
      if (!r.ok) {
        out.notes.push(
          ...copy.pluginsFailed("add the plugin source", r.message),
        );
        return out;
      }
      marketplace = true;
    }
  }

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
  // Options go only to a shortcuts plugin we installed: never to the person's own.
  const ownShortcuts = fresh || mine.has(SHORTCUTS_PLUGIN);
  const origin = deps.origin;
  if (!ownShortcuts) {
    // The person's own install keeps its options.
  } else if (origin !== undefined && originOf(origin) !== origin) {
    out.notes.push(...copy.pluginsBadInstance());
  } else if (origin) {
    config.push("--config", `instanceUrl=${origin}/mcp`);
    const ns = await mcpNamespace(exec, origin);
    if ("name" in ns) config.push("--config", `mcpServer=${ns.name}`);
    else {
      if (fresh) config.push("--config", `mcpServer=${DEFAULT_MCP_SERVER}`);
      out.notes.push(...copy.pluginsNoNamespace(ns.why, DEFAULT_MCP_SERVER));
    }
  }
  for (const id of [STYLE_PLUGIN, SHORTCUTS_PLUGIN]) {
    const opts = id === SHORTCUTS_PLUGIN ? config : [];
    const r = await claude(exec, ["plugin", "install", id, ...opts, "--json"]);
    if (!r.ok) {
      out.notes.push(...copy.pluginsFailed(`install ${id}`, r.message));
      continue;
    }
    live.add(id);
    if (!before.includes(id)) mine.add(id);
    // Already installed and a newer version is on offer: update, then set the options again.
    const d = r.data as
      | { installedVersion?: string; availableVersion?: string }
      | undefined;
    if (
      before.includes(id) &&
      d?.installedVersion &&
      d.availableVersion &&
      d.installedVersion !== d.availableVersion
    ) {
      const u = await claude(exec, [
        "plugin",
        "update",
        id,
        "--scope",
        "user",
        "--json",
      ]);
      if (!u.ok) {
        out.notes.push(...copy.pluginsFailed(`update ${id}`, u.message));
      } else if (opts.length) {
        await claude(exec, ["plugin", "install", id, ...opts, "--json"]);
      }
    }
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
  pluginsNoNamespace: (
    why: "timeout" | "none" | "error",
    fallback: string,
  ) => string[];
  pluginsKeptSource: (ref: string | undefined) => string[];
  pluginsBadInstance: () => string[];
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
    // The record stays, so a later run with Claude Code on PATH finishes the job.
    notes.push(...copy.pluginsUninstallNoClaude(manual));
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
    // The name is ours only while the marketplace still comes from our repo.
    const markets = await claude(exec, [
      "plugin",
      "marketplace",
      "list",
      "--json",
    ]);
    if (!markets.ok || !Array.isArray(markets.data)) {
      failed = true;
      notes.push(...copy.pluginsUninstallFailed(MARKETPLACE, markets.message));
    } else {
      const there = (markets.data as Market[]).find(
        (m) => m.name === MARKETPLACE,
      );
      const left = there && isOurs(there) ? await listInstalled(exec) : [];
      const others = (left ?? [`?@${MARKETPLACE}`]).filter((id) =>
        id.endsWith(`@${MARKETPLACE}`),
      );
      if (there && isOurs(there) && others.length === 0) {
        const r = await claude(exec, [
          "plugin",
          "marketplace",
          "remove",
          MARKETPLACE,
          "--json",
        ]);
        if (!r.ok && r.code !== "not_configured") {
          failed = true;
          notes.push(...copy.pluginsUninstallFailed(MARKETPLACE, r.message));
        }
      }
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
    // Read-only: the options live in Claude Code's settings.json. Keys and the
    // instance URL are read, nothing else. An unreadable file is not a finding.
    const url = readInstanceUrl(deps);
    unconfigured = url !== undefined && originOf(url) === undefined;
  }
  return { missing, unconfigured };
}

/** The shortcuts' instanceUrl from settings.json; "" when set up without one, undefined when the file cannot be read. */
function readInstanceUrl(deps: Where): string | undefined {
  try {
    const text = readFileSync(claudeSettingsFile(deps), "utf8");
    const o = JSON.parse(text) as {
      pluginConfigs?: Record<string, { options?: { instanceUrl?: unknown } }>;
    };
    const u = o.pluginConfigs?.[SHORTCUTS_PLUGIN]?.options?.instanceUrl;
    return typeof u === "string" ? u : "";
  } catch {
    return undefined;
  }
}
