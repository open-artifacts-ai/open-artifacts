// Checks an install after an agent ran the migration skill on a claude.ai
// export: everything importable arrived once, in the mapped space, owned by
// the right user, and a rerun added no artifacts and no needless versions.
//
// ASSUMPTION (until Backend's migration skill lands): the identity contract
// (2026-10-21) is importKey = "<source>:<conversationUuid>:<artifactId>",
// source "claude" or "chatgpt", unique per (owner, importKey). The server does
// not store or return importKey yet. This checker reads it from an `importKey`
// field on each artifact summary the REST list returns; that read is isolated
// in importKeyOf, the one place to change once the real field ships.
//
// ASSUMPTION: the skill publishes an artifact's export content verbatim as
// one file of the version (wrongContent compares bytes).
//
// `expected` comes from parsing the export here, independently of the skill.
// snapshot uses only existing REST endpoints: GET /api/v1/me (owner),
// /api/v1/spaces (the personal space is its kind "personal" row),
// /api/v1/artifacts and /api/v1/artifacts/:id/versions, plus a version's
// files to compare content with the export.
//
// LIMIT: the checker sees only what the owner's PAT can list (the real list's
// visibility rules). wrongOwner and unexpected cover artifacts visible to the
// owner; a copy published into another user's private space is out of scope.
//
// Failures show status and a body hash, never a body or the PAT.

import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface Target {
  /** App origin, e.g. https://rl-a.open-artifacts-staging.app */
  app: string;
  /** A 0600 file holding the owner's PAT. */
  patFile: string;
  /** Tests only: an in-process fake in place of the network. */
  fetch?: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
}

export interface SnapVersion {
  version: number;
  files: { path: string; size: number }[];
}

export interface SnapArtifact {
  id: string;
  importKey: string | null;
  ownerId: string;
  ownerEmail: string | null;
  /** null when the install has spaces off. */
  spaceId: string | null;
  /** Ascending by version. */
  versions: SnapVersion[];
}

export interface Snapshot {
  /** The PAT's user. */
  me: { id: string; email: string | null };
  personalSpaceId: string | null;
  spaces: { id: string; name: string }[];
  artifacts: SnapArtifact[];
}

export interface Report {
  expected: number;
  imported: number;
  skipped: { ref: string; reason: string }[];
  wrongSpace: string[];
  wrongOwner: string[];
  duplicates: string[];
  extraVersions: string[];
  /** New since `before` and not the first artifact for an export item: its importKey, or its id when keyless. */
  unexpected: string[];
  /** The latest version has no file equal to the export content. */
  wrongContent: string[];
}

export interface ExportItem {
  importKey: string;
  conversationUuid: string;
  artifactId: string;
  type: string;
  supported: boolean;
  /** Final content after every create, rewrite and update. */
  content: string;
}

/** claude.ai artifact types an import is expected to carry over. */
export const SUPPORTED_TYPES: ReadonlySet<string> = new Set([
  "text/html",
  "text/markdown",
  "application/vnd.ant.code",
  "application/vnd.ant.react",
  "application/vnd.ant.mermaid",
  "image/svg+xml",
]);

const UNSUPPORTED = "unsupported type: ";
export const NOT_IMPORTED = "not imported";

const IMPORT_KEY = /^(claude|chatgpt):[^:\s]+:[^:\s]+$/;

/** The one read of the assumed importKey field (see the header). */
export function importKeyOf(summary: unknown): string | null {
  const v = (summary as { importKey?: unknown } | null)?.importKey;
  return typeof v === "string" && IMPORT_KEY.test(v) ? v : null;
}

// ---------------------------------------------------------------- export

interface ToolInput {
  id?: unknown;
  command?: unknown;
  type?: unknown;
  content?: unknown;
  old_str?: unknown;
  new_str?: unknown;
}

/**
 * Every artifact in a claude.ai export's conversations.json, once per
 * importKey. A repeated conversation or a repeated create is the same key;
 * the same artifact id in another conversation is another key.
 */
