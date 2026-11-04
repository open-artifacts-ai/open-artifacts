import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  type Doc,
  jsoncValue,
  parseJsonc,
  removeIfEmpty,
  removeMcpServer,
  removeOpencodeMcp,
  removePlugin,
  upsertMcpServer,
  upsertOpencodeMcp,
  upsertPlugin,
} from "@oa/bus-adapter-mcp-json";
import {
  compareVersions,
  OPENCODE_TUI_PLUGIN,
  opencodeVersion,
} from "@oa/bus-adapter-opencode";
import { PI_EXTENSION } from "@oa/bus-adapter-pi";
import { codexBinFile, codexBinPin } from "@oa/bus-daemon";
import {
  codexConfig,
  codexEntry,
  codexEntryOf,
  entryIs,
  findCodexBin,
  hasCodex,
  readToml,
  removeCodexEntry,
  upsertCodexEntry,
} from "./codex.ts";

export type Exec = (
  cmd: string,
  args: string[],
) => Promise<{ code: number; stdout: string; stderr: string }>;

export type Harness = "claude" | "opencode" | "pi" | "omp" | "codex";

export type AdapterDeps = {
  /** The user's home: harness configs live under it. */
  home: string;
  /** Open Artifacts bus home; defaults to `<home>/.oa-bus`. */
  busHome?: string;
  /** CLAUDE_CONFIG_DIR, XDG_CONFIG_HOME, OPENCODE_CONFIG_DIR, PI_CODING_AGENT_DIR, PI_CONFIG_DIR, OMP_PROFILE, PI_PROFILE, CODEX_HOME, PATH. */
  env?: Record<string, string | undefined>;
  /** The argv that runs the CLI: `[node, <OA_BUS_HOME>/bin/dist/index.js]`, or one executable. */
  busBin: string[];
  /** `pi` is the one extension file Pi and oh-my-pi both load. */
  assets: { pi: string; opencodePlugin: string };
  which: (cmd: string) => boolean;
  exec: Exec;
  /** The Codex desktop app's bundle; undefined where there is none to look for. */
  codexApp?: string;
};

export type Skipped = { harness: Harness; reason: string };
export type InstallResult = {
  installed: Harness[];
  absent: Harness[];
  skipped: Skipped[];
  notes: string[];
  /** OpenCode was configured and `opencode service restart` succeeded. */
  opencodeRestarted: boolean;
  /** Pi and oh-my-pi resolve to this one extensions file (PI_CODING_AGENT_DIR): written once for both. */
  sharedPiFile?: string;
  /** Codex was configured, but no `codex` binary was found to wake its threads with. */
  codexNoWake: boolean;
};
export type UninstallResult = {
  removed: Harness[];
  skipped: Skipped[];
  notes: string[];
  /** Only a plugin folder was left to remove; the harness's config had no entry. */
  folderOnly: Harness[];
  /** OpenCode was touched and `opencode service restart` succeeded. */
  opencodeRestarted: boolean;
};

/** The harness entry (MCP server, OpenCode plugin) name. OpenBus uses `openbus`: both can be installed. */
export const HARNESS_ENTRY = "oa_bus";
const NAME = HARNESS_ENTRY;
const HARNESSES: Harness[] = ["claude", "opencode", "pi", "omp", "codex"];

/** The shipped Pi (and oh-my-pi) extension and OpenCode TUI plugin. */
export const readAssets = (): AdapterDeps["assets"] => ({
  pi: readFileSync(PI_EXTENSION, "utf8"),
  opencodePlugin: readFileSync(OPENCODE_TUI_PLUGIN, "utf8"),
});

