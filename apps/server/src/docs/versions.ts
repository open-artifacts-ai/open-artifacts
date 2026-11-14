// Saving a doc's versions from the room (#1100). One save writes the four
// files to R2 FIRST (index.html, doc.md, doc.json, doc.yjs), then the version
// row through the same allocation path publishing uses (allocateVersion), with
// the contributors in the same D1 batch (so a version never exists without
// its contributors, nor the reverse), then queues search indexing. A failure
// at any step throws; the room keeps the edits and the next save retries. The
// files of a failed save are deleted again (best effort; a leftover is only
// an unreferenced R2 object).
import {
  type DocJSON,
  docFragment,
  docToMarkdown,
  yXmlFragmentToDoc,
} from "@oa/doc-schema";
import { DOC_ENTRY, newId } from "@oa/shared";
import * as Y from "yjs";
import type { Env } from "../env.js";
import { logError } from "../log.js";
import type { AgentAttr } from "../services/agent-usage.js";
import {
  allocateVersion,
  enqueueIndex,
  versionEvent,
} from "../services/artifacts.js";
import { seedSearchStmt } from "../services/search.js";
import { getUser } from "../services/users.js";
import { docToHtml } from "./render.js";

/** Someone who edited since the last version. */
export type Contributor = {
  kind: "person" | "agent";
  /** The user id (a person), "anon", or the agent's key. */
  key: string;
  /** The user behind a person, or the token owner an agent acts as. */
  userId?: string | null;
  agentName?: string | null;
  agentVersion?: string | null;
  agentVia?: string | null;
};

export type SaveInput = {
  artifactId: string;
  /** The room's full Yjs state (applied updates, buffer included). */
  state: Uint8Array;
  /** The version's author: the last editor, or whoever pressed Save. */
  author: Contributor | null;
  /** The version message (a name, "Restored v3"), or null for an automatic save. */
  message: string | null;
  contributors: Contributor[];
  now: number;
  restoredFrom?: number;
  /** How the room saved this version (stored as versions.doc_save). */
  docSave: DocSaveKind;
  /** Who docSave names, when not the author (before_agent: the agent about to edit). */
  docSaveBy?: Contributor | null;
};

export type DocSaveKind = "auto" | "named" | "before_agent" | "restore";

/** versions.doc_save: JSON {kind, by?}; `by` is the author when known. */
export function docSaveJson(kind: DocSaveKind, by: Contributor | null): string {
  return JSON.stringify({
    kind,
    ...(by
      ? {
          by:
            by.kind === "agent"
              ? {
                  kind: "agent",
                  name: by.agentName ?? "Agent",
                  version: by.agentVersion ?? null,
                  via: by.agentVia ?? null,
                  userId: by.userId ?? null,
                }
              : { kind: "person", userId: by.userId ?? by.key },
        }
      : {}),
  });
}

const FILES = [
  ["index.html", "text/html; charset=utf-8"],
  [DOC_ENTRY, "text/markdown; charset=utf-8"],
  ["doc.json", "application/json; charset=utf-8"],
  ["doc.yjs", "application/octet-stream"],
] as const;

/** Writes one version. Returns its number; throws with nothing half-written in D1. */
export async function writeDocVersion(
  env: Env,
  o: SaveInput,
): Promise<{ version: number }> {
  const art = await env.DB.prepare(
    "select owner_id, title from artifacts where id = ? and doc = 1 and deleted_at is null",
  )
    .bind(o.artifactId)
    .first<{ owner_id: string; title: string }>();
  if (!art) throw new Error("doc_gone");

  const ydoc = new Y.Doc();
  let json: DocJSON;
  let md: string;
  try {
    Y.applyUpdate(ydoc, o.state);
    const node = yXmlFragmentToDoc(docFragment(ydoc));
    json = node.toJSON() as DocJSON;
    md = docToMarkdown(node);
  } finally {
    ydoc.destroy();
  }
  const bodies: Record<string, string | Uint8Array> = {
    "index.html": docToHtml(json, art.title),
    [DOC_ENTRY]: md,
    "doc.json": JSON.stringify(json),
    "doc.yjs": o.state,
  };

  const enc = new TextEncoder();
  const written: string[] = [];
  const manifest: {
    path: string;
    key: string;
    size: number;
    contentType: string;
  }[] = [];
  const puts: Promise<unknown>[] = [];
  for (const [path, contentType] of FILES) {
    const body = bodies[path] as string | Uint8Array;
    const key = `files/${o.artifactId}/${newId()}`;
    written.push(key);
    manifest.push({
      path,
      key,
      size:
        typeof body === "string"
          ? enc.encode(body).byteLength
          : body.byteLength,
      contentType,
    });
    puts.push(env.FILES.put(key, body, { httpMetadata: { contentType } }));
  }
  const cleanup = () => env.FILES.delete(written).catch(() => {});
  const put = await Promise.allSettled(puts);
  const failed = put.find((r) => r.status === "rejected");
  if (failed) {
    await cleanup();
    throw (failed as PromiseRejectedResult).reason;
  }

  const author = o.author;
  const createdBy = author?.userId ?? art.owner_id;
  const agent: AgentAttr | null =
    author?.kind === "agent"
      ? {
          name: author.agentName ?? "Agent",
          version: author.agentVersion ?? null,
        }
      : null;
  let version: number | undefined;
  try {
    const res = await env.DB.batch<{ current_version: number }>([
      ...allocateVersion(env.DB, {
        id: o.artifactId,
        now: o.now,
        agent,
        userId: createdBy,
        format: "markdown",
        entry: DOC_ENTRY,
        manifest: JSON.stringify(manifest),
        language: null,
        message: o.message,
      }),
      env.DB.prepare(
        `update versions set doc_save = ?
         where artifact_id = ? and version = (select current_version from artifacts where id = ?)`,
      ).bind(
        docSaveJson(o.docSave, o.docSaveBy ?? author),
        o.artifactId,
        o.artifactId,
      ),
      ...o.contributors.map((c) =>
        env.DB.prepare(
          `insert or ignore into version_contributors
             (artifact_id, version, kind, key, user_id, agent_name, agent_version, agent_via)
           select id, current_version, ?, ?,
             (select id from users where id = ?), ?, ?, ? from artifacts
           where id = ? and deleted_at is null`,
        ).bind(
          c.kind,
          c.key,
          c.userId ?? null,
          c.kind === "agent" ? (c.agentName ?? "Agent") : null,
          c.agentVersion ?? null,
          c.agentVia ?? null,
          o.artifactId,
        ),
      ),
      seedSearchStmt(env.DB, o.artifactId),
    ]);
    version = res[0]?.results[0]?.current_version;
  } catch (e) {
    await cleanup();
    throw e;
  }
  if (version === undefined) {
    await cleanup();
    throw new Error("doc_gone");
  }
  // Search indexes the version's text (doc.md) through the publish path's job.
  try {
    const user = await getUser(env, createdBy);
    await enqueueIndex(
      env,
      o.artifactId,
      version,
      true,
      user ? versionEvent(user, agent, o.now, o.restoredFrom) : undefined,
    );
  } catch (e) {
    logError("doc_version_index_failed", e, {
      artifactId: o.artifactId,
      version,
    });
  }
  return { version };
}
