import { normalizeEmail } from "@oa/auth-core";
import {
  type AccessLevel,
  type AgentRef,
  type ArtifactPatch,
  type ArtifactPatchResult,
  type ArtifactSummary,
  artifactCan,
  type DataWriters,
  dataWritersWarning,
  type Format,
  isId,
  LIMITS,
  type ListQuery,
  type Member,
  newId,
  type Page,
  type PublishInput,
  type PublishResult,
  R,
  resolveDataWriters,
  type UserRef,
  VERSIONS_PAGE_SIZE,
  type VersionInfo,
  VisibilitySchema,
  viewerPath,
} from "@oa/shared";
import { and, desc, eq, gte, type SQL, sql } from "drizzle-orm";
import {
  type ArtifactRow,
  accessLevel,
  authorize,
  type Caller,
  callerOf,
  canCtx,
  capOfCaller,
  checkListSpace,
  firstThumbnailEligible,
  levelSql,
  listFilterSql,
  publishTarget,
  roleRankQuery,
  roleRankSql,
} from "../auth/authz.js";
import { authConfig } from "../auth/config.js";
import { can, dataWritersOf } from "../auth/policy.js";
import { getDb } from "../db/client.js";
import { artifacts, shares, spaces, users } from "../db/schema.js";
import type { Env } from "../env.js";
import { ApiError, appOrigin } from "../http/errors.js";
import { logError, logInfo, logWarn } from "../log.js";
import { runtimeStub, type VersionEvent } from "../runtime/do.js";
import { closeRuntimeSockets } from "../runtime/revoke.js";
import { type AgentAttr, countVersionStmt, viaKey } from "./agent-usage.js";
import { audit, userActor } from "./audit.js";
import { type ManifestEntry, materialize, planFiles } from "./manifest.js";
import { getSettings } from "./members.js";
import { ftsFilter, seedSearchStmt, syncTitleStmt } from "./search.js";
import { requireSpaces } from "./spaces.js";
import { serverThumbnails, writeThumbnail } from "./thumbs.js";
import { toUserRef } from "./users.js";

type Ctx = Pick<ExecutionContext, "waitUntil">;
const CAPS = { db: false, viewer: false, storage: false };

const later = async (ctx: Ctx | undefined, p: Promise<unknown>) => {
  const safe = p.catch((e) => logError("background_task_failed", e));
  if (ctx) ctx.waitUntil(safe);
  else await safe;
};

/**
 * Queues search indexing of `version` on the artifact's DO (C3): one cheap
 * RPC, so extraction never runs on the request's CPU. Never throws: a lost
 * enqueue leaves the artifact searchable by title/description until
 * sweepLostIndexJobs re-enqueues it. With `event` (publish, restore) the same
 * RPC pushes the `version` frame to the artifact's R.events sockets (best
 * effort: a lost one is caught up by the client's next hello). Request paths
 * run it in waitUntil (`later`): the RPC takes 0.5-1.2 s on hosted installs.
 */
export async function enqueueIndex(
  env: Env,
  id: string,
  version: number,
  thumb = false,
  event?: VersionEvent,
): Promise<void> {
  // Wall time of the stub call (placement, cold start, round trip): slow
  // hosted installs need it measured.
  const t0 = Date.now();
  let doMs: number | undefined;
  try {
    doMs = (await runtimeStub(env, id).scheduleIndex(id, version, thumb, event))
      .ms;
  } catch (e) {
    logError("index_enqueue_failed", e, { artifactId: id, version });
  } finally {
    console.log(
      JSON.stringify({
        evt: "index_enqueue",
        install: env.INSTALL_ID?.trim() || undefined,
        artifactId: id,
        ms: Date.now() - t0,
        // The object's own share; the rest is placement and the round trip.
        doMs,
      }),
    );
  }
}

/** The R.events `version` attribution, from what the version row stores. */
export function versionEvent(
  user: Member,
  agent: AgentRef | null,
  at: number,
  restoredFrom?: number,
): VersionEvent {
  return {
    at: new Date(at).toISOString(),
    by: agent
      ? { kind: "agent", name: agent.name }
      : { kind: "user", name: user.name ?? user.email },
    ...(restoredFrom === undefined ? {} : { restoredFrom }),
  };
}

/**
 * - `create` (POST R.artifacts): no id, or a reserved id of this user's; any other id → 400.
 * - `version` (POST R.versions): the artifact must exist (editor+), else 404.
 * - `any` (MCP): either, by whether the id names an existing artifact.
 */
export type PublishMode = "create" | "version" | "any";

/**
 * Creates an artifact or adds a version (editor+; sharing fields owner-only).
 * Everything happens in one D1 batch (a transaction). The version number comes
 * from `UPDATE … current_version + 1 … RETURNING` and the versions
 * `INSERT … SELECT` reads it, so concurrent publishes never collide. Every
 * statement carries the same guard (artifact live, and all n listed uploads
 * still unconsumed, evaluated before the consume statement), so a lost race
 * writes nothing: 404 if the artifact is gone, 409 if an upload was used.
 */
