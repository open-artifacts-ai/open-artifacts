import { parseArgs } from "node:util";
import { BUS_CMD } from "@oa/bus-protocol";

export type Harness = "claude" | "opencode" | "codex" | "pi" | "antigravity";
export type Command = (
  | {
      cmd: "install";
      hub?: string;
      yes: boolean;
      check: boolean;
      noOpen: boolean;
      noService: boolean;
      alongside: boolean;
      habits?: "yes" | "no" | "show";
      json?: boolean;
    }
  | { cmd: "login"; hub?: string; noOpen: boolean }
  | { cmd: "add"; address: string; name?: string; noOpen: boolean }
  | { cmd: "use"; name?: string; none: boolean }
  | {
      cmd: "skill";
      hub?: string;
      check: boolean;
      json?: boolean;
      refresh?: boolean;
    }
  | { cmd: "daemon"; hub?: string; home?: string }
  | { cmd: "mcp"; harness: Harness }
  | { cmd: "mcp-proof"; tokenFile?: string; instance?: string }
  | { cmd: "agy-hello" }
  | {
      cmd: "mcp-proxy";
      hub: string;
      tokenFile?: string;
      /** The environment variable that holds the token (Codex passes it by name). */
      tokenEnv?: string;
      /** Which harness runs the proxy; OpenCode when absent. */
      for?: "opencode" | "codex";
    }
  | { cmd: "status" }
  | { cmd: "logs" }
  | { cmd: "doctor" }
  | { cmd: "uninstall"; purge: boolean }
  | { cmd: "global"; sub: "add" | "rm"; dir: string }
  | { cmd: "global"; sub: "list" }
  | { cmd: "namespace"; sub: "approve"; dir: string; yes: boolean }
  | { cmd: "namespace"; sub: "revoke"; dir: string }
  | { cmd: "namespace"; sub: "list" }
  | { cmd: "link"; sub: "add" | "rm"; dirs: [string, string] }
  | { cmd: "link"; sub: "list" }
  | { cmd: "leads"; sub: "check"; name?: string }
  | { cmd: "auto-update"; sub: "off" | "on" | "status" }
  | { cmd: "update" }
  | { cmd: "upgrade"; version?: string; allowFailed: boolean }
  | { cmd: "version" }
  | { cmd: "help" }
) & {
  noColor: boolean;
  /** OA_BUS_HOME for the whole run. */
  home?: string;
};

const COMMANDS = new Set([
  "install",
  "login",
  "add",
  "use",
  "skill",
  "daemon",
  "mcp",
  "mcp-proof",
  "agy-hello",
  "mcp-proxy",
  "status",
  "logs",
  "doctor",
  "uninstall",
  "global",
  "namespace",
  "link",
  "unlink",
  "leads",
  "auto-update",
  "update",
  "upgrade",
  "version",
]);
const HARNESSES = ["claude", "opencode", "codex", "pi", "antigravity"];
const GLOBAL_USAGE = `usage: ${BUS_CMD} global <add|rm> <dir>, or global list`;
const LINK_USAGE = `usage: ${BUS_CMD} link <dir> <dir>, ${BUS_CMD} unlink <dir> <dir>, or link list`;
const LEADS_USAGE = `usage: ${BUS_CMD} leads check [name]`;
const AUTO_UPDATE_USAGE = `usage: ${BUS_CMD} auto-update <off|on|status>`;
const NAMESPACE_USAGE = `usage: ${BUS_CMD} namespace approve [dir], namespace revoke <dir>, or namespace list`;
/** Flags every command takes. */
const COMMON = new Set(["no-color", "version", "home"]);
/** Each command's own flags. */
const FLAGS: Record<string, string[]> = {
  install: [
    "instance",
    "no-open",
    "yes",
    "check",
    "no-service",
    "alongside",
    "habits",
    "no-habits",
    "show-habits",
    "json",
  ],
  login: ["instance", "no-open"],
  add: ["name", "no-open"],
  use: ["none"],
  skill: ["instance", "check", "json", "refresh"],
  daemon: ["instance"],
  uninstall: ["purge"],
  "mcp-proof": ["token-file", "instance"],
  "mcp-proxy": ["instance", "token-file", "token-env", "for"],
  namespace: ["yes"],
  upgrade: ["allow-failed"],
};

export { main } from "./main.ts";