const paths = (deps: AdapterDeps) => {
  const env = deps.env ?? {};
  const opencode =
    env.OPENCODE_CONFIG_DIR ??
    join(env.XDG_CONFIG_HOME ?? join(deps.home, ".config"), "opencode");
  const busDir = deps.busHome ?? join(deps.home, ".oa-bus");
  return {
    claude: join(env.CLAUDE_CONFIG_DIR ?? deps.home, ".claude.json"),
    // OpenCode reads both; edit the one the user has, else create .json.
    opencodeConfigs: [
      join(opencode, "opencode.json"),
      join(opencode, "opencode.jsonc"),
    ],
    opencodeCli: join(opencode, "cli.json"),
    record: join(busDir, "install.json"),
    // OpenCode registers the folder that holds tui.js.
    opencodePlugin: join(busDir, "integrations/opencode", NAME),
    pi: join(
      agentDirEnv(deps.home, env) ?? join(deps.home, ".pi/agent"),
      "extensions/oa-bus.ts",
    ),
    omp: join(ompAgentDir(deps.home, env), "extensions/oa-bus.ts"),
    codex: codexConfig(deps.home, env),
    codexBin: codexBinFile(busDir),
    busDir,
  };
};

/**
 * PI_CODING_AGENT_DIR as one absolute path for Pi and oh-my-pi alike (`~`
 * expanded as Pi does, then resolved), so a shared folder compares equal.
 */
function agentDirEnv(
  home: string,
  env: Record<string, string | undefined>,
): string | undefined {
  const dir = env.PI_CODING_AGENT_DIR;
  if (!dir) return undefined;
  if (dir === "~") return home;
  return resolve(dir.startsWith("~/") ? join(home, dir.slice(2)) : dir);
}

/** `.omp`, or PI_CONFIG_DIR: oh-my-pi's config root under the home. */
const ompRoot = (home: string, env: Record<string, string | undefined>) =>
  join(home, env.PI_CONFIG_DIR || ".omp");

/** A profile name as oh-my-pi reads it; the default profile, or one it would refuse, is none. */
function ompProfile(env: Record<string, string | undefined>) {
  const name = (
    env.OMP_PROFILE !== undefined ? env.OMP_PROFILE : env.PI_PROFILE
  )?.trim();
  if (!name || name === "default" || name.endsWith(".")) return undefined;
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(name) ? name : undefined;
}

/**
 * oh-my-pi's agent dir, as its pi-utils dirs.ts resolves it: a named profile
 * (OMP_PROFILE, else PI_PROFILE) is `<root>/profiles/<name>/agent` and ignores
 * PI_CODING_AGENT_DIR; otherwise PI_CODING_AGENT_DIR (shared with Pi), unless
 * it is PI_PROFILE's own dir, else `<root>/agent`. `omp --profile` is a flag
 * install cannot see.
 */
export function ompAgentDir(
  home: string,
  env: Record<string, string | undefined>,
): string {
  const root = ompRoot(home, env);
  const profile = ompProfile(env);
  if (profile) return join(root, "profiles", profile, "agent");
  const piProfile = ompProfile({ PI_PROFILE: env.PI_PROFILE });
  const dir = agentDirEnv(home, env);
  if (dir && !(piProfile && dir === join(root, "profiles", piProfile, "agent")))
    return dir;
  return join(root, "agent");
}

/** oh-my-pi is a bun global: on PATH, or its config root or bin is there. */
const hasOmp = (deps: Pick<AdapterDeps, "home" | "which" | "env">) =>
  deps.which("omp") ||
  present(ompRoot(deps.home, deps.env ?? {})) ||
  present(join(deps.home, ".bun/bin/omp"));

/** Pi's and oh-my-pi's extension files are one: the one file serves both. */
const sharedFile = (deps: AdapterDeps) => paths(deps).omp === paths(deps).pi;

/** A missing file is an empty document; anything but a JSON object is refused. */
function readDoc(path: string): Doc {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }
  try {
    const doc: unknown = JSON.parse(text);
    if (typeof doc === "object" && doc !== null && !Array.isArray(doc))
      return doc as Doc;
  } catch {}
  throw new Error(`${path} is not a JSON object; left it untouched`);
}

/** True for anything at `path`, a dangling symlink included. */
function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Where a write to `path` lands: through symlinks, dangling ones included. A
 * link whose target directory is missing is refused, never replaced.
 */