export async function publish(
  env: Env,
  user: Member,
  input: PublishInput,
  agent: AgentAttr | null,
  ctx?: Ctx,
  mode: PublishMode = "any",
): Promise<PublishResult> {
  const plan = planFiles(input);
  const db = env.DB;
  const now = Date.now();
  // Wall ms per step (D1 checks, R2, the batch, the DO calls): hosted
  // publishes stall at low CPU and the step must be visible. Ids and ms only.
  const at: number[] = [now];
  const mark = () => at.push(Date.now());
  const notFound = () => new ApiError("not_found", "Not found");
  let id: string;
  let create = true;
  let reserved = false;
  let capabilities = CAPS;
  /** An existing artifact's sharing before this publish (#681). */
  let prior: { visibility: string; dataWriters: DataWriters } = {
    visibility: "",
    dataWriters: "viewers",
  };
  /** The dataWriters this publish writes (#681); undefined: unchanged. */
  let dataWriters: DataWriters | undefined;
  /** Sharing fields changed on an existing artifact: live sockets must reconnect. */
  let accessChanged = false;
  /** A visibility change on an existing artifact: audited in the batch. */
  let visAudit: D1PreparedStatement | null = null;
  /**
   * Compare-and-set (#484) when the input sets visibility: the bump only
   * applies while the row still has the visibility and space it was checked
   * against (`before`), and every later statement only while it has the new
   * visibility (`after`), so a stale resend never undoes a concurrent change.
   */
  let cas: { before: Guard; after: Guard } | null = null;
  /** The new artifact's space (create): the caller's personal space by default. */
  let spaceId = user.id;
  if (input.id === undefined) {
    if (mode === "version") throw notFound();
    id = newId();
  } else {
    id = input.id;
    // spaceId with an existing artifact's id is 400 use_move, in any mode.
    const exists =
      mode === "create" && input.spaceId === undefined
        ? null
        : await db
            .prepare("select 1 from artifacts where id = ?")
            .bind(id)
            .first();
    if (exists) {
      const who = callerOf(user);
      const { level, artifact: a } = await authorize(env, who, id, "publish");
      if (input.spaceId !== undefined)
        throw new ApiError(
          "use_move",
          "spaceId is only for new artifacts; move an existing one with POST /move",
          { path: "spaceId", reason: "use_move" },
        );
      create = false;
      const sharing =
        input.visibility !== undefined ||
        input.capabilities !== undefined ||
        input.dataWriters !== undefined ||
        input.allowAnonymousWrites !== undefined;
      if (sharing && !can(level, "visibility", canCtx(who, a)))
        throw new ApiError("bad_request", "only the owner can change sharing");
      await refusePublicLinksOff(env, a, input.visibility);
      if (input.visibility !== undefined)
        cas = {
          before: [
            ` and visibility = ? and space_id is ?${
              input.visibility === "public" && a.visibility !== "public"
                ? LINKS_STILL_ON
                : ""
            }`,
            [a.visibility, a.spaceId],
          ],
          after: [
            " and visibility = ? and space_id is ?",
            [input.visibility, a.spaceId],
          ],
        };
      capabilities = { ...CAPS, ...(JSON.parse(a.capabilities) as object) };
      prior = { visibility: a.visibility, dataWriters: dataWritersOf(a) };
      dataWriters = resolveDataWriters(input, input.visibility ?? a.visibility);
      if (input.visibility !== undefined && input.visibility !== a.visibility)
        visAudit = visibilityAudit(env, user, id, a, input.visibility);
      accessChanged =
        (input.visibility !== undefined && input.visibility !== a.visibility) ||
        (input.capabilities !== undefined &&
          JSON.stringify({ ...capabilities, ...input.capabilities }) !==
            JSON.stringify(capabilities)) ||
        (dataWriters !== undefined && dataWriters !== prior.dataWriters);
    } else {
      if (mode === "version") throw notFound();
      const r = await db
        .prepare(
          "select 1 from reserved_artifacts where id = ? and user_id = ?",
        )
        .bind(id, user.id)
        .first();
      if (!r) {
        if (mode === "create")
          throw new ApiError(
            "bad_request",
            "use POST /versions to publish a new version",
            { path: "id", reason: "not_reserved" },
          );
        throw notFound();
      }
      reserved = true;
    }
  }
  if (create && input.title === undefined)
    throw new ApiError(
      "bad_request",
      "title is required when creating an artifact",
      {
        path: "title",
        reason: "missing",
      },
    );
  // A shared space (or the caller's own personal one, by id): 404 when not
  // theirs to see, 403 space_forbidden when seen but not allowed.
  if (create && input.spaceId !== undefined && input.spaceId !== user.id) {
    // Another space needs the spaces feature (404 without it).
    requireSpaces(env);
    spaceId = (
      await publishTarget(env, callerOf(user), input.spaceId, "create")
    ).id;
    await refusePublicLinksOff(
      env,
      { spaceId, visibility: "" },
      input.visibility,
    );
  }
  const caps = JSON.stringify({ ...capabilities, ...input.capabilities });
  const visibility =
    input.visibility ??
    (create ? (await getSettings(env)).defaultVisibility : undefined);
  if (create) dataWriters = resolveDataWriters(input, visibility) ?? "viewers";

  mark();
  const { manifest, written, uploadIds } = await materialize(
    env,
    id,
    user.id,
    plan,
  );
  mark();
  // The inline content is in R2 now: drop the plan's copies so they don't
  // stay reachable through the D1 batch and enqueue awaits below.
  plan.files.length = 0;

  // Uploads guard: all listed uploads still unconsumed (uncorrelated subquery).
  const n = uploadIds.length;
  const ids = JSON.stringify(uploadIds);
  const guard = n
    ? " and (select count(*) from uploads where id in (select value from json_each(?)) and consumed = 0) = ?"
    : "";
  const guardArgs = n ? [ids, n] : [];

  const stmts: D1PreparedStatement[] = [];
  if (create) {
    // A public create into a shared space re-checks the space's public-links
    // toggle in the insert itself, so a racing toggle-off writes nothing.
    const links =
      spaceId !== user.id && visibility === "public"
        ? " and not exists (select 1 from spaces where id = ? and kind = 'shared' and public_links = 0)"
        : "";
    // Into a shared space: the caller's role there (editor or manager) is
    // re-checked in the insert, so a role revoked mid-request writes nothing.
    const role =
      spaceId !== user.id
        ? roleRankQuery(env, callerOf(user), spaceId)
        : { sql: "", params: [] as unknown[] };
    stmts.push(
      db
        .prepare(
          `insert into artifacts (id, owner_id, space_id, title, description, format, visibility,
             current_version, capabilities, data_writers, allow_anonymous_writes, created_at, updated_at)
           select ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ? where 1${links}${
             role.sql ? ` and ${role.sql} >= 2` : ""
           }${guard}`,
        )
        .bind(
          id,
          user.id,
          // Every artifact lives in a space (P3 T1): the caller's personal
          // space, or the shared one publishTarget allowed (T10).
          spaceId,
          input.title,
          input.description ?? null,
          plan.format,
          visibility,
          caps,
          dataWriters,
          // Kept in step for one release (#681): a rollback reads it.
          dataWriters === "viewers" ? 1 : 0,
          now,
          now,
          ...(links ? [spaceId] : []),
          ...role.params,
          ...guardArgs,
        ),
    );
    if (reserved)
      stmts.push(
        db
          .prepare(
            `delete from reserved_artifacts where id = ? and user_id = ?
               and exists (select 1 from artifacts where id = ?)`,
          )
          .bind(id, user.id, id),
      );
  }
  const extra: [string, unknown][] = [];
  if (!create) {
    const opt: [string, unknown][] = [
      ["title", input.title],
      ["description", input.description],
      ["visibility", input.visibility],
      ["capabilities", input.capabilities && caps],
      ["data_writers", dataWriters],
      // Kept in step for one release (#681): a rollback reads it.
      [
        "allow_anonymous_writes",
        dataWriters === undefined
          ? undefined
          : dataWriters === "viewers"
            ? 1
            : 0,
      ],
    ];
    for (const [col, v] of opt) if (v !== undefined) extra.push([col, v]);
  }
  const bump = stmts.length;
  stmts.push(
    ...allocateVersion(db, {
      id,
      now,
      agent,
      userId: user.id,
      format: plan.format,
      entry: plan.entry,
      manifest: JSON.stringify(manifest),
      language: plan.language,
      message: input.message ?? null,
      extra,
      guard,
      guardArgs,
      cas,
    }),
  );
  // Title/description searchable now (a new row, or the existing row synced
  // on rename); the body is indexed asynchronously.
  if (visAudit) stmts.push(visAudit);
  stmts.push(seedSearchStmt(db, id));
  if (!create && (input.title !== undefined || input.description !== undefined))
    stmts.push(syncTitleStmt(env, id));
  // Last: the guard above still sees every listed upload unconsumed.
  if (n)
    stmts.push(
      db
        .prepare(
          `update uploads set consumed = 1
           where id in (select value from json_each(?)) and consumed = 0
             and exists (select 1 from artifacts where id = ? and deleted_at is null${cas ? cas.after[0] : ""})${guard}`,
        )
        .bind(ids, id, ...(cas ? cas.after[1] : []), ...guardArgs),
    );

  const cleanup = () =>
    written.length ? later(ctx, env.FILES.delete(written)) : undefined;
  let version: number | undefined;
  try {
    const res = await db.batch<{ current_version: number }>(stmts);
    version = res[bump]?.results[0]?.current_version;
  } catch (e) {
    await cleanup();
    const msg = String((e as Error)?.message);
    if (msg.includes("UNIQUE constraint failed: artifacts.id"))
      throw new ApiError("conflict", "Artifact already exists");
    // A lost compare-and-set whose row already had the new visibility: the
    // version insert met the other writer's version row.
    if (cas && msg.includes("UNIQUE constraint failed: versions"))
      throw changed();
    throw e;
  }
  mark();
  if (version === undefined) {
    await cleanup();
    // A create writes nothing only when its space changed (the public-links
    // re-check) or an upload was used.
    if (create)
      throw n
        ? new ApiError("conflict", "An upload was already used")
        : changed();
    const live = await db
      .prepare("select 1 from artifacts where id = ? and deleted_at is null")
      .bind(id)
      .first();
    if (live)
      throw cas
        ? changed()
        : new ApiError("conflict", "An upload was already used");
    throw notFound();
  }
  // Access changed: close first (gone "changed"), awaited, so a socket that
  // may have lost access never sees this version; reconnects get hello.
  if (accessChanged) await closeRuntimeSockets(env, [id], "access changed");
  mark();
  // After the response (waitUntil): the index job, thumbnail job and version
  // frame. A lost one is recovered by sweepLostIndexJobs. enqueue_ms below is
  // now only the hand-off; index_enqueue logs the DO call's own wall time.
  await later(
    ctx,
    enqueueIndex(env, id, version, true, versionEvent(user, agent, now)),
  );
  mark();
  logPublishTiming(env, id, create, at);
  const warning = dataWritersWarning({
    visibility: visibility ?? prior.visibility,
    capabilities: JSON.parse(caps) as { db: boolean },
    dataWriters: dataWriters ?? prior.dataWriters,
  });
  return {
    id,
    version,
    url: appOrigin(env) + viewerPath(id),
    ...(warning ? { warning } : {}),
  };
}