export function parse(argv: string[]): Command {
  // Help wins over everything else on the line, even a flag parseArgs would refuse.
  const end = argv.indexOf("--");
  const own = end === -1 ? argv : argv.slice(0, end);
  if (own.includes("--help") || own.includes("-h") || argv[0] === "help")
    return { cmd: "help", noColor: own.includes("--no-color") };
  // Flags may come before or after the subcommand: it is the first positional.
  const { values, positionals, tokens } = parseArgs({
    args: argv,
    allowPositionals: true,
    tokens: true,
    options: {
      instance: { type: "string" },
      name: { type: "string" },
      home: { type: "string" },
      "token-file": { type: "string" },
      "token-env": { type: "string" },
      for: { type: "string" },
      "no-open": { type: "boolean", default: false },
      none: { type: "boolean", default: false },
      yes: { type: "boolean", short: "y", default: false },
      check: { type: "boolean", default: false },
      refresh: { type: "boolean", default: false },
      "no-service": { type: "boolean", default: false },
      alongside: { type: "boolean", default: false },
      habits: { type: "boolean", default: false },
      "no-habits": { type: "boolean", default: false },
      "show-habits": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      purge: { type: "boolean", default: false },
      "allow-failed": { type: "boolean", default: false },
      version: { type: "boolean", short: "v", default: false },
      help: { type: "boolean", short: "h", default: false },
      "no-color": { type: "boolean", default: false },
    },
  });
  const [head, ...rest] = positionals;
  // Help wins over everything else on the line, so it never fails on a flag.
  if (values.help || head === "help")
    return { cmd: "help", noColor: values["no-color"] };
  const cmd = head ?? "install";
  if (!COMMANDS.has(cmd)) throw new Error(`unknown command: ${cmd}`);
  const tokenFile = values["token-file"];
  const takes =
    cmd === "mcp" || cmd === "add" || cmd === "use"
      ? 1
      : cmd === "global"
        ? rest[0] === "list"
          ? 1
          : 2
        : 0;
  if (cmd === "mcp" && rest.length === 0)
    throw new Error(
      `usage: ${BUS_CMD} mcp <claude|opencode|codex|pi|antigravity>`,
    );
  if (cmd === "add" && rest.length === 0)
    throw new Error(`usage: ${BUS_CMD} add <address> [--name <name>]`);
  if (cmd === "use" && rest[0] !== undefined && values.none)
    throw new Error(`usage: ${BUS_CMD} use [name], or ${BUS_CMD} use --none`);
  if (cmd === "global" && rest.length < takes) throw new Error(GLOBAL_USAGE);
  if (cmd === "namespace") {
    const sub = rest[0];
    const max = sub === "list" ? 1 : sub === "approve" ? 2 : 2;
    const min = sub === "revoke" ? 2 : 1;
    if (!["approve", "revoke", "list"].includes(sub ?? "") || rest.length < min)
      throw new Error(NAMESPACE_USAGE);
    if (rest[max] !== undefined)
      throw new Error(`unexpected argument: ${rest[max]}`);
  }
  if (cmd === "leads") {
    if (rest[0] !== "check") throw new Error(LEADS_USAGE);
    if (rest[2] !== undefined)
      throw new Error(`unexpected argument: ${rest[2]}`);
  }
  if (cmd === "auto-update") {
    if (!["off", "on", "status"].includes(rest[0] ?? ""))
      throw new Error(AUTO_UPDATE_USAGE);
    if (rest[1] !== undefined)
      throw new Error(`unexpected argument: ${rest[1]}`);
  }
  if (cmd === "upgrade") {
    if (rest[1] !== undefined)
      throw new Error(`unexpected argument: ${rest[1]}`);
    if (
      rest[0] !== undefined &&
      !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(rest[0])
    )
      throw new Error(`usage: ${BUS_CMD} upgrade [x.y.z]`);
  }
  if (cmd === "link" || cmd === "unlink") {
    const n = cmd === "link" && rest[0] === "list" ? 1 : 2;
    if (rest.length < n) throw new Error(LINK_USAGE);
    if (rest[n] !== undefined)
      throw new Error(`unexpected argument: ${rest[n]}`);
  }
  const extra =
    cmd === "namespace" ||
    cmd === "link" ||
    cmd === "unlink" ||
    cmd === "leads" ||
    cmd === "upgrade" ||
    cmd === "auto-update"
      ? undefined
      : rest[takes];
  if (extra !== undefined) throw new Error(`unexpected argument: ${extra}`);
  // An empty path or URL must not fall back to the default home or instance.
  for (const name of ["home", "instance", "name"] as const)
    if (values[name] === "") throw new Error(`--${name} needs a value`);
  // A flag the command ignores would run it on something the user did not mean.
  for (const t of tokens) {
    if (t.kind !== "option" || COMMON.has(t.name)) continue;
    if (FLAGS[cmd]?.includes(t.name)) continue;
    throw new Error(`--${t.name} does not apply to oa-bus ${cmd}`);
  }
  const noColor = values["no-color"];
  const home = values.home;
  if (values.version)
    return { cmd: "version", noColor, ...(home ? { home } : {}) };
  if (cmd === "mcp-proxy" && !values.instance)
    throw new Error(
      `usage: ${BUS_CMD} mcp-proxy --instance <url> [--for codex] [--token-file <path> | --token-env <name>]`,
    );
  if (cmd === "mcp-proxy") {
    const f = values.for;
    if (f !== undefined && f !== "opencode" && f !== "codex")
      throw new Error("--for takes opencode or codex");
    if (values["token-env"] !== undefined && f !== "codex")
      throw new Error("--token-env needs --for codex");
    if (values["token-env"] !== undefined && tokenFile)
      throw new Error("give --token-file or --token-env, not both");
  }
  const parsed =
    cmd === "mcp-proof"
      ? {
          cmd,
          ...(tokenFile ? { tokenFile } : {}),
          ...(values.instance !== undefined
            ? { instance: values.instance }
            : {}),
        }
      : cmd === "mcp-proxy"
        ? {
            cmd,
            hub: values.instance as string,
            ...(tokenFile ? { tokenFile } : {}),
            ...(values["token-env"] ? { tokenEnv: values["token-env"] } : {}),
            ...(values.for ? { for: values.for as "opencode" | "codex" } : {}),
          }
        : route(cmd, values, rest);
  return { ...parsed, noColor, ...(home ? { home } : {}) } as Command;
}

