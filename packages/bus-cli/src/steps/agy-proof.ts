import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { mcpUrl } from "@oa/bus-adapter-claude-code";
import {
  agyEntryAt,
  agyEntryText,
  type Doc,
  insertAgyEntry,
  parseAgyMcp,
  removeAgyMcp,
  setAgyEntryText,
} from "@oa/bus-adapter-mcp-json";
import { BUS_CMD } from "@oa/bus-protocol";

/**
 * agy S5: Antigravity's http MCP entries take static headers only, so the
 * instance's entry (`serverUrl` = `<instance>/mcp`) cannot carry a session's
 * link proof. Install swaps it, in its place and under its name, for the
 * local proxy (`oa-bus mcp-proxy --for antigravity`), which adds the proof of
 * the calling conversation to each call. The token stays in the same file:
 * the entry's `Authorization` header becomes the proxy's env variable
 * AGY_TOKEN_ENV, never an argument. An entry with no header gets the PAT
 * file (#2954) when there is one. An added instance's entry names the
 * instance (`--name <instance>`, the #2793 S4 form). The user's entry text is
 * kept in the bus home (0600) with the token taken out; uninstall puts it
 * back exactly.
 */

/** The env variable the proxy reads the entry's token from. */
export const AGY_TOKEN_ENV = "OA_PAGES_TOKEN";
const PROXY_CMD = "mcp-proxy";
/** Stands for the token in the kept text: the token is never written twice. */
const TOKEN_MARK = "{{oa-bus:pages-token}}";
/** A bearer token as one JSON string holds it without escapes. */
const PLAIN_TOKEN = /^[A-Za-z0-9._~+/=-]{8,4096}$/;

export type AgyTarget = { origin: string; name?: string };

export type AgyEntryIo = {
  /** agy's mcp_config.json. */
  file: string;
  /** Where the user's entries are kept (0600, in the bus home). */
  moved: string;
  write: (text: string) => void;
  writeMoved: (data: string) => void;
  /** The proxy's command line start: [oa-bus] or [node, entry]. */
  busBin: string[];
  /** OA_BUS_HOME when the bus lives elsewhere. */
  busHome?: string;
  /** #2954: the PAT file for an origin, when the entry has no header. */
  patFile?: (origin: string) => string;
  /**
   * #3075: another bus's proxy entry for an added instance is taken over when
   * this says that bus has stopped. Main's entries never are: two buses may
   * share one hub.
   */
  stopped?: (owner: string | undefined) => boolean;
  /** The kept-entries file of the bus at `owner`, so a takeover carries the user's original. */
  keptOf?: (owner: string | undefined) => string;
};

type Moved = {
  name: string;
  origin: string;
  instance?: string;
  /** The user's entry text, with TOKEN_MARK for the token when it had one. */
  original: string | null;
  /** Digest of an installer-created entry, to preserve later user edits. */
  createdDigest?: string;
};

const isRecord = (v: unknown): v is Doc =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function readMoved(path: string): Moved[] {
  try {
    const v: unknown = JSON.parse(readFileSync(path, "utf8"));
    const list = isRecord(v) && Array.isArray(v.entries) ? v.entries : [];
    return list.filter(
      (e): e is Moved =>
        isRecord(e) &&
        typeof e.name === "string" &&
        typeof e.origin === "string" &&
        (e.instance === undefined || typeof e.instance === "string") &&
        (typeof e.original === "string" ||
          (e.original === null && typeof e.createdDigest === "string")),
    );
  } catch {
    return [];
  }
}

const digest = (entry: Doc) =>
  createHash("sha256").update(JSON.stringify(entry)).digest("hex");

const movedText = (list: Moved[]) =>
  `${JSON.stringify({ entries: list }, null, 2)}\n`;

function readFile(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw e;
  }
}

const servers = (doc: Doc): Doc =>
  isRecord(doc.mcpServers) ? doc.mcpServers : {};

/** The entry's address: agy writes `serverUrl`; `url` is read too. */
const urlOf = (e: Doc) =>
  typeof e.serverUrl === "string"
    ? e.serverUrl
    : typeof e.url === "string"
      ? e.url
      : undefined;

/** An http entry at this instance's /mcp (a trailing slash is fine). */
export function isAgyInstanceEntry(e: Doc, origin: string): boolean {
  const url = urlOf(e);
  if (url === undefined) return false;
  try {
    const u = new URL(url);
    return (
      u.origin === origin &&
      u.pathname.replace(/\/+$/, "") === "/mcp" &&
      !u.search &&
      !u.hash &&
      !u.username &&
      !u.password
    );
  } catch {
    return false;
  }
}

