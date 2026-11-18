import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { BUS_CMD, isMachineToken } from "@oa/bus-protocol";
import {
  type Config,
  checkHub,
  cleanLabel,
  home,
  readConfig,
  StartError,
} from "./config.ts";

/** The local name of the instance in machine.json. */
export const MAIN_INSTANCE = "main";

/** One instance on this machine, named locally. The address is for display; never use it to pick a key. */
export type Instance = { name: string; hub: string; main: boolean };

/** Where a folder's agents connect: an instance by local name, or nowhere yet. */
export type HomeLookup = (
  cwd: string,
) => { instance: string } | { unmapped: true };

const NAME_RE = /^[a-z0-9-]{1,32}$/;

/** A reason the name is not usable, or undefined when it is. */
export function nameProblem(name: string): string | undefined {
  if (name === MAIN_INSTANCE) return `"${MAIN_INSTANCE}" is reserved`;
  if (!NAME_RE.test(name))
    return "a name uses lowercase letters, digits and dashes, 1 to 32 characters";
  return undefined;
}

export const instancesDir = (h: string = home()): string =>
  join(h, "instances");
export const instanceFile = (name: string, h: string = home()): string =>
  join(instancesDir(h), `${name}.json`);

/** One address in one form, so the same server never counts twice. ws and http name the same server. */
export function canonicalAddress(address: string): string | undefined {
  try {
    const u = new URL(address.replace(/^ws(s?):/, "http$1:"));
    return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return undefined;
  }
}

/** The address in machine.json, read raw: only to compare, never to connect. */
function mainAddress(h: string): string | undefined {
  try {
    const r = JSON.parse(readFileSync(join(h, "machine.json"), "utf8")) as {
      hub?: unknown;
    };
    return typeof r.hub === "string" ? r.hub : undefined;
  } catch {
    return undefined;
  }
}

function addedNames(h: string): string[] {
  let files: string[];
  try {
    files = readdirSync(instancesDir(h));
  } catch {
    return [];
  }
  return files
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -".json".length))
    .filter((n) => NAME_RE.test(n) && n !== MAIN_INSTANCE)
    .sort();
}

/**
 * Main first, then the added instances by name. A home with no instances
 * folder lists only main, as it always has. A file that cannot be read still
 * lists (with an empty address); credentialsFor says why it cannot be used.
 */
export function listInstances(h: string = home()): Instance[] {
  const list: Instance[] = [];
  const main = mainAddress(h);
  // Main is listed when it is logged in, or when there is nothing else.
  const added = addedNames(h);
  if (main !== undefined || added.length === 0)
    list.push({ name: MAIN_INSTANCE, hub: main ?? "", main: true });
  for (const name of added) {
    let hub = "";
    try {
      const r = JSON.parse(readFileSync(instanceFile(name, h), "utf8")) as {
        hub?: unknown;
      };
      if (typeof r.hub === "string") hub = r.hub;
    } catch {}
    list.push({ name, hub, main: false });
  }
  return list;
}

/**
 * The credentials of one instance, from that instance's own file only. The
 * key and the address never come from another file, and never from the
 * environment: OA_BUS_INSTANCE applies to main alone.
 */
export function credentialsFor(name: string, h: string = home()): Config {
  if (name === MAIN_INSTANCE) return readConfig(h);
  if (nameProblem(name))
    throw new StartError("NOT_LOGGED_IN", `no instance named ${name}`);
  const file = instanceFile(name, h);
  const notThere = () =>
    new StartError(
      "NOT_LOGGED_IN",
      `no instance named ${name}: run \`${BUS_CMD} add <address>\``,
    );
  let text: string;
  try {
    if (process.platform !== "win32" && statSync(file).mode & 0o077)
      throw new StartError(
        "CREDENTIALS_OPEN",
        `${file} is readable by other users: run \`chmod 600 ${file}\``,
      );
    text = readFileSync(file, "utf8");
  } catch (e) {
    if (e instanceof StartError) throw e;
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw notThere();
    if (code === "EACCES" || code === "EPERM")
      throw new StartError(
        "CREDENTIALS_UNREADABLE",
        `cannot read ${file} (${code}): it must belong to you`,
      );
    throw e;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // The parser's message quotes the source, which holds the token.
    throw notThere();
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw notThere();
  const r = raw as Record<string, unknown>;
  if (typeof r.hub !== "string" || !r.hub || r.name !== name) throw notThere();
  if (!isMachineToken(r.machine_token))
    throw new StartError(
      "NOT_LOGGED_IN",
      `instance ${name} has a malformed machine token: run \`${BUS_CMD} add\` again`,
    );
  checkHub(r.hub);
  return {
    hub: r.hub,
    machine_id: typeof r.machine_id === "string" ? r.machine_id : "",
    label: cleanLabel(r.label),
    machine_token: r.machine_token,
  };
}

/**
 * Until the folder map (slice S2): a lone main instance serves every folder;
 * with more than one, a folder is unmapped and gets no connection by guess.
 */
export const defaultHomeLookup: HomeLookup = (_cwd) =>
  listInstances().length === 1
    ? { instance: MAIN_INSTANCE }
    : { unmapped: true };

/** Why `name` at `address` cannot be added, or undefined when it can. */
export function addProblem(
  name: string,
  address: string,
  h: string = home(),
): string | undefined {
  const bad = nameProblem(name);
  if (bad) return bad;
  if (existsSync(instanceFile(name, h)))
    return `an instance named ${name} already exists`;
  const want = canonicalAddress(address);
  const main = mainAddress(h);
  if (
    want !== undefined &&
    main !== undefined &&
    canonicalAddress(main) === want
  )
    return `that address is already this machine's main instance`;
  for (const i of listInstances(h))
    if (!i.main && want !== undefined && canonicalAddress(i.hub) === want)
      return `that address is already the instance ${i.name}`;
  return undefined;
}

/** A name for an address that has none: the first label of its host, made fit. */
export function suggestName(address: string, h: string = home()): string {
  let base = "instance";
  try {
    const host = new URL(address).hostname.split(".")[0] ?? "";
    const fit = host
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 28);
    if (fit && fit !== MAIN_INSTANCE) base = fit;
  } catch {}
  let name = base;
  for (let n = 2; existsSync(instanceFile(name, h)); n++) name = `${base}-${n}`;
  return name;
}

/** Writes instances/<name>.json, mode 0600, atomically. Refuses a duplicate name or address. */
export function saveInstance(
  c: Config & { name: string },
  h: string = home(),
): void {
  const problem = addProblem(c.name, c.hub, h);
  if (problem) throw new Error(problem);
  checkHub(c.hub);
  const dir = instancesDir(h);
  mkdirSync(h, { recursive: true, mode: 0o700 });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const tmp = join(dir, `.${c.name}.${randomBytes(8).toString("hex")}.tmp`);
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(
      fd,
      `${JSON.stringify(
        {
          name: c.name,
          hub: c.hub,
          machine_id: c.machine_id,
          label: c.label,
          machine_token: c.machine_token,
        },
        null,
        2,
      )}\n`,
    );
  } catch (e) {
    closeSync(fd);
    unlinkSync(tmp);
    throw e;
  }
  closeSync(fd);
  try {
    chmodSync(tmp, 0o600);
    renameSync(tmp, instanceFile(c.name, h));
  } catch (e) {
    unlinkSync(tmp);
    throw e;
  }
}