/**
 * One line per successful publish: wall ms of the D1 checks, the R2 writes,
 * the D1 batch, the socket close and the index enqueue (marks taken in
 * publish). Install and artifact ids and numbers only.
 */
export function logPublishTiming(
  env: Pick<Env, "INSTALL_ID">,
  artifactId: string,
  create: boolean,
  at: readonly number[],
): void {
  const [
    start = 0,
    checks = start,
    r2 = checks,
    batch = r2,
    close = batch,
    enq = close,
  ] = at;
  console.log(
    JSON.stringify({
      evt: "publish_timing",
      install: env.INSTALL_ID?.trim() || undefined,
      artifactId,
      create,
      checks_ms: checks - start,
      r2_ms: r2 - checks,
      batch_ms: batch - r2,
      close_ms: close - batch,
      enqueue_ms: enq - close,
      total_ms: enq - start,
    }),
  );
}

const notFound = () => new ApiError("not_found", "Not found");
/**
 * Appended to an artifacts UPDATE that makes the row public: the space's
 * public-links toggle re-checked in the write, so a racing toggle-off never
 * lets a new public link through (it loses as a 409).
 */
const LINKS_STILL_ON =
  " and not exists (select 1 from spaces where id = artifacts.space_id and kind = 'shared' and public_links = 0)";
/** A compare-and-set lost to a concurrent change (#484). */
const changed = () =>
  new ApiError("conflict", "The artifact changed while saving; try again");
/** An SQL fragment appended to a WHERE, and its arguments. */
type Guard = [string, unknown[]];
const bad = (message: string, path?: string) =>
  new ApiError(
    "bad_request",
    message,
    path ? { path, reason: "invalid" } : undefined,
  );
const DAY = 86400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const asUser = (user: Member): Caller => callerOf(user);

type Alloc = {
  id: string;
  now: number;
  /** Its `via` (grant or token) is stored on the version and counted. */
  agent: AgentAttr | null;
  userId: string;
  /** The new version's format; also becomes the artifact's format. */
  format: Format;
  entry: string;
  /** JSON of ManifestEntry[] */
  manifest: string;
  language: string | null;
  message: string | null;
  /** Further `col = ?` assignments on the artifact row. */
  extra?: [string, unknown][];
  /** Extra guard appended to both WHEREs (e.g. the publish uploads guard). */
  guard?: string;
  guardArgs?: unknown[];
  /** Compare-and-set: `before` on the bump, `after` on the version insert. */
  cas?: { before: Guard; after: Guard } | null;
};

/**
 * The race-safe version allocation shared by publish and restore: two
 * statements for one D1 batch. The first bumps `current_version` (RETURNING
 * it; no row → artifact gone), the second inserts the version row reading that
 * same number via INSERT … SELECT, so concurrent writers never collide. With
 * a grant or token behind the agent, a third statement counts the version
 * for it (countVersionStmt: only if the version row was written).
 */
export function allocateVersion(
  db: D1Database,
  a: Alloc,
): [D1PreparedStatement, D1PreparedStatement, ...D1PreparedStatement[]] {
  const guard = a.guard ?? "";
  const guardArgs = a.guardArgs ?? [];
  const [before, beforeArgs] = a.cas?.before ?? ["", []];
  const [after, afterArgs] = a.cas?.after ?? ["", []];
  const sets = [
    "current_version = current_version + 1",
    "updated_at = ?",
    "last_agent_name = ?",
    "last_agent_version = ?",
  ];
  const vals: unknown[] = [
    a.now,
    a.agent?.name ?? null,
    a.agent?.version ?? null,
  ];
  const extra: [string, unknown][] = [["format", a.format], ...(a.extra ?? [])];
  for (const [col, v] of extra) {
    sets.push(`${col} = ?`);
    vals.push(v);
  }
  const via = a.agent?.via;
  return [
    db
      .prepare(
        `update artifacts set ${sets.join(", ")}
         where id = ? and deleted_at is null${before}${guard} returning current_version`,
      )
      .bind(...vals, a.id, ...beforeArgs, ...guardArgs),
    db
      .prepare(
        `insert into versions (artifact_id, version, entry, manifest, language, message,
           agent_name, agent_version, agent_via, created_by, created_at, format)
         select id, current_version, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? from artifacts
         where id = ? and deleted_at is null${after}${guard}`,
      )
      .bind(
        a.entry,
        a.manifest,
        a.language,
        a.message,
        a.agent?.name ?? null,
        a.agent?.version ?? null,
        via ? viaKey(via) : null,
        a.userId,
        a.now,
        a.format,
        a.id,
        ...afterArgs,
        ...guardArgs,
      ),
    ...(via ? [countVersionStmt(db, via, a.userId, a.id, a.now)] : []),
  ];
}

// ---------------------------------------------------------------- summaries

export function toSummary(
  env: Env,
  a: ArtifactRow,
  owner: UserRef,
  access: AccessLevel,
): ArtifactSummary {
  return {
    id: a.id,
    title: a.title,
    description: a.description,
    format: a.format as Format,
    visibility: a.visibility as ArtifactSummary["visibility"],
    owner,
    currentVersion: a.currentVersion,
    createdAt: iso(a.createdAt),
    updatedAt: iso(a.updatedAt),
    deletedAt: a.deletedAt == null ? null : iso(a.deletedAt),
    lastAgent:
      a.lastAgentName == null
        ? null
        : { name: a.lastAgentName, version: a.lastAgentVersion },
    thumbnailUrl: a.hasThumbnail
      ? appOrigin(env) +
        R.thumbnail(a.id) +
        (a.thumbnailVersion ? `?v=${a.thumbnailVersion}` : "")
      : null,
    thumbnailVersion: a.hasThumbnail ? (a.thumbnailVersion ?? null) : null,
    access,
    capabilities: { ...CAPS, ...(JSON.parse(a.capabilities) as object) },
    dataWriters: dataWritersOf(a),
    // Deprecated (#681): derived for one release.
    allowAnonymousWrites: dataWritersOf(a) === "viewers",
  };
}