type Cred = { tokenEnv: true } | { tokenFile: string };

/** Our proxy entry for this origin: its credential, instance name and owning bus home. */
export function ourAgyEntry(
  e: Doc,
  origin: string,
):
  | { cred: Cred; instance?: string; owner?: string; token?: string }
  | undefined {
  if (typeof e.command !== "string" || !Array.isArray(e.args)) return undefined;
  const a = e.args as unknown[];
  const i = a.lastIndexOf(PROXY_CMD);
  if (i < 0 || a[i + 1] !== "--instance" || a[i + 2] !== origin)
    return undefined;
  if (a[i + 3] !== "--for" || a[i + 4] !== "antigravity") return undefined;
  let j = i + 5;
  let instance: string | undefined;
  if (a[j] === "--name" && typeof a[j + 1] === "string") {
    instance = a[j + 1] as string;
    j += 2;
  }
  const env = isRecord(e.env) ? e.env : {};
  const owner =
    typeof env.OA_BUS_HOME === "string" ? env.OA_BUS_HOME : undefined;
  const token =
    typeof env[AGY_TOKEN_ENV] === "string"
      ? (env[AGY_TOKEN_ENV] as string)
      : undefined;
  const base = {
    ...(instance === undefined ? {} : { instance }),
    ...(owner === undefined ? {} : { owner }),
    ...(token === undefined ? {} : { token }),
  };
  if (a[j] === "--token-env" && a[j + 1] === AGY_TOKEN_ENV)
    return { cred: { tokenEnv: true }, ...base };
  if (a[j] === "--token-file" && typeof a[j + 1] === "string")
    return { cred: { tokenFile: a[j + 1] as string }, ...base };
  return undefined;
}

/** The entry's bearer token, when its headers are exactly one Authorization. */
function bearerOf(e: Doc): string | null | undefined {
  if (e.headers === undefined) return null;
  if (!isRecord(e.headers)) return undefined;
  const keys = Object.keys(e.headers);
  if (keys.length === 0) return null;
  if (
    keys.length !== 1 ||
    (keys[0] as string).toLowerCase() !== "authorization"
  )
    return undefined;
  const v = e.headers[keys[0] as string];
  const m = typeof v === "string" ? /^Bearer (\S+)$/.exec(v) : null;
  return m && PLAIN_TOKEN.test(m[1] as string) ? (m[1] as string) : undefined;
}

/** The keys install takes off the user's entry; everything else of theirs stays on it. */
const HTTP_KEYS = ["serverUrl", "url", "headers"];
/** Keys a stdio proxy cannot sit beside. */
const BLOCKING = ["command", "args", "env", "cwd", "oauth", "auth"];