function target(path: string): string {
  let p = path;
  for (let hops = 0; hops < 40; hops++) {
    if (!present(p) || !lstatSync(p).isSymbolicLink()) {
      if (p !== path && !existsSync(dirname(p)))
        throw new Error(
          `${path} is a dangling symlink to ${p}; left it untouched`,
        );
      return p;
    }
    p = resolve(dirname(p), readlinkSync(p));
  }
  throw new Error(`${path}: too many symlinks; left it untouched`);
}

/** Temp + rename beside the real file (through a symlink), keeping its mode. */
function writeAtomic(path: string, data: string, mode?: number) {
  const dest = target(path);
  mkdirSync(dirname(dest), { recursive: true });
  let m = mode ?? 0o644;
  if (mode === undefined)
    try {
      m = statSync(dest).mode & 0o777;
    } catch {}
  const tmp = `${dest}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, data, { mode: m, flag: "wx" });
    chmodSync(tmp, m);
    renameSync(tmp, dest);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** OpenCode's JSONC configs as text: missing is empty, unparsable throws. */
function readJsonc(path: string): string {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw e;
  }
  parseJsonc(text, path);
  return text;
}

/**
 * Writes `next` only when it differs; true if it did. The last guard against
 * a bad edit: `next` must parse cleanly and pass `ok`, or nothing is written.
 */
function saveText(
  path: string,
  before: string,
  next: string,
  ok: (doc: Doc) => boolean,
): boolean {
  if (next === before) return false;
  if (!ok(parseJsonc(next, path)))
    throw new Error(`editing ${path} went wrong; left it untouched`);
  writeAtomic(path, next);
  return true;
}

/** Containers install created per file, so uninstall can drop them if empty. */
type Created = Record<string, (string | number)[][]>;

function readRecord(path: string): Created {
  try {
    const v: unknown = JSON.parse(readFileSync(path, "utf8"));
    const c = (v as { created?: unknown } | null)?.created;
    if (typeof c === "object" && c !== null) return c as Created;
  } catch {}
  return {};
}

function writeRecord(path: string, before: Created, created: Created) {
  if (isDeepStrictEqual(before, created)) return;
  // The install command keeps its step records in the same file.
  let rest: Doc = {};
  try {
    const v: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof v === "object" && v !== null && !Array.isArray(v))
      rest = v as Doc;
  } catch {}
  writeAtomic(path, json({ ...rest, created }), 0o600);
}

/** The containers among `paths` that `text` lacks: install will create them. */
const missing = (text: string, paths: (string | number)[][]) =>
  paths.filter((p) => jsoncValue(text, p) === undefined);

const servers = (doc: Doc) =>
  (doc.mcp as { servers?: Doc } | undefined)?.servers;
const listed = (doc: Doc, plugin: string) =>
  Array.isArray(doc.plugins) &&
  doc.plugins.some(
    (e) =>
      e === plugin ||
      (typeof e === "object" && e !== null && e.package === plugin),
  );

const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

/** Writes `next` only when it differs; true if it did. */
function save(path: string, before: Doc, next: Doc): boolean {
  if (JSON.stringify(before) === JSON.stringify(next)) return false;
  writeAtomic(path, json(next));
  return true;
}

async function run(deps: AdapterDeps, cmd: string, args: string[]) {
  try {
    return await deps.exec(cmd, args);
  } catch (e) {
    return {
      code: -1,
      stdout: "",
      stderr: e instanceof Error ? e.message : String(e),
    };
  }
}

const firstLine = (s: string) => s.trim().split("\n")[0] ?? "";

const RESTART_FAILED = "opencode service restart failed";
const CODEX_NO_BIN = "no codex binary found; Codex threads are not woken";

const codexHere = (
  deps: Pick<AdapterDeps, "home" | "env" | "which" | "codexApp">,
) =>
  hasCodex({
    home: deps.home,
    env: deps.env ?? {},
    which: deps.which,
    app: deps.codexApp,
  });

async function restartOpencode(deps: AdapterDeps, notes: string[]) {
  const r = await run(deps, "opencode", ["service", "restart"]);
  if (r.code !== 0) notes.push(`${RESTART_FAILED}: ${firstLine(r.stderr)}`);
}

/** `done` is the harnesses whose step already succeeded in this run. */
type Step = (
  deps: AdapterDeps,
  notes: string[],
  done: Harness[],
) => Promise<"done" | "absent" | "none" | "folder">;

const install: Record<Harness, Step> = {
  // Claude rewrites ~/.claude.json while it runs, so its own CLI does the edit.
  async claude(deps, notes) {
    if (!deps.which("claude")) return "absent";
    await run(deps, "claude", ["mcp", "remove", "--scope", "user", NAME]);
    const add = await run(deps, "claude", [
      "mcp",
      "add",
      "--scope",
      "user",
      NAME,
      "--",
      ...deps.busBin,
      "mcp",
      "claude",
    ]);
    if (add.code === 0) return "done";
    const path = paths(deps).claude;
    const doc = readDoc(path);
    save(
      path,
      doc,
      upsertMcpServer(doc, NAME, {
        type: "stdio",
        command: deps.busBin[0],
        args: [...deps.busBin.slice(1), "mcp", "claude"],
        env: {},
      }),
    );
    notes.push(
      `claude mcp add failed (${firstLine(add.stderr)}); wrote ${path} directly`,
    );
    return "done";
  },

  async opencode(deps, notes) {
    if (!deps.which("opencode")) return "absent";
    const version = await opencodeVersion(deps.exec);
    // Without a version the config shape is a guess; never write v2 blind.
    if (version === undefined)
      throw new Error(
        "could not read the OpenCode version from `opencode --version`; skipped OpenCode",
      );
    if ((compareVersions(version, "2.0.0") ?? -1) < 0)
      throw new Error(`The bus needs OpenCode v2; found ${version}`);
    const p = paths(deps);
    const configPath =
      p.opencodeConfigs.find(present) ?? (p.opencodeConfigs[0] as string);
    const config = readJsonc(configPath);
    const cli = readJsonc(p.opencodeCli);
    const server = {
      type: "local",
      command: [...deps.busBin, "mcp", "opencode"],
    };
    const nextConfig = upsertOpencodeMcp(config, NAME, server);
    const nextCli = upsertPlugin(cli, p.opencodePlugin);
    // Refuse a dangling link before writing anything.
    target(configPath);
    target(p.opencodeCli);
    const record = readRecord(p.record);
    const add = (file: string, made: (string | number)[][]) => {
      const all = [...(record[file] ?? []), ...made];
      return all.filter(
        (x, i) => all.findIndex((y) => isDeepStrictEqual(x, y)) === i,
      );
    };
    const created: Created = { ...record };
    const madeConfig = missing(config, [["mcp"], ["mcp", "servers"]]);
    const madeCli = missing(cli, [["plugins"]]);
    if (madeConfig.length > 0)
      created[configPath] = add(configPath, madeConfig);
    if (madeCli.length > 0)
      created[p.opencodeCli] = add(p.opencodeCli, madeCli);
    writeRecord(p.record, record, created);
    writeAtomic(
      join(p.opencodePlugin, "tui.js"),
      deps.assets.opencodePlugin,
      0o644,
    );
    saveText(configPath, config, nextConfig, (d) =>
      isDeepStrictEqual(servers(d)?.[NAME], server),
    );
    saveText(p.opencodeCli, cli, nextCli, (d) => listed(d, p.opencodePlugin));
    await restartOpencode(deps, notes);
    return "done";
  },

  async pi(deps) {
    if (!deps.which("pi")) return "absent";
    writeAtomic(paths(deps).pi, deps.assets.pi, 0o644);
    return "done";
  },

  async omp(deps, _notes, done) {
    if (!hasOmp(deps)) return "absent";
    // Pi's step just wrote the one file both load.
    if (sharedFile(deps) && done.includes("pi")) return "done";
    writeAtomic(paths(deps).omp, deps.assets.pi, 0o644);
    return "done";
  },

  // config.toml is shared with the Codex app: only our table is edited.
  async codex(deps, notes) {
    if (!codexHere(deps)) return "absent";
    const p = paths(deps);
    const entry = codexEntry(deps.busBin, deps.home, p.busDir);
    const dest = target(p.codex);
    const { text, doc } = readToml(p.codex);
    const next = upsertCodexEntry(p.codex, text, doc, entry);
    if (next !== text) {
      const bak = `${p.codex}.oa-bus.bak`;
      if (text !== "" && !present(bak))
        writeAtomic(bak, text, statSync(dest).mode & 0o777);
      writeAtomic(p.codex, next);
    }
    // The daemon wakes idle threads with the user's own codex (C26d).
    const bin = findCodexBin({ path: deps.env?.PATH, app: deps.codexApp });
    if (bin) {
      const pin = codexBinPin(bin);
      let had = "";
      try {
        had = readFileSync(p.codexBin, "utf8");
      } catch {}
      if (had !== pin) writeAtomic(p.codexBin, pin, 0o600);
    } else {
      rmSync(p.codexBin, { force: true });
      notes.push(CODEX_NO_BIN);
    }
    return "done";
  },
};

// Uninstall works from the files, so it also cleans up after a harness the
// user removed first; the binaries are used only when present.
const uninstall: Record<Harness, Step> = {
  async claude(deps, notes) {
    if (deps.which("claude")) {
      const r = await run(deps, "claude", [
        "mcp",
        "remove",
        "--scope",
        "user",
        NAME,
      ]);
      if (r.code === 0) return "done";
    }
    const path = paths(deps).claude;
    const doc = readDoc(path);
    if (!save(path, doc, removeMcpServer(doc, NAME))) return "none";
    notes.push(`removed oa_bus from ${path} directly`);
    return "done";
  },

  async opencode(deps, notes) {
    const p = paths(deps);
    const record = readRecord(p.record);
    // Drop what install created once it is empty again, deepest first.
    const prune = (file: string, text: string) =>
      [...(record[file] ?? [])]
        .sort((a, b) => b.length - a.length)
        .reduce(removeIfEmpty, text);
    const edits = [...p.opencodeConfigs.filter(present), p.opencodeCli].map(
      (file) => {
        const before = readJsonc(file);
        const next = prune(
          file,
          file === p.opencodeCli
            ? removePlugin(before, p.opencodePlugin)
            : removeOpencodeMcp(before, NAME),
        );
        return { file, before, next };
      },
    );
    // Configs first, the plugin folder last: a failed save must not leave
    // cli.json pointing at a folder that is gone.
    const saved = edits.map(({ file, before, next }) =>
      saveText(file, before, next, (d) =>
        file === p.opencodeCli
          ? !listed(d, p.opencodePlugin)
          : servers(d)?.[NAME] === undefined &&
            (d.mcp as Doc | undefined)?.[NAME] === undefined,
      ),
    );
    const left = { ...record };
    for (const { file } of edits) delete left[file];
    writeRecord(p.record, record, left);
    const hadPlugin = existsSync(p.opencodePlugin);
    rmSync(p.opencodePlugin, { recursive: true, force: true });
    if (!saved.some(Boolean) && !hadPlugin) return "none";
    if (deps.which("opencode")) await restartOpencode(deps, notes);
    // No config named Open Artifacts bus any more: only our plugin folder was left.
    return saved.some(Boolean) ? "done" : "folder";
  },

  async pi(deps) {
    const path = paths(deps).pi;
    if (!existsSync(path)) return "none";
    rmSync(path, { force: true });
    return "done";
  },

  async omp(deps, _notes, done) {
    // Pi's step removed the one file both loaded.
    if (sharedFile(deps) && done.includes("pi")) return "done";
    const path = paths(deps).omp;
    if (!existsSync(path)) return "none";
    rmSync(path, { force: true });
    return "done";
  },

  async codex(deps) {
    const p = paths(deps);
    let saved = false;
    if (present(p.codex)) {
      const { text, doc } = readToml(p.codex);
      const next = removeCodexEntry(p.codex, text, doc);
      if (next !== text) {
        writeAtomic(p.codex, next);
        saved = true;
      }
    }
    // The config first: the pin goes only once the entry is gone.
    const pinned = present(p.codexBin);
    rmSync(p.codexBin, { force: true });
    return saved || pinned ? "done" : "none";
  },
};

async function each(
  steps: Record<Harness, Step>,
  deps: AdapterDeps,
  notes: string[],
) {
  const done: Harness[] = [];
  const folder: Harness[] = [];
  const absent: Harness[] = [];
  const skipped: Skipped[] = [];
  for (const h of HARNESSES) {
    try {
      const r = await steps[h](deps, notes, done);
      if (r === "done") done.push(h);
      if (r === "folder") folder.push(h);
      if (r === "absent") absent.push(h);
    } catch (e) {
      skipped.push({
        harness: h,
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return { done, folder, absent, skipped };
}

/** Registers Open Artifacts bus with every harness on PATH; a broken one is skipped, never clobbered. */
export async function installAdapters(
  deps: AdapterDeps,
): Promise<InstallResult> {
  const notes: string[] = [];
  const { done, absent, skipped } = await each(install, deps, notes);
  return {
    installed: done,
    absent,
    skipped,
    notes,
    opencodeRestarted:
      done.includes("opencode") &&
      !notes.some((n) => n.startsWith(RESTART_FAILED)),
    ...(done.includes("pi") && done.includes("omp") && sharedFile(deps)
      ? { sharedPiFile: paths(deps).pi }
      : {}),
    codexNoWake: done.includes("codex") && notes.includes(CODEX_NO_BIN),
  };
}

/** Removes exactly what install added: our entry names and our files. */
export async function uninstallAdapters(
  deps: AdapterDeps,
): Promise<UninstallResult> {
  const notes: string[] = [];
  const { done, folder, skipped } = await each(uninstall, deps, notes);
  return {
    removed: done,
    folderOnly: folder,
    skipped,
    notes,
    opencodeRestarted:
      [...done, ...folder].includes("opencode") &&
      deps.which("opencode") &&
      !notes.some((n) => n.startsWith(RESTART_FAILED)),
  };
}

export type AdapterState = "configured" | "missing" | "absent";

/** Read-only: whether each harness on PATH has Open Artifacts bus registered. Never execs. */
export function checkAdapters(
  deps: Pick<AdapterDeps, "home" | "busHome" | "env" | "which" | "codexApp"> & {
    /** The argv entries run, when known without writing: Codex's command is compared too. */
    busBin?: string[];
  },
): Record<Harness, AdapterState> {
  const p = paths(deps as AdapterDeps);
  const safely = (f: () => boolean) => {
    try {
      return f();
    } catch {
      return false;
    }
  };
  const state = (h: Harness, ok: () => boolean): AdapterState =>
    !(h === "omp"
      ? hasOmp(deps)
      : h === "codex"
        ? codexHere(deps)
        : deps.which(h))
      ? "absent"
      : safely(ok)
        ? "configured"
        : "missing";
  return {
    claude: state(
      "claude",
      () =>
        (readDoc(p.claude).mcpServers as Doc | undefined)?.[NAME] !== undefined,
    ),
    opencode: state(
      "opencode",
      () =>
        p.opencodeConfigs.filter(present).some((f) => {
          const d = parseJsonc(readFileSync(f, "utf8"), f);
          return (
            servers(d)?.[NAME] !== undefined ||
            (d.mcp as Doc | undefined)?.[NAME] !== undefined
          );
        }) &&
        listed(
          parseJsonc(readFileSync(p.opencodeCli, "utf8"), p.opencodeCli),
          p.opencodePlugin,
        ) &&
        existsSync(join(p.opencodePlugin, "tui.js")),
    ),
    pi: state("pi", () => existsSync(p.pi)),
    omp: state("omp", () => existsSync(p.omp)),
    codex: state("codex", () =>
      entryIs(
        codexEntryOf(readToml(p.codex).doc),
        codexEntry(
          // Unknown: only its place is compared.
          deps.busBin ?? ["oa-bus"],
          deps.home,
          p.busDir,
        ),
        deps.busBin !== undefined,
      ),
    ),
  };
}