export { dataWritersOf };

/** Anonymous callers never see member emails (not even as a name fallback). */
export function redact(
  u: { id: string; email: string; name: string; displayName: string | null },
  caller: Caller,
): UserRef {
  return toUserRef(u, caller.kind === "user");
}

async function ownerRef(env: Env, ownerId: string, caller: Caller) {
  const u = await env.DB.prepare(
    "select id, email, name, display_name as displayName from users where id = ?",
  )
    .bind(ownerId)
    .first<{
      id: string;
      email: string;
      name: string;
      displayName: string | null;
    }>();
  if (!u) throw notFound();
  return redact(u, caller);
}

/** Viewer+; otherwise 404. Deleted artifacts are 404 (see list includeDeleted). */
export async function getSummary(
  env: Env,
  caller: Caller,
  id: string,
): Promise<ArtifactSummary> {
  const r = await accessLevel(env, caller, id);
  if (!r) throw notFound();
  const owner = await ownerRef(env, r.artifact.ownerId, caller);
  const out = toSummary(env, r.artifact, owner, r.level);
  if (!decorates(env, caller))
    return decorate(env, caller, out, r.level, null, null);
  // One PK read for the space (lists and search read it from their join).
  const [sp] = await getDb(env)
    .select(spaceCols(caller, true, sql`${spaces.id}`))
    .from(spaces)
    .where(eq(spaces.id, r.artifact.spaceId ?? ""))
    .limit(1);
  return withSpace(caller, out, r.level, r.artifact.spaceId, sp);
}

/** The artifact's space row as withSpace reads it (null: no row). */
export type SpaceCols = {
  kind: string | null;
  name: string | null;
  publicLinks: number | null;
  /** The caller's role rank in a shared space (roleRankSql); 0 = none. */
  rank: number | null;
};

/**
 * The joined space's columns for a list, search or get SELECT (no extra
 * statement). `rank` is computed only when the row is decorated (`on`).
 */
export const spaceCols = (
  c: Caller,
  on: boolean,
  spaceId: SQL = sql`${artifacts.spaceId}`,
) => ({
  kind: spaces.kind,
  name: spaces.name,
  publicLinks: spaces.publicLinks,
  rank: on
    ? sql<number>`case when ${spaces.kind} = 'shared' then ${roleRankSql(c, spaceId)} else 0 end`
    : sql<number>`0`,
});

/**
 * Hosted M1: `space` (and `can` with it) go on artifact responses for
 * signed-in callers while spaces are on (getSummary, list, search; never
 * anonymous). Without spaces, `decorate` still sets `can` (withCan).
 */
export const decorates = (env: Env, caller: Caller): boolean =>
  caller.kind === "user" && authConfig(env).features.includes("spaces");

/**
 * Sets `out.space` (SpaceRef) and `out.can` (artifactCan of the caller's
 * level, personal or not, with their cap) from the space row already read.
 * A personal space is named for its owner as the caller may see them (the
 * summary's owner ref), never by the stored name. A missing row reads as
 * personal, as decide() does. A shared space is shown only to callers with
 * a role there (space_members, Every-space, allMembersRole when uncapped:
 * checkListSpace's rule); anyone else (a share recipient, say) gets no
 * `space`, so its name and id never leak. Call only when `decorates`.
 */
export function withSpace<T extends ArtifactSummary>(
  caller: Caller,
  out: T,
  level: AccessLevel,
  spaceId: string | null,
  sp: SpaceCols | null | undefined,
): T {
  const shared = sp?.kind === "shared";
  if (sp?.kind && (!shared || (sp.rank ?? 0) > 0))
    out.space = {
      id: spaceId ?? "",
      kind: shared ? "shared" : "personal",
      name: shared ? (sp.name ?? "") : (out.owner.name ?? "Personal"),
      publicLinks: shared ? sp.publicLinks === 1 : true,
    };
  out.can = artifactCan(level, {
    personal: !shared,
    cap: capOfCaller(caller),
    dataWriters: out.dataWriters,
  });
  return out;
}

/**
 * `can` for a signed-in caller on an install without spaces (parity 1:
 * artifacts always carry the server's `can`): every artifact is personal
 * there, and move and transfer (spaces routes, 404 without them) are false.
 * No `space`.
 */
export function withCan<T extends ArtifactSummary>(
  caller: Caller,
  out: T,
  level: AccessLevel,
): T {
  out.can = {
    ...artifactCan(level, {
      personal: true,
      cap: capOfCaller(caller),
      dataWriters: out.dataWriters,
    }),
    move: false,
    transfer: false,
  };
  return out;
}

/**
 * A signed-in caller's decoration: `space` and `can` with spaces on
 * (withSpace), `can` alone without (withCan). Anonymous callers get neither.
 */
export function decorate<T extends ArtifactSummary>(
  env: Env,
  caller: Caller,
  out: T,
  level: AccessLevel,
  spaceId: string | null,
  sp: SpaceCols | null | undefined,
): T {
  if (caller.kind !== "user") return out;
  return decorates(env, caller)
    ? withSpace(caller, out, level, spaceId, sp)
    : withCan(caller, out, level);
}

// --------------------------------------------------------------------- list

type Cursor = { u: number; i: string };
const B64URL = /^[A-Za-z0-9_-]+$/;