function proxyEntry(
  io: AgyEntryIo,
  base: Doc,
  t: AgyTarget,
  cred: Cred,
  token: string | undefined,
): Doc & { command: string; args: string[] } {
  const kept = Object.fromEntries(
    Object.entries(base).filter(
      ([k]) => !HTTP_KEYS.includes(k) && !BLOCKING.includes(k),
    ),
  );
  const env: Doc = {
    ...("tokenEnv" in cred && token !== undefined
      ? { [AGY_TOKEN_ENV]: token }
      : {}),
    ...(io.busHome ? { OA_BUS_HOME: io.busHome } : {}),
  };
  return {
    ...kept,
    command: io.busBin[0] as string,
    args: [
      ...io.busBin.slice(1),
      PROXY_CMD,
      "--instance",
      t.origin,
      "--for",
      "antigravity",
      ...(t.name === undefined ? [] : ["--name", t.name]),
      ...("tokenEnv" in cred
        ? ["--token-env", AGY_TOKEN_ENV]
        : ["--token-file", cred.tokenFile]),
    ],
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
}

/** `v` as JSON text laid out like the entry it replaces (indented from its line). */
function render(text: string, name: string, v: unknown): string {
  const at = agyEntryAt(text, name);
  return JSON.stringify(v, null, 2)
    .split("\n")
    .join((at?.eol ?? "\n") + (at?.indent ?? ""));
}

/** One instance entry and what install does with it. */
type Plan =
  | { kind: "ours"; name: string; entry: Doc; cred: Cred; token?: string }
  | { kind: "swap"; name: string; entry: Doc; cred: Cred; token?: string }
  | {
      kind: "adopt";
      name: string;
      entry: Doc;
      cred: Cred;
      token?: string;
      owner?: string;
    }
  | { kind: "left"; name: string; note: string };

const leftNote = (name: string, file: string, why: string) =>
  `left the ${name} entry in ${file} as it is: ${why} Its tools still work, but Antigravity won't show as its own session on pages.`;
const left = (name: string, file: string, why: string): Plan => ({
  kind: "left",
  name,
  note: leftNote(name, file, why),
});

function plans(io: AgyEntryIo, doc: Doc, t: AgyTarget): Plan[] {
  const out: Plan[] = [];
  for (const [name, e] of Object.entries(servers(doc))) {
    if (!isRecord(e)) continue;
    const ours = ourAgyEntry(e, t.origin);
    if (ours) {
      if (ours.owner !== io.busHome) {
        // #3075: only an added instance's entry is taken over; main's stays
        // with its bus, which keeps the user's original for its uninstall.
        if (t.name !== undefined && io.stopped?.(ours.owner))
          out.push({
            kind: "adopt",
            name,
            entry: e,
            cred: ours.cred,
            ...(ours.token === undefined ? {} : { token: ours.token }),
            ...(ours.owner === undefined ? {} : { owner: ours.owner }),
          });
        else
          out.push(
            left(
              name,
              io.file,
              `it belongs to the bus at ${ours.owner ?? "the default home"}.`,
            ),
          );
        continue;
      }
      if ("tokenFile" in ours.cred && !existsSync(ours.cred.tokenFile)) {
        out.push({
          kind: "left",
          name,
          note: `the ${name} entry in ${io.file} reaches Open Artifacts through oa-bus, but its PAT file ${ours.cred.tokenFile} is gone, so Antigravity has no token and its tools fail. Save a PAT for this instance there.`,
        });
        continue;
      }
      if ("tokenEnv" in ours.cred && !ours.token) {
        out.push({
          kind: "left",
          name,
          note: `the ${name} entry in ${io.file} reaches Open Artifacts through oa-bus, but its ${AGY_TOKEN_ENV} is empty, so Antigravity has no token and its tools fail. Run ${BUS_CMD} uninstall to put your own entry back, then add your token to it and run ${BUS_CMD} install again.`,
        });
        continue;
      }
      out.push({
        kind: "ours",
        name,
        entry: e,
        cred: ours.cred,
        ...(ours.token === undefined ? {} : { token: ours.token }),
      });
      continue;
    }
    if (!isAgyInstanceEntry(e, t.origin) || e.disabled === true) continue;
    try {
      mcpUrl(t.origin);
    } catch {
      out.push(
        left(
          name,
          io.file,
          "oa-bus only passes on https addresses, or http to localhost.",
        ),
      );
      continue;
    }
    if (BLOCKING.some((k) => e[k] !== undefined)) {
      out.push(
        left(name, io.file, "it is written in a form oa-bus can't edit."),
      );
      continue;
    }
    const token = bearerOf(e);
    if (typeof token === "string") {
      out.push({
        kind: "swap",
        name,
        entry: e,
        cred: { tokenEnv: true },
        token,
      });
      continue;
    }
    if (token === null) {
      out.push({
        kind: "left",
        name,
        note: `Antigravity uses its own sign-in for ${name} at ${t.origin}.`,
      });
      continue;
    }
    out.push(left(name, io.file, "it sends headers oa-bus cannot pass on."));
  }
  return out;
}

/** The http entry `agy mcp add` writes, for a proxy entry this bus takes over (#3075). */
const adoptedOriginal = (origin: string, cred: Cred) =>
  JSON.stringify(
    {
      disabled: false,
      ...("tokenEnv" in cred
        ? { headers: { Authorization: `Bearer ${TOKEN_MARK}` } }
        : {}),
      serverUrl: `${origin}/mcp`,
    },
    null,
    2,
  );

export type AgyOutcome = { notes: string[]; changed: string[] };

/**
 * Swaps each instance entry in agy's config for the proxy, brings this
 * bus's proxy entries up to date, and takes over one a stopped bus left
 * (#3075). The kept text is written before the config is. Throws for a
 * config that cannot be read.
 */
export function installAgyEntries(
  io: AgyEntryIo,
  targets: AgyTarget[],
): AgyOutcome {
  const out: AgyOutcome = { notes: [], changed: [] };
  const before = readFile(io.file);
  let text = before;
  const moved = readMoved(io.moved);
  let keep = [...moved];
  for (const t of targets) {
    const doc = parseAgyMcp(text, io.file);
    const entries = servers(doc);
    const existing = plans(io, doc, t);
    if (
      !existing.length &&
      !Object.values(entries).some(
        (e) => isRecord(e) && isAgyInstanceEntry(e, t.origin),
      )
    ) {
      const pat = io.patFile?.(t.origin);
      try {
        mcpUrl(t.origin);
      } catch {
        out.notes.push(
          `Skipped Antigravity page tools for ${t.origin}: the proxy requires HTTPS or localhost.`,
        );
        continue;
      }
      const base = t.name ? `open-artifacts-${t.name}` : "open-artifacts";
      let name = base;
      for (let suffix = 2; Object.hasOwn(entries, name); suffix++)
        name = `${base}-${suffix}`;
      const want =
        pat && existsSync(pat)
          ? proxyEntry(io, {}, t, { tokenFile: pat }, undefined)
          : { serverUrl: mcpUrl(t.origin).href };
      text = insertAgyEntry(text, name, want);
      keep = keep.filter((m) => m.name !== name);
      keep.push({
        name,
        origin: t.origin,
        ...(t.name ? { instance: t.name } : {}),
        original: null,
        createdDigest: digest(want),
      });
      out.changed.push(name);
    }
    for (const p of existing) {
      if (p.kind === "left") {
        out.notes.push(p.note);
        continue;
      }
      const prior = keep.find(
        (m) => m.name === p.name && m.origin === t.origin,
      );
      if (
        p.kind === "ours" &&
        prior?.original === null &&
        prior.createdDigest !== digest(p.entry)
      )
        continue;
      const want = proxyEntry(io, p.entry, t, p.cred, p.token);
      if (p.kind === "ours" && isDeepStrictEqual(p.entry, want)) continue;
      const raw = render(text, p.name, want);
      let original: string | null | undefined;
      if (p.kind === "swap") {
        const cur = agyEntryText(text, p.name) as string;
        if (p.token !== undefined) {
          // The token must appear once, as itself, and the mark not at all.
          if (cur.split(p.token).length !== 2 || cur.includes(TOKEN_MARK)) {
            out.notes.push(
              leftNote(
                p.name,
                io.file,
                "it is written in a form oa-bus can't edit.",
              ),
            );
            continue;
          }
          original = cur.replace(p.token, TOKEN_MARK);
        } else original = cur;
      } else if (p.kind === "adopt") {
        // The stopped bus kept the user's own entry: carry it, else rebuild
        // the http entry `agy mcp add` writes.
        const theirs =
          io.keptOf === undefined
            ? undefined
            : readMoved(io.keptOf(p.owner)).find(
                (m) => m.name === p.name && m.origin === t.origin,
              );
        if (
          theirs?.original === null &&
          theirs.createdDigest !== digest(p.entry)
        )
          continue;
        original = theirs ? theirs.original : adoptedOriginal(t.origin, p.cred);
        out.notes.push(
          `took over the ${p.name} entry in ${io.file}: the bus at ${p.owner ?? "the default home"} no longer runs`,
        );
      }
      text = setAgyEntryText(text, p.name, raw, want);
      keep = keep.filter((m) => m.name !== p.name);
      const source =
        original !== undefined
          ? original
          : prior
            ? prior.original
            : adoptedOriginal(t.origin, p.cred);
      keep.push({
        name: p.name,
        origin: t.origin,
        ...(t.name === undefined ? {} : { instance: t.name }),
        original: source,
        ...(source === null ? { createdDigest: digest(want) } : {}),
      });
      out.changed.push(p.name);
      if (p.kind === "swap")
        out.notes.push(
          `Antigravity now reaches Open Artifacts through oa-bus (the ${p.name} entry in ${io.file}), so its pages show as the session that made them. ${
            "tokenEnv" in p.cred
              ? `Its token stays in that file, as ${AGY_TOKEN_ENV}.`
              : `Its calls go out with the PAT in ${p.cred.tokenFile}.`
          } To undo, run ${BUS_CMD} uninstall: it puts your entry back.`,
        );
    }
  }
  if (text === before) return out;
  if (!isDeepStrictEqual(keep, moved)) io.writeMoved(movedText(keep));
  io.write(text);
  return out;
}

/**
 * Puts each kept entry back, byte for byte, unless the user has since made it
 * something that is not this proxy (then it stays theirs). A token the kept
 * text needs comes from the proxy entry's env. Returns notes for what could
 * not be put back; the kept file goes only once every entry is settled.
 */
export function restoreAgyEntries(io: AgyEntryIo): {
  restored: string[];
  notes: string[];
} {
  const moved = readMoved(io.moved);
  const res = { restored: [] as string[], notes: [] as string[] };
  if (moved.length === 0) {
    rmSync(io.moved, { force: true });
    return res;
  }
  const before = readFile(io.file);
  let text = before;
  const stay: Moved[] = [];
  for (const m of moved) {
    const doc = text.trim() === "" ? {} : parseAgyMcp(text, io.file);
    const cur = servers(doc)[m.name];
    const ours = isRecord(cur) ? ourAgyEntry(cur, m.origin) : undefined;
    if (!ours) {
      if (
        m.original === null &&
        isRecord(cur) &&
        isAgyInstanceEntry(cur, m.origin) &&
        digest(cur) === m.createdDigest
      ) {
        text = removeAgyMcp(text, m.name);
        res.restored.push(m.name);
      }
      continue;
    }
    if (ours.owner !== io.busHome) {
      // Another bus took the entry over (#3075): keep the original, so it is
      // not lost while that bus holds the entry.
      stay.push(m);
      continue;
    }
    if (m.original === null) {
      if (isRecord(cur) && digest(cur) === m.createdDigest) {
        text = removeAgyMcp(text, m.name);
        res.restored.push(m.name);
      }
      continue;
    }
    let raw = m.original;
    if (raw.includes(TOKEN_MARK)) {
      if (!ours.token || !PLAIN_TOKEN.test(ours.token)) {
        res.notes.push(
          `could not put the ${m.name} entry in ${io.file} back: its ${AGY_TOKEN_ENV} is gone. Add it again with: agy mcp add --header "Authorization: Bearer <your token>" ${m.name} ${m.origin}/mcp`,
        );
        stay.push(m);
        continue;
      }
      raw = raw.replace(TOKEN_MARK, ours.token);
    }
    let want: unknown;
    try {
      want = parseAgyMcp(`{"x":${raw}}`, "kept entry").x;
    } catch {
      stay.push(m);
      continue;
    }
    text = setAgyEntryText(text, m.name, raw, want);
    res.restored.push(m.name);
  }
  if (text !== before) io.write(text);
  if (stay.length > 0) io.writeMoved(movedText(stay));
  else rmSync(io.moved, { force: true });
  return res;
}

export type AgyPagesLine =
  | { state: "linked"; name: string; origin: string; instance?: string }
  | { state: "left"; name: string; note: string }
  | { state: "pending"; name: string; origin: string }
  | { state: "missing"; name: string; program: string };

/**
 * Read-only, for doctor: each instance entry in agy's config and its state.
 * `linked`: our proxy, for this bus, with its token. `pending`: install would
 * swap it. `left`: install leaves it (the note says why and the fix).
 * `missing`: the proxy's program is gone (oa-bus moved or removed).
 */
export function agyPagesState(
  io: AgyEntryIo,
  targets: AgyTarget[],
  which: (cmd: string) => boolean,
): AgyPagesLine[] {
  const text = readFile(io.file);
  if (text.trim() === "") return [];
  const doc = parseAgyMcp(text, io.file);
  const out: AgyPagesLine[] = [];
  for (const t of targets)
    for (const p of plans(io, doc, t)) {
      if (p.kind === "left") {
        out.push({ state: "left", name: p.name, note: p.note });
        continue;
      }
      if (p.kind === "swap" || p.kind === "adopt") {
        out.push({ state: "pending", name: p.name, origin: t.origin });
        continue;
      }
      const e = p.entry;
      const a = e.args as unknown[];
      const program = [e.command, ...a.slice(0, a.lastIndexOf(PROXY_CMD))].find(
        (part) =>
          typeof part === "string" &&
          (isAbsolute(part) ? !existsSync(part) : !which(part)),
      );
      if (typeof program === "string") {
        out.push({ state: "missing", name: p.name, program });
        continue;
      }
      out.push({
        state: "linked",
        name: p.name,
        origin: t.origin,
        ...(t.name === undefined ? {} : { instance: t.name }),
      });
    }
  return out;
}
