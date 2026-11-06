import { parseArgs } from "node:util";
import { BUS_CMD } from "@oa/bus-protocol";

export type Harness = "claude" | "opencode" | "codex" | "pi";
export type Command = (
  | {
      cmd: "install";
      hub?: string;
      yes: boolean;
      check: boolean;
      noOpen: boolean;
      noService: boolean;
    }
  | { cmd: "login"; hub?: string; noOpen: boolean }
  | { cmd: "daemon"; hub?: string; home?: string }
  | { cmd: "mcp"; harness: Harness }
  | { cmd: "status" }
  | { cmd: "logs" }
  | { cmd: "doctor" }
  | { cmd: "uninstall"; purge: boolean }
  | { cmd: "global"; sub: "add" | "rm"; dir: string }
  | { cmd: "global"; sub: "list" }
  | { cmd: "namespace"; sub: "approve"; dir: string; yes: boolean }
  | { cmd: "namespace"; sub: "revoke"; dir: string }
  | { cmd: "namespace"; sub: "list" }
  | { cmd: "version" }
) & {
  noColor: boolean;
  /** OA_BUS_HOME for the whole run. */
  home?: string;
};

const COMMANDS = new Set([
  "install",
  "login",
  "daemon",
  "mcp",
  "status",
  "logs",
  "doctor",
  "uninstall",
  "global",
  "namespace",
  "version",
]);
const HARNESSES = ["claude", "opencode", "codex", "pi"];
const GLOBAL_USAGE = `usage: ${BUS_CMD} global <add|rm> <dir>, or global list`;
const NAMESPACE_USAGE = `usage: ${BUS_CMD} namespace approve [dir], namespace revoke <dir>, or namespace list`;
/** Flags every command takes. */
const COMMON = new Set(["no-color", "version", "home"]);
/** Each command's own flags. */
const FLAGS: Record<string, string[]> = {
  install: ["instance", "no-open", "yes", "check", "no-service"],
  login: ["instance", "no-open"],
  daemon: ["instance"],
  uninstall: ["purge"],
  namespace: ["yes"],
};

export { main } from "./main.ts";

export function parse(argv: string[]): Command {
  // Flags may come before or after the subcommand: it is the first positional.
  const { values, positionals, tokens } = parseArgs({
    args: argv,
    allowPositionals: true,
    tokens: true,
    options: {
      instance: { type: "string" },
      home: { type: "string" },
      "no-open": { type: "boolean", default: false },
      yes: { type: "boolean", short: "y", default: false },
      check: { type: "boolean", default: false },
      "no-service": { type: "boolean", default: false },
      purge: { type: "boolean", default: false },
      version: { type: "boolean", short: "v", default: false },
      "no-color": { type: "boolean", default: false },
    },
  });
  const [head, ...rest] = positionals;
  const cmd = head ?? "install";
  if (!COMMANDS.has(cmd)) throw new Error(`unknown command: ${cmd}`);
  const takes =
    cmd === "mcp" ? 1 : cmd === "global" ? (rest[0] === "list" ? 1 : 2) : 0;
  if (cmd === "mcp" && rest.length === 0)
    throw new Error(`usage: ${BUS_CMD} mcp <claude|opencode|codex|pi>`);
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
  const extra = cmd === "namespace" ? undefined : rest[takes];
  if (extra !== undefined) throw new Error(`unexpected argument: ${extra}`);
  // An empty path or URL must not fall back to the default home or instance.
  for (const name of ["home", "instance"] as const)
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
  const parsed = route(cmd, values, rest);
  return { ...parsed, noColor, ...(home ? { home } : {}) } as Command;
}

type Values = {
  instance?: string;
  home?: string;
  "no-open": boolean;
  yes: boolean;
  check: boolean;
  "no-service": boolean;
  purge: boolean;
};

function route(cmd: string, values: Values, positionals: string[]) {
  switch (cmd) {
    case "login":
      return { cmd, hub: values.instance, noOpen: values["no-open"] };
    case "daemon":
      return { cmd, hub: values.instance };
    case "mcp": {
      const harness = positionals[0] ?? "";
      if (!HARNESSES.includes(harness))
        throw new Error(`usage: ${BUS_CMD} mcp <claude|opencode|codex|pi>`);
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
    case "install":
      return {
        cmd,
        hub: values.instance,
        yes: values.yes,
        check: values.check,
        noOpen: values["no-open"],
        noService: values["no-service"],
      };
    case "status":
    case "logs":
    case "doctor":
    case "version":
      return { cmd };
    default:
      throw new Error(`unknown command: ${cmd}`);
  }
}