export function encodeCursor(c: Cursor): string {
  return btoa(JSON.stringify(c))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Strict: anything but b64url JSON `{u: int, i: id}` → 400. */
export function decodeCursor(s: string): Cursor {
  const invalid = () => bad("Invalid cursor", "cursor");
  if (!B64URL.test(s) || s.length > 200) throw invalid();
  let v: unknown;
  try {
    v = JSON.parse(atob(s.replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    throw invalid();
  }
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    Object.keys(v).length !== 2 ||
    !Number.isSafeInteger((v as Cursor).u) ||
    typeof (v as Cursor).i !== "string" ||
    !isId((v as Cursor).i)
  )
    throw invalid();
  return { u: (v as Cursor).u, i: (v as Cursor).i };
}

const ISO_DATE =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

/**
 * The list SELECT (exported for the EXPLAIN test). The visibility filter is
 * listFilterSql, whose per-branch `deleted_at is null` lets SQLite use the
 * partial live indexes; order is the keyset (updated_at desc, id desc).
 */
export function listQuery(env: Env, caller: Caller, q: ListQuery) {
  const db = getDb(env);
  const email =
    caller.kind === "user" ? normalizeEmail(caller.user.email) : null;
  const conds: (SQL | undefined)[] = [
    listFilterSql(caller, q.scope, q.includeDeleted, q.spaceId),
  ];
  if (q.format) conds.push(eq(artifacts.format, q.format));
  if (q.visibility) conds.push(eq(artifacts.visibility, q.visibility));
  if (q.agent !== undefined) conds.push(eq(artifacts.lastAgentName, q.agent));
  // owner "me" (any case) is the caller; anything else is an email.
  if (q.owner !== undefined && q.owner.trim().toLowerCase() === "me") {
    if (caller.kind !== "user") throw bad("Invalid owner email", "owner");
    conds.push(eq(artifacts.ownerId, caller.user.id));
  } else if (q.owner !== undefined) {
    const e = normalizeEmail(q.owner);
    if (!e) throw bad("Invalid owner email", "owner");
    conds.push(
      sql`${artifacts.ownerId} = (select u.id from users u where u.email = ${e})`,
    );
  }
  if (q.updatedSince !== undefined) {
    const t = ISO_DATE.test(q.updatedSince) ? Date.parse(q.updatedSince) : NaN;
    if (Number.isNaN(t)) throw bad("Invalid updatedSince", "updatedSince");
    conds.push(gte(artifacts.updatedAt, t));
  }
  // Full-text over title/description/body (same sanitizer as search).
  if (q.q?.trim()) conds.push(ftsFilter(q.q));
  if (q.cursor !== undefined) {
    const c = decodeCursor(q.cursor);
    conds.push(
      sql`(${artifacts.updatedAt} < ${c.u} or (${artifacts.updatedAt} = ${c.u} and ${artifacts.id} < ${c.i}))`,
    );
  }
  return db
    .select({
      a: artifacts,
      ownerEmail: users.email,
      ownerName: users.name,
      ownerDisplayName: users.displayName,
      level: levelSql(caller, { allowDeleted: q.includeDeleted }),
      // The joined space, for `space` and `can` (withSpace).
      space: spaceCols(caller, decorates(env, caller)),
    })
    .from(artifacts)
    .innerJoin(users, eq(users.id, artifacts.ownerId))
    .leftJoin(spaces, eq(spaces.id, artifacts.spaceId))
    .leftJoin(
      shares,
      and(
        eq(shares.artifactId, artifacts.id),
        email ? eq(shares.email, email) : sql`0`,
      ),
    )
    .where(and(...conds))
    .orderBy(desc(artifacts.updatedAt), desc(artifacts.id))
    .limit(q.limit + 1);
}

/** Signed-in callers only (anonymous → 401). */
export async function list(
  env: Env,
  caller: Caller,
  q: ListQuery,
): Promise<Page<ArtifactSummary>> {
  if (caller.kind !== "user")
    throw new ApiError("unauthorized", "Sign in required");
  if (q.spaceId !== undefined) {
    await checkListSpace(env, caller, q.spaceId);
    // mine is the caller's personal space: inside a shared one it can only
    // be empty, so say so (the dashboard's "Mine" tab sends owner=me).
    if (q.scope === "mine" && q.spaceId !== caller.user.id)
      throw bad('scope "mine" is the personal space; use owner=me', "spaceId");
  }
  const rows = await listQuery(env, caller, q);
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  // The level comes from SQL (levelSql, decide's twin). Belt and braces with
  // listFilterSql: a row it denies is dropped, never shown with a guessed
  // level. The cursor still follows the SQL page.
  const items: ArtifactSummary[] = [];
  for (const r of page) {
    const { level } = r;
    if (!level) continue;
    const out = toSummary(
      env,
      r.a,
      redact(
        {
          id: r.a.ownerId,
          email: r.ownerEmail,
          name: r.ownerName,
          displayName: r.ownerDisplayName,
        },
        caller,
      ),
      level,
    );
    items.push(decorate(env, caller, out, level, r.a.spaceId, r.space));
  }
  return {
    items,
    nextCursor:
      rows.length > q.limit && last
        ? encodeCursor({ u: last.a.updatedAt, i: last.a.id })
        : null,
  };
}

// ----------------------------------------------------------------- versions

type VersionRow = {
  version: number;
  entry: string;
  manifest: string;
  language: string | null;
  message: string | null;
  agent_name: string | null;
  agent_version: string | null;
  created_by: string;
  created_at: number;
  text_indexed: number;
  format: Format;
  email: string;
  name: string | null;
  displayName: string | null;
};

/** A versions page stops once its manifests' cumulative length passes this. */
export const VERSIONS_PAGE_BYTES = 1024 * 1024;

/**
 * Viewer+; newest first, keyset `version < before`: at most VERSIONS_PAGE_SIZE,
 * and only while the cumulative manifest length stays within
 * VERSIONS_PAGE_BYTES (always at least one), so pages may be short. Sizes are
 * summed in SQL so oversized manifests are never read. A version's format
 * falls back to the artifact's for rows written before migration 0002.
 */
export async function listVersions(
  env: Env,
  caller: Caller,
  id: string,
  before?: number,
): Promise<VersionInfo[]> {
  await authorize(env, caller, id, "versions");
  const { results } = await env.DB.prepare(
    `with page as (
       select version, length(manifest) as len from versions
       where artifact_id = ?1 and version < ?2 order by version desc limit ?3
     ), cut as (
       select version, row_number() over w as rn, sum(len) over w as total
       from page window w as (order by version desc)
     )
     select v.version, v.entry, v.manifest, v.language, v.message, v.agent_name,
       v.agent_version, v.created_by, v.created_at, v.text_indexed,
       coalesce(v.format, a.format) as format, u.email, u.name,
       u.display_name as displayName
     from cut
     join versions v on v.artifact_id = ?1 and v.version = cut.version
     join artifacts a on a.id = v.artifact_id
     join users u on u.id = v.created_by
     where cut.rn = 1 or cut.total <= ?4
     order by v.version desc`,
  )
    .bind(
      id,
      before ?? Number.MAX_SAFE_INTEGER,
      VERSIONS_PAGE_SIZE,
      VERSIONS_PAGE_BYTES,
    )
    .all<VersionRow>();
  return results.map((v) => ({
    version: v.version,
    message: v.message,
    agent:
      v.agent_name == null
        ? null
        : { name: v.agent_name, version: v.agent_version },
    createdBy: redact(
      {
        id: v.created_by,
        email: v.email,
        name: v.name ?? "",
        displayName: v.displayName,
      },
      caller,
    ),
    createdAt: iso(v.created_at),
    entry: v.entry,
    files: (JSON.parse(v.manifest) as ManifestEntry[]).map(
      ({ path, size, contentType }) => ({ path, size, contentType }),
    ),
    language: v.language,
    textIndexed: v.text_indexed === 1,
    format: v.format,
  }));
}

/** Viewer+. The R2 body of one file of one version, with the manifest's content type. */
export async function readVersionFile(
  env: Env,
  caller: Caller,
  id: string,
  v: number,
  path: string,
): Promise<{ body: R2ObjectBody; contentType: string }> {
  await authorize(env, caller, id, "version.file");
  const row = await env.DB.prepare(
    "select manifest from versions where artifact_id = ? and version = ?",
  )
    .bind(id, v)
    .first<{ manifest: string }>();
  if (!row) throw notFound();
  const entry = (JSON.parse(row.manifest) as ManifestEntry[]).find(
    (e) => e.path === path,
  );
  if (!entry) throw notFound();
  const body = await env.FILES.get(entry.key);
  if (!body) throw notFound();
  return { body, contentType: entry.contentType };
}

/** Viewer+. The thumbnail object, or 404. */
export async function readThumbnail(
  env: Env,
  caller: Caller,
  id: string,
): Promise<R2ObjectBody> {
  const { artifact: a } = await authorize(env, caller, id, "thumbnail.read");
  const body = a.hasThumbnail ? await env.FILES.get(`thumbs/${id}.webp`) : null;
  if (!body) throw notFound();
  return body;
}

const isWebp = (b: Uint8Array) =>
  b.length >= 12 &&
  String.fromCharCode(...b.subarray(0, 4)) === "RIFF" &&
  String.fromCharCode(...b.subarray(8, 12)) === "WEBP";

/**
 * Editor+ always. A viewer may set only the FIRST thumbnail, and only via a
 * share or a team role on a team artifact (never public visibility alone).
 * The first-thumbnail slot is claimed atomically before the R2 put.
 * `version` is the version the image depicts (default: the current one); a
 * thumbnail of a newer version already stored → 409 conflict (writeThumbnail).
 */
export async function putThumbnail(
  env: Env,
  user: Member,
  id: string,
  bytes: Uint8Array,
  version?: number,
): Promise<void> {
  const who = asUser(user);
  const r = await accessLevel(env, who, id);
  if (!r) throw notFound();
  const editor = can(r.level, "publish", canCtx(who, r.artifact));
  let firstThumbnail = editor;
  if (!editor) {
    const email = normalizeEmail(user.email);
    const shared = email
      ? await env.DB.prepare(
          "select 1 x from shares where artifact_id = ? and email = ?",
        )
          .bind(id, email)
          .first()
      : null;
    firstThumbnail = firstThumbnailEligible(who, r.artifact, !!shared);
  }
  if (
    !can(r.level, "thumbnail.write", {
      ...canCtx(who, r.artifact),
      firstThumbnail,
    })
  )
    throw notFound();
  const v = version ?? r.artifact.currentVersion;
  if (v > r.artifact.currentVersion)
    throw new ApiError("bad_request", "No such version");
  if (!isWebp(bytes)) throw new ApiError("bad_request", "Body must be WebP");
  const stale = () =>
    new ApiError("conflict", "A thumbnail of a newer version exists");
  if (editor) {
    if ((await writeThumbnail(env, id, v, bytes, "client")) === "stale")
      throw stale();
    return;
  }
  const claimed = await env.DB.prepare(
    "update artifacts set has_thumbnail = 1 where id = ? and has_thumbnail = 0 and deleted_at is null returning id",
  )
    .bind(id)
    .first();
  if (!claimed) throw notFound();
  let result: "stored" | "stale";
  try {
    result = await writeThumbnail(env, id, v, bytes, "client");
  } catch (e) {
    await env.DB.prepare(
      "update artifacts set has_thumbnail = 0 where id = ? and thumbnail_version is null",
    )
      .bind(id)
      .run();
    throw e;
  }
  if (result === "stale") throw stale();
}

/**
 * Editor+. Copies version `v`'s manifest/entry/language/format as a new
 * version ("Restored v{v}") via allocateVersion, which also sets the
 * artifact's format to it; restored versions share R2 keys.
 */
export async function restoreVersion(
  env: Env,
  user: Member,
  id: string,
  v: number,
  agent: AgentAttr | null,
  ctx?: Ctx,
): Promise<PublishResult> {
  await authorize(env, asUser(user), id, "restore");
  const src = await env.DB.prepare(
    `select v.entry, v.manifest, v.language, coalesce(v.format, a.format) as format
     from versions v join artifacts a on a.id = v.artifact_id
     where v.artifact_id = ? and v.version = ?`,
  )
    .bind(id, v)
    .first<{
      entry: string;
      manifest: string;
      language: string | null;
      format: Format;
    }>();
  if (!src) throw notFound();
  const now = Date.now();
  const res = await env.DB.batch<{ current_version: number }>([
    ...allocateVersion(env.DB, {
      id,
      now,
      agent,
      userId: user.id,
      format: src.format,
      entry: src.entry,
      manifest: src.manifest,
      language: src.language,
      message: `Restored v${v}`,
    }),
    seedSearchStmt(env.DB, id),
  ]);
  const version = res[0]?.results[0]?.current_version;
  if (version === undefined) throw notFound();
  await later(
    ctx,
    enqueueIndex(env, id, version, true, versionEvent(user, agent, now, v)),
  );
  return { id, version, url: appOrigin(env) + viewerPath(id) };
}

// ------------------------------------------------------- patch and delete

/**
 * Changing visibility to "public" in a shared space with public links off:
 * 403 public_links_off. The toggle only refuses new links; an artifact that
 * is already public stays viewable (decide, /p/), and echoing "public" on it
 * is a no-op that passes (agents resend it). One PK read, only on a change to
 * "public".
 */
async function refusePublicLinksOff(
  env: Env,
  a: { spaceId: string | null; visibility: string },
  visibility: string | undefined,
): Promise<void> {
  const spaceId = a.spaceId;
  if (visibility !== "public" || a.visibility === "public" || spaceId === null)
    return;
  const off = await env.DB.prepare(
    "select 1 from spaces where id = ? and kind = 'shared' and public_links = 0",
  )
    .bind(spaceId)
    .first();
  if (off)
    throw new ApiError(
      "public_links_off",
      "Public links are off in this space",
    );
}

/**
 * artifact.visibility for the change's batch, right after the statement that
 * sets it (or, in publish, the version insert that follows it): written only
 * when that statement changed a row and the row now has the new visibility
 * (a lost compare-and-set or a deleted artifact writes nothing).
 */
function visibilityAudit(
  env: Env,
  user: Member,
  id: string,
  a: { spaceId: string | null; visibility: string },
  to: string,
): D1PreparedStatement {
  return audit(
    env,
    "artifact.visibility",
    { type: "artifact", id },
    userActor(user.id),
    {
      spaceId: a.spaceId,
      detail: { from: a.visibility, to },
      when: {
        sql: "changes() > 0 and exists (select 1 from artifacts where id = ? and visibility = ? and deleted_at is null)",
        args: [id, to],
      },
    },
  );
}

/**
 * title/description: editor+; visibility/capabilities/dataWriters (and the
 * deprecated allowAnonymousWrites, mapped by resolveDataWriters): owner or
 * manager. A result that is public, declares db and lets viewers write data
 * carries `warning` (#681).
 */
export async function patch(
  env: Env,
  user: Member,
  id: string,
  p: ArtifactPatch,
  ctx?: Ctx,
): Promise<ArtifactPatchResult> {
  const who = asUser(user);
  const { level, artifact: a } = await authorize(env, who, id, "publish");
  const sharing =
    p.visibility !== undefined ||
    p.capabilities !== undefined ||
    p.dataWriters !== undefined ||
    p.allowAnonymousWrites !== undefined;
  if (sharing && !can(level, "visibility", canCtx(who, a)))
    throw new ApiError("bad_request", "only the owner can change sharing");
  await refusePublicLinksOff(env, a, p.visibility);
  const dataWriters = resolveDataWriters(p, p.visibility ?? a.visibility);
  const sets: string[] = [];
  const vals: unknown[] = [];
  const set = (col: string, v: unknown) => {
    sets.push(col);
    vals.push(v);
  };
  if (p.title !== undefined) set("title = ?", p.title);
  if (p.description !== undefined) set("description = ?", p.description);
  if (p.visibility !== undefined) set("visibility = ?", p.visibility);
  if (p.capabilities !== undefined)
    set(
      "capabilities = json_patch(capabilities, ?)",
      JSON.stringify(p.capabilities),
    );
  if (dataWriters !== undefined) {
    set("data_writers = ?", dataWriters);
    // Kept in step for one release (#681): a rollback reads it.
    set("allow_anonymous_writes = ?", dataWriters === "viewers" ? 1 : 0);
  }
  if (sets.length) {
    set("updated_at = ?", Date.now());
    // Compare-and-set on the visibility and space checked above (#484).
    const cas = p.visibility !== undefined;
    const toPublic = p.visibility === "public" && a.visibility !== "public";
    const upd = env.DB.prepare(
      `update artifacts set ${sets.join(", ")} where id = ? and deleted_at is null${
        cas ? " and visibility = ? and space_id is ?" : ""
      }${toPublic ? LINKS_STILL_ON : ""}`,
    ).bind(...vals, id, ...(cas ? [a.visibility, a.spaceId] : []));
    const batch = [upd];
    if (p.visibility !== undefined && p.visibility !== a.visibility)
      batch.push(visibilityAudit(env, user, id, a, p.visibility));
    if (p.title !== undefined || p.description !== undefined)
      batch.push(syncTitleStmt(env, id));
    const res =
      batch.length > 1 ? (await env.DB.batch(batch))[0] : await upd.run();
    if (cas && !res?.meta.changes) {
      const live = await env.DB.prepare(
        "select 1 from artifacts where id = ? and deleted_at is null",
      )
        .bind(id)
        .first();
      if (live) throw changed();
    }
  }
  if (
    (p.visibility !== undefined && p.visibility !== a.visibility) ||
    p.capabilities !== undefined ||
    (dataWriters !== undefined && dataWriters !== dataWritersOf(a))
  )
    await closeRuntimeSockets(env, [id], "access changed", ctx);
  const out = await getSummary(env, asUser(user), id);
  const warning = dataWritersWarning(out);
  return warning ? { ...out, warning } : out;
}

/** True when publish input names an artifact and carries no content or files (#681 D). */
export const isSettingsOnly = (input: PublishInput): boolean =>
  input.id !== undefined &&
  input.content === undefined &&
  input.files === undefined;

/**
 * MCP publish_artifact with `id` and no content or files (#681 D): updates
 * the settings in place through `patch` (the REST PATCH path: same access
 * checks, warning, audit and socket closing) and creates no version.
 * `message` is ignored. format, language and entry belong to a version (400);
 * so does nothing to change (400); spaceId is 400 use_move, as on publish.
 */
export async function publishSettings(
  env: Env,
  user: Member,
  input: PublishInput,
  ctx?: Ctx,
): Promise<PublishResult> {
  const id = input.id as string;
  for (const k of ["format", "language", "entry"] as const)
    if (input[k] !== undefined)
      throw bad(
        `${k} belongs to a version: pass content or files to publish one`,
        k,
      );
  const {
    title,
    description,
    visibility,
    capabilities,
    dataWriters,
    allowAnonymousWrites,
  } = input;
  const p: ArtifactPatch = Object.fromEntries(
    Object.entries({
      title,
      description,
      visibility,
      // As in PATCH, any capabilities (even {}) is a sharing field.
      capabilities,
      dataWriters,
      allowAnonymousWrites,
    }).filter(([, v]) => v !== undefined),
  );
  if (input.spaceId !== undefined) {
    // After the access check, as publish does: 404 before use_move.
    await authorize(env, asUser(user), id, "publish");
    throw new ApiError(
      "use_move",
      "spaceId is only for new artifacts; move an existing one with POST /move",
      { path: "spaceId", reason: "use_move" },
    );
  }
  if (Object.keys(p).length === 0)
    throw new ApiError(
      "bad_request",
      "Nothing to change: pass content or files to publish a version, or title, description, visibility, capabilities or dataWriters to update the artifact in place",
      { path: "id", reason: "missing" },
    );
  // An id the caller reserved (create_upload) with no artifact yet: only the
  // reserving user learns it exists; anyone else gets patch's 404.
  const reserved = await env.DB.prepare(
    "select 1 from reserved_artifacts r where r.id = ? and r.user_id = ? and not exists (select 1 from artifacts a where a.id = r.id)",
  )
    .bind(id, user.id)
    .first();
  if (reserved)
    throw new ApiError(
      "bad_request",
      "This artifact has no version yet: publish content or files first, then change its settings",
      { path: "id", reason: "no_version" },
    );
  const a = await patch(env, user, id, p, ctx);
  return {
    id: a.id,
    version: a.currentVersion,
    url: appOrigin(env) + viewerPath(a.id),
    ...(a.warning ? { warning: a.warning } : {}),
  };
}

/** Owner only (others 404). Sets deleted_at and drops the search row. */
export async function softDelete(
  env: Env,
  user: Member,
  id: string,
  ctx?: Ctx,
): Promise<void> {
  await authorize(env, asUser(user), id, "delete");
  await env.DB.batch([
    env.DB.prepare(
      "delete from artifact_search where rowid = (select rowid from artifacts where id = ?)",
    ).bind(id),
    env.DB.prepare(
      "update artifacts set deleted_at = ?, purge_attempts = 0, purge_after = null where id = ? and deleted_at is null",
    ).bind(Date.now(), id),
  ]);
  await closeRuntimeSockets(env, [id], "artifact deleted", ctx, "deleted");
}

/** Owner only, within LIMITS.softDeleteDays; re-indexes the current version. */
export async function undelete(
  env: Env,
  user: Member,
  id: string,
  ctx?: Ctx,
): Promise<ArtifactSummary> {
  const { artifact: a } = await authorize(env, asUser(user), id, "undelete", {
    allowDeleted: true,
  });
  if (a.deletedAt != null) {
    // A shared space's trash restores only into a live space, with spaces
    // on (#792 D); 404 otherwise, as for no access. Personal trash always.
    const sp = await env.DB.prepare(
      "select kind, deleted_at from spaces where id = ?",
    )
      .bind(a.spaceId ?? "")
      .first<{ kind: string; deleted_at: number | null }>();
    if (
      sp?.kind === "shared" &&
      (sp.deleted_at !== null || !authConfig(env).features.includes("spaces"))
    )
      throw notFound();
    const cutoff = Date.now() - LIMITS.softDeleteDays * DAY;
    // The search row went with the delete: the current version is unindexed
    // again (a pdf takes a viewer's text again) and updated_at moves, so a
    // lost enqueue below is the sweeps' (tick and daily) to recover.
    const [r] = await env.DB.batch([
      env.DB.prepare(
        "update artifacts set deleted_at = null, updated_at = ? where id = ? and deleted_at >= ?",
      ).bind(Date.now(), id, cutoff),
      env.DB.prepare(
        `update versions set text_indexed = 0, index_failed = 0
         where artifact_id = ?1 and version = (select current_version from artifacts where id = ?1 and deleted_at is null)`,
      ).bind(id),
      seedSearchStmt(env.DB, id),
    ]);
    if (!r?.meta.changes) throw notFound();
    // thumb: every enqueue carries the thumbnail job, so text_indexed = 1
    // proves a non-pdf version's thumbnail job landed (sweepLostIndexJobs).
    await later(ctx, enqueueIndex(env, id, a.currentVersion, true));
  }
  return getSummary(env, asUser(user), id);
}

// ------------------------------------------------------------ re-indexing

/** Current versions re-enqueued per sweep, per kind (text, thumbnail). */
export const REINDEX_BATCH = 20;
/** Leaves fresh publishes to their own pending job. */
export const REINDEX_MIN_AGE_MS = 10 * 60_000;
/**
 * The frequent sweep's look-back past REINDEX_MIN_AGE_MS: five 2-min ticks,
 * so a missed tick or two still sees each publish; anything older is the
 * daily sweep's.
 */
export const SWEEP_TICK_SPAN_MS = 10 * 60_000;
/**
 * The daily sweep's pdf thumbnail look-back: hosted installs can miss several
 * nightly runs, and a tick tail can miss a whole day.
 */
export const THUMB_SWEEP_SPAN_MS = 7 * DAY;

const LIVE_VIS = VisibilitySchema.options.map((v) => `'${v}'`).join(", ");
// The visibility list lets the (visibility, updated_at) partial live index
// serve the updated_at range, so a tick reads only its window's rows.
const sweepSql = (kind: "text" | "thumb") =>
  `select a.id, a.current_version as v from artifacts a
   join versions v on v.artifact_id = a.id and v.version = a.current_version
   where a.deleted_at is null and a.visibility in (${LIVE_VIS})
     and a.updated_at >= ?1 and a.updated_at < ?2 and ${
       kind === "text"
         ? "v.text_indexed = 0 and v.index_failed = 0 and coalesce(v.format, a.format) <> 'pdf'"
         : "v.thumb_failed = 0 and coalesce(v.format, a.format) = 'pdf' and coalesce(a.thumbnail_version, 0) < a.current_version"
     }
   order by a.updated_at limit ?3`;

/**
 * Safety net for lost enqueues (C3; publish and restore enqueue after the
 * response): re-enqueues, with the thumbnail job, live artifacts (oldest
 * first, up to REINDEX_BATCH per kind, past REINDEX_MIN_AGE_MS) whose
 * - current non-pdf version is still text_indexed = 0. Every enqueue carries
 *   the thumbnail job, so this also recovers a non-pdf thumbnail; a non-pdf
 *   version that is text_indexed got its thumbnail job, and a missing
 *   thumbnail there is the capture's own (logged) outcome.
 * - current pdf version has no thumbnail of it, with server thumbnails on (a
 *   pdf's text comes from its viewer, so text_indexed proves nothing).
 * `tick` (the hosted 2-min system job) looks back SWEEP_TICK_SPAN_MS; the
 * daily cron looks back without bound for text and THUMB_SWEEP_SPAN_MS for
 * pdf thumbnails. Versions the DO marked permanently failed (index_failed,
 * thumb_failed) are skipped, so they never hold the batch. Re-enqueueing a
 * job that did land is a no-op in the DO (same version; the thumbnail job
 * only moves forward). Logs one index_sweep line with counts when either is
 * non-zero.
 */
export async function sweepLostIndexJobs(
  env: Env,
  now: number,
  mode: "tick" | "daily",
): Promise<{ text: number; thumb: number }> {
  const hi = now - REINDEX_MIN_AGE_MS;
  const tickLo = hi - SWEEP_TICK_SPAN_MS;
  const pick = (kind: "text" | "thumb", lo: number) =>
    env.DB.prepare(sweepSql(kind))
      .bind(lo, hi, REINDEX_BATCH)
      .all<{ id: string; v: number }>()
      .then((r) => r.results);
  const [text, thumb] = await Promise.all([
    pick("text", mode === "tick" ? tickLo : 0),
    serverThumbnails(env)
      ? pick("thumb", mode === "tick" ? tickLo : now - THUMB_SWEEP_SPAN_MS)
      : [],
  ]);
  await Promise.all(
    [...text, ...thumb].map((r) => enqueueIndex(env, r.id, r.v, true)),
  );
  const counts = { text: text.length, thumb: thumb.length };
  if (counts.text || counts.thumb) logInfo("index_sweep", { mode, ...counts });
  return counts;
}

/** The daily cron's sweepLostIndexJobs; returns how many it re-enqueued. */
export async function reindexStale(env: Env, now: number): Promise<number> {
  const r = await sweepLostIndexJobs(env, now, "daily");
  return r.text + r.thumb;
}

// -------------------------------------------------------------------- purge

const PURGE_BATCH = 50;
/**
 * R2 delete calls per run. Each list is followed by one delete, and with
 * PURGE_BATCH artifacts and PURGE_KEYS_LISTED keys a run makes at most ~60 of
 * each, well under 1000 subrequests; this cap is a backstop.
 */
const PURGE_R2_DELETES = 600;
/** R2 keys listed per run: bounds cron CPU. */
const PURGE_KEYS_LISTED = 5000;
/** Delay before retrying a failed purge: 1, 2, 4 … days, at most 32 (the cron is daily). */
export const purgeBackoff = (attempts: number) =>
  // A minute of slack so the next daily run, a little early, still picks it up.
  2 ** Math.min(Math.max(attempts, 1) - 1, 5) * DAY - 60_000;
type PurgeBudget = { deletes: number; listed: number };
const canPurge = (b: PurgeBudget) => b.deletes > 0 && b.listed > 0;

/**
 * Hard-deletes artifacts soft-deleted more than softDeleteDays ago, at most
 * PURGE_BATCH per run, PURGE_R2_DELETES deletes and PURGE_KEYS_LISTED listed
 * keys; the rest wait for the next
 * run. Per artifact: R2 `files/{id}/` (restored versions share these keys) and
 * `thumbs/{id}.webp`, then DO storage, then the rows (versions/shares cascade).
 * Returns the number purged.
 */
export async function purgeDeleted(env: Env, now: number): Promise<number> {
  const cutoff = now - LIMITS.softDeleteDays * DAY;
  // Artifacts whose purge failed wait out their backoff and then queue behind
  // never-failed ones, so permanently failing ones can't fill every run's window.
  const { results } = await env.DB.prepare(
    `select id, rowid as rid, purge_attempts as attempts from artifacts
     where deleted_at is not null and deleted_at < ?
       and (purge_after is null or purge_after <= ?)
     order by purge_attempts, deleted_at limit ?`,
  )
    .bind(cutoff, now, PURGE_BATCH)
    .all<{ id: string; rid: number; attempts: number }>();
  const budget: PurgeBudget = {
    deletes: PURGE_R2_DELETES,
    listed: PURGE_KEYS_LISTED,
  };
  let purged = 0;
  for (const { id, rid, attempts } of results) {
    if (!canPurge(budget)) break;
    try {
      if (await purgeOne(env, id, rid, cutoff, budget)) purged++;
    } catch (e) {
      // One bad artifact must not block the rest; it is retried after a backoff.
      logError("purge_failed", e, { artifactId: id });
      // Structured, for Workers Logs alerting: this one keeps failing.
      if (attempts + 1 >= 3)
        logWarn("purge_failing", undefined, { id, attempts: attempts + 1 });
      await env.DB.prepare(
        "update artifacts set purge_attempts = purge_attempts + 1, purge_after = ? where id = ?",
      )
        .bind(now + purgeBackoff(attempts + 1), id)
        .run()
        .catch(() => {});
    }
  }
  return purged;
}

/** True when fully purged; false when the R2 budget ran out first. */
async function purgeOne(
  env: Env,
  id: string,
  rid: number,
  cutoff: number,
  budget: PurgeBudget,
): Promise<boolean> {
  // Deleted keys vanish from the listing, so each page re-lists from the start.
  // 999 per page leaves room for the thumbnail in R2's 1000-key delete.
  for (;;) {
    if (!canPurge(budget)) return false;
    const page = await env.FILES.list({
      prefix: `files/${id}/`,
      limit: Math.min(999, budget.listed),
    });
    budget.listed -= page.objects.length;
    budget.deletes -= 1;
    const keys = page.objects.map((o) => o.key);
    if (!page.truncated) keys.push(`thumbs/${id}.webp`);
    await env.FILES.delete(keys);
    if (!page.truncated) break;
  }
  await destroyRuntime(env, id);
  await env.DB.batch([
    env.DB.prepare("delete from artifact_search where rowid = ?").bind(rid),
    env.DB.prepare("delete from uploads where artifact_id = ?").bind(id),
    env.DB.prepare(
      "delete from artifacts where id = ? and deleted_at is not null and deleted_at < ?",
    ).bind(id, cutoff),
  ]);
  return true;
}

async function destroyRuntime(env: Env, id: string): Promise<void> {
  await runtimeStub(env, id).destroy();
}