type Values = {
  instance?: string;
  name?: string;
  home?: string;
  "token-file"?: string;
  "no-open": boolean;
  none: boolean;
  yes: boolean;
  check: boolean;
  refresh: boolean;
  "no-service": boolean;
  alongside: boolean;
  habits: boolean;
  "no-habits": boolean;
  "show-habits": boolean;
  json: boolean;
  purge: boolean;
  "allow-failed": boolean;
};

function route(cmd: string, values: Values, positionals: string[]) {
  switch (cmd) {
    case "login":
      return { cmd, hub: values.instance, noOpen: values["no-open"] };
    case "add":
      return {
        cmd,
        address: positionals[0] as string,
        ...(values.name ? { name: values.name } : {}),
        noOpen: values["no-open"],
      };
    case "use":
      return {
        cmd,
        ...(positionals[0] ? { name: positionals[0] } : {}),
        none: values.none,
      };
    case "skill":
      return {
        cmd,
        hub: values.instance,
        check: values.check,
        ...(values.json ? { json: true } : {}),
        ...(values.refresh ? { refresh: true } : {}),
      };
    case "daemon":
      return { cmd, hub: values.instance };
    case "agy-hello":
      return { cmd };
    case "mcp": {
      const harness = positionals[0] ?? "";
      if (!HARNESSES.includes(harness))
        throw new Error(
          `usage: ${BUS_CMD} mcp <claude|opencode|codex|pi|antigravity>`,
        );
      return { cmd, harness: harness as Harness };
    }
    case "uninstall":
      return { cmd, purge: values.purge };
    case "global": {
      const [sub, dir] = positionals;
      if (sub === "list") return { cmd, sub };
      if ((sub === "add" || sub === "rm") && dir) return { cmd, sub, dir };
      throw new Error(GLOBAL_USAGE);
    }
    case "namespace": {
      const [sub, dir] = positionals;
      if (sub === "list") return { cmd, sub };
      if (sub === "revoke" && dir) return { cmd, sub, dir };
      if (sub === "approve")
        return { cmd, sub, dir: dir ?? ".", yes: values.yes };
      throw new Error(NAMESPACE_USAGE);
    }
    case "leads": {
      const name = positionals[1];
      return { cmd, sub: "check" as const, ...(name ? { name } : {}) };
    }
    case "auto-update":
      return { cmd, sub: positionals[0] as "off" | "on" | "status" };
    case "upgrade":
      return {
        cmd,
        allowFailed: values["allow-failed"],
        ...(positionals[0] ? { version: positionals[0] } : {}),
      };
    case "link":
    case "unlink": {
      if (cmd === "link" && positionals[0] === "list")
        return { cmd: "link", sub: "list" };
      const [a, b] = positionals;
      if (!a || !b) throw new Error(LINK_USAGE);
      return {
        cmd: "link",
        sub: cmd === "link" ? "add" : "rm",
        dirs: [a, b],
      };
    }
    case "install":
      return {
        cmd,
        hub: values.instance,
        yes: values.yes,
        check: values.check,
        noOpen: values["no-open"],
        noService: values["no-service"],
        alongside: values.alongside,
        ...habitsMode(values),
        ...(values.json ? { json: true } : {}),
      };
    case "status":
    case "logs":
    case "doctor":
    case "update":
    case "version":
      return { cmd };
    default:
      throw new Error(`unknown command: ${cmd}`);
  }
}

/** At most one of --habits, --no-habits, --show-habits. */
function habitsMode(v: Values): {
  habits?: "yes" | "no" | "show";
} {
  const asked = [
    v.habits && "yes",
    v["no-habits"] && "no",
    v["show-habits"] && "show",
  ].filter(Boolean) as ("yes" | "no" | "show")[];
  if (asked.length > 1)
    throw new Error("use only one of --habits, --no-habits, --show-habits");
  return asked[0] ? { habits: asked[0] } : {};
}