export function parseExport(exportDir: string): ExportItem[] {
  const raw: unknown = JSON.parse(
    readFileSync(join(exportDir, "conversations.json"), "utf8"),
  );
  if (!Array.isArray(raw))
    throw new Error("conversations.json: expected an array");
  const items = new Map<string, ExportItem>();
  const seenMessages = new Set<string>();
  for (const c of raw) {
    const conv = typeof c?.uuid === "string" ? c.uuid : null;
    if (!conv || !Array.isArray(c.chat_messages)) continue;
    for (const m of c.chat_messages) {
      // A conversation listed twice repeats its messages: apply each once.
      const mid = typeof m?.uuid === "string" ? `${conv}/${m.uuid}` : null;
      if (mid) {
        if (seenMessages.has(mid)) continue;
        seenMessages.add(mid);
      }
      if (!Array.isArray(m?.content)) continue;
      for (const part of m.content) {
        if (part?.type !== "tool_use" || part.name !== "artifacts") continue;
        apply(items, conv, (part.input ?? {}) as ToolInput);
      }
    }
  }
  return [...items.values()];
}

function apply(items: Map<string, ExportItem>, conv: string, i: ToolInput) {
  if (typeof i.id !== "string" || i.id === "") return;
  const importKey = `claude:${conv}:${i.id}`;
  const cur = items.get(importKey);
  if (i.command === "create" || i.command === "rewrite") {
    const type = typeof i.type === "string" ? i.type : (cur?.type ?? "");
    items.set(importKey, {
      importKey,
      conversationUuid: conv,
      artifactId: i.id,
      type,
      supported: SUPPORTED_TYPES.has(type),
      content: typeof i.content === "string" ? i.content : "",
    });
  } else if (
    i.command === "update" &&
    cur &&
    typeof i.old_str === "string" &&
    typeof i.new_str === "string"
  ) {
    cur.content = cur.content.replace(i.old_str, () => i.new_str as string);
  }
}

// ---------------------------------------------------------------- http

function readPat(path: string): string {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(path);
  } catch {
    throw new Error("patFile: file missing");
  }
  if (!st.isFile()) throw new Error("patFile: not a regular file");
  if (typeof process.getuid === "function" && st.uid !== process.getuid())
    throw new Error("patFile: not owned by the current user");
  if (process.platform !== "win32" && (st.mode & 0o077) !== 0)
    throw new Error("patFile: file mode must be 0600");
  const v = readFileSync(path, "utf8").trim();
  if (!v) throw new Error("patFile: file is empty");
  return v;
}

const hash = (b: Uint8Array) =>
  createHash("sha256").update(b).digest("hex").slice(0, 16);

class Api {
  private readonly pat: string;
  private readonly f: NonNullable<Target["fetch"]>;
  private readonly t: Target;
  constructor(t: Target) {
    this.t = t;
    this.pat = readPat(t.patFile);
    this.f = t.fetch ?? fetch;
  }

  /** GET path; null on 404 when allowed; throws status plus body hash otherwise. */
  async bytes(path: string, allow404 = false): Promise<Uint8Array | null> {
    const res = await this.f(new URL(path, this.t.app), {
      headers: { authorization: `Bearer ${this.pat}` },
      redirect: "manual",
    });
    const body = new Uint8Array(await res.arrayBuffer());
    if (res.status === 404 && allow404) return null;
    if (res.status < 200 || res.status > 299)
      throw new Error(
        `GET ${new URL(path, this.t.app).pathname}: status ${res.status}, body sha256:${hash(body)} (${body.byteLength} bytes)`,
      );
    return body;
  }

  async json<T>(path: string, allow404 = false): Promise<T | null> {
    const b = await this.bytes(path, allow404);
    if (b === null) return null;
    try {
      return JSON.parse(new TextDecoder().decode(b)) as T;
    } catch {
      throw new Error(
        `GET ${new URL(path, this.t.app).pathname}: not JSON, body sha256:${hash(b)}`,
      );
    }
  }

  async pages<T>(path: string, allow404 = false): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | null = null;
    do {
      const sep = path.includes("?") ? "&" : "?";
      const q: string = `${sep}limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const p: { items: T[]; nextCursor: string | null } | null =
        await this.json(`${path}${q}`, allow404);
      if (!p) return out;
      out.push(...p.items);
      cursor = p.nextCursor;
    } while (cursor);
    return out;
  }
}

const seg = encodeURIComponent;

interface Summary {
  id: string;
  owner: { id: string; email: string | null };
  space?: { id: string };
}

interface VersionInfo {
  version: number;
  files: { path: string; size: number }[];
}

/** Artifact ids, versions, spaces and owners, as the target's PAT sees them. */
export async function snapshot(target: Target): Promise<Snapshot> {
  return snap(new Api(target));
}

async function snap(api: Api): Promise<Snapshot> {
  const me = await api.json<{ user: { id: string; email: string | null } }>(
    "/api/v1/me",
  );
  if (!me) throw new Error("GET /api/v1/me: empty");
  // Spaces off: the route is absent (404) and no artifact carries a space.
  const spaces = await api.pages<{ id: string; name: string; kind: string }>(
    "/api/v1/spaces",
    true,
  );
  const list = await api.pages<Summary>("/api/v1/artifacts?scope=all");
  const artifacts: SnapArtifact[] = [];
  for (const s of list) {
    const versions: SnapVersion[] = [];
    let before: number | undefined;
    for (;;) {
      const q = before === undefined ? "" : `?before=${before}`;
      const page =
        (await api.json<VersionInfo[]>(
          `/api/v1/artifacts/${seg(s.id)}/versions${q}`,
        )) ?? [];
      if (page.length === 0) break;
      for (const v of page)
        versions.push({
          version: v.version,
          files: v.files.map((f) => ({ path: f.path, size: f.size })),
        });
      before = page[page.length - 1].version;
      if (before <= 1) break;
    }
    versions.sort((a, b) => a.version - b.version);
    artifacts.push({
      id: s.id,
      importKey: importKeyOf(s),
      ownerId: s.owner.id,
      ownerEmail: s.owner.email,
      spaceId: s.space?.id ?? null,
      versions,
    });
  }
  return {
    me: { id: me.user.id, email: me.user.email },
    personalSpaceId: spaces.find((x) => x.kind === "personal")?.id ?? null,
    spaces: spaces
      .filter((x) => x.kind !== "personal")
      .map((x) => ({ id: x.id, name: x.name })),
    artifacts,
  };
}

// ---------------------------------------------------------------- check

const isOwner = (owner: string, id: string, email: string | null) =>
  owner.includes("@")
    ? email?.toLowerCase() === owner.toLowerCase()
    : id === owner;

/** A spaceMap value (a space id, or a unique space name) as a space id. */
function resolveSpace(s: Snapshot, v: string): string | null {
  if (v === s.personalSpaceId || s.spaces.some((x) => x.id === v)) return v;
  const byName = s.spaces.filter((x) => x.name === v);
  if (byName.length === 1) return byName[0].id;
  throw new Error(
    `spaceMap: ${JSON.stringify(v)} is not a space id or a unique space name this PAT can see`,
  );
}

const fileUrl = (id: string, v: number, path: string) =>
  `/api/v1/artifacts/${seg(id)}/versions/${v}/files/${path.split("/").map(seg).join("/")}`;

/** Whether a version has a file whose bytes equal `content`. */
async function holds(
  api: Api,
  id: string,
  v: SnapVersion,
  content: string,
): Promise<boolean> {
  const want = Buffer.from(content, "utf8");
  for (const f of v.files) {
    if (f.size !== want.byteLength) continue;
    const got = await api.bytes(fileUrl(id, v.version, f.path));
    if (got && Buffer.from(got).equals(want)) return true;
  }
  return false;
}

/**
 * Versions this run added that it shouldn't have. A first import makes one
 * version. On a rerun, an artifact whose export content is unchanged since
 * `before` gains none, whatever their content; a changed one gains exactly one.
 */
async function hasExtraVersions(
  api: Api,
  art: SnapArtifact,
  prev: SnapArtifact | undefined,
  content: string,
): Promise<boolean> {
  const prevLatest = prev?.versions.at(-1);
  const added = art.versions.filter(
    (v) => v.version > (prevLatest?.version ?? 0),
  );
  if (!prevLatest) return added.length > 1;
  if (added.length === 0) return false;
  if (added.length > 1) return true;
  // Unchanged since `before` (versions are immutable, so read it now).
  return holds(api, art.id, prevLatest, content);
}

export async function checkImport(o: {
  target: Target;
  exportDir: string;
  owner: string;
  spaceMap: Record<string, string>;
  before: Snapshot;
}): Promise<Report> {
  const items = parseExport(o.exportDir);
  const api = new Api(o.target);
  const after = await snap(api);
  if (o.before.me.id !== after.me.id)
    throw new Error("checkImport: before and after come from different PATs");
  if (!isOwner(o.owner, after.me.id, after.me.email))
    throw new Error("checkImport: run it with the owner's PAT");
  const mapped = new Map<string, string | null>();
  for (const [k, v] of Object.entries(o.spaceMap))
    mapped.set(k, resolveSpace(after, v));
  const prevById = new Map(o.before.artifacts.map((a) => [a.id, a]));
  const keysBefore = new Set(o.before.artifacts.map((a) => a.importKey));
  const exportKeys = new Set(items.map((i) => i.importKey));
  const byKey = new Map<string, SnapArtifact[]>();
  for (const a of after.artifacts)
    if (a.importKey)
      byKey.set(a.importKey, [...(byKey.get(a.importKey) ?? []), a]);

  const r: Report = {
    expected: items.length,
    imported: 0,
    skipped: [],
    wrongSpace: [],
    wrongOwner: [],
    duplicates: [],
    extraVersions: [],
    unexpected: [],
    wrongContent: [],
  };
  // A new artifact is fine only as the first one for an export item.
  for (const a of after.artifacts) {
    if (prevById.has(a.id)) continue;
    if (!a.importKey) r.unexpected.push(a.id);
    else if (!exportKeys.has(a.importKey) || keysBefore.has(a.importKey))
      r.unexpected.push(a.importKey);
  }
  for (const it of items) {
    const key = it.importKey;
    const arts = byKey.get(key) ?? [];
    if (arts.length === 0) {
      r.skipped.push({
        ref: key,
        reason: it.supported
          ? NOT_IMPORTED
          : `${UNSUPPORTED}${it.type || "(none)"}`,
      });
      continue;
    }
    r.imported++;
    if (arts.length > 1) r.duplicates.push(key);
    const want = mapped.has(it.conversationUuid)
      ? mapped.get(it.conversationUuid)
      : mapped.has("*")
        ? mapped.get("*")
        : after.personalSpaceId;
    if (arts.some((a) => a.spaceId !== want)) r.wrongSpace.push(key);
    if (arts.some((a) => !isOwner(o.owner, a.ownerId, a.ownerEmail)))
      r.wrongOwner.push(key);
    let extra = false;
    let wrong = false;
    for (const a of arts) {
      if (await hasExtraVersions(api, a, prevById.get(a.id), it.content))
        extra = true;
      const latest = a.versions.at(-1);
      if (!latest || !(await holds(api, a.id, latest, it.content)))
        wrong = true;
    }
    if (extra) r.extraVersions.push(key);
    if (wrong) r.wrongContent.push(key);
  }
  return r;
}

/** Everything in a report that is a problem; [] for a clean import. */
export function problems(r: Report): string[] {
  return [
    ...r.skipped
      .filter((s) => !s.reason.startsWith(UNSUPPORTED))
      .map((s) => `skipped ${s.ref}: ${s.reason || "(no reason)"}`),
    ...r.wrongSpace.map((k) => `wrong space ${k}`),
    ...r.wrongOwner.map((k) => `wrong owner ${k}`),
    ...r.duplicates.map((k) => `duplicate ${k}`),
    ...r.extraVersions.map((k) => `extra versions ${k}`),
    ...r.unexpected.map((k) => `unexpected artifact ${k}`),
    ...r.wrongContent.map((k) => `wrong content ${k}`),
  ];
}
