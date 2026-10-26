// Platform D1 (`platformNames(env).db`): install metadata and the append-only
// audit trail. Schema: apps/platform-db/migrations/0001_installs.sql. Holds no
// customer data and no secret; every write checks the env prefix first.
import { createHash } from "node:crypto";
import type { Cf } from "./cf.js";
import { assertOwnResource, type Env } from "./names.js";
import type { InstallId } from "./types.js";

export interface InstallRow {
  id: InstallId;
  slug: string;
  app_host: string;
  content_host: string;
  owner_email: string | null;
  d1_id: string | null;
  kv_id: string | null;
  version: string | null;
  previous_version: string | null;
  rl_ns: number;
  do_migration_tag: string | null;
  test_hooks: number;
  inputs_hash: string;
  broker_kid: string | null;
  state: InstallState;
  created_at: number | null;
  updated_at: number | null;
  /** The operation lock (0003): set by claim, cleared by finish. */
  lease: string | null;
  lease_until: number | null;
  /** A session cut still owed to the install's D1 (0003). */
  session_cut: string | null;
  /** The install's current vars, canonical JSON (0003). */
  vars: string | null;
  /** Bumped on every write (0003 trigger); claims compare it. */
  row_version: number;
  /** The vars a pending session_cut was minted against (0003). */
  session_cut_base: string | null;
  /** 1 once an upload turning google on may have gone live (0003). */
  session_cut_armed: number;
  /** H-DV (0005): the Google directory revoke a delete waits for. */
  directory_revoke: DirectoryRevoke | null;
  directory_revoked_at: number | null;
  directory_revoke_attempts: number;
}

/** pending: the scheduler's revoke tick owns it; the rest are final for delete. */
export type DirectoryRevoke =
  | "pending"
  | "done"
  | "unsupported"
  | "skipped"
  | "failed";

export type InstallState =
  | "creating"
  | "active"
  | "upgrading"
  | "deleting"
  | "deleted";

/** What install_versions keeps per install and version (0003). */
export interface StoredVersion {
  vars: Record<string, string>;
  metadata: Record<string, unknown>;
  do_migration_tag: string | null;
}

/** JSON with object keys sorted at every level. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`,
      )
      .join(",")}}`;
  return JSON.stringify(v);
}

/** sha256 of the canonical JSON of what a resume must not change. */
export function inputsHash(o: {
  ownerEmail: string;
  vars?: Record<string, string>;
  testHooks?: boolean;
}): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        ownerEmail: o.ownerEmail,
        vars: o.vars ?? {},
        testHooks: o.testHooks === true,
      }),
    )
    .digest("hex");
}

/** First ratelimit namespace id per env; installs take blocks of 8 above it. */
export const RL_BASE: Record<Env, number> = {
  staging: 1_000_000,
  prod: 2_000_000,
};

const UPDATABLE = new Set([
  "d1_id",
  "kv_id",
  "version",
  "previous_version",
  "do_migration_tag",
  "broker_kid",
  "state",
  "session_cut",
  "vars",
  "session_cut_base",
  "session_cut_armed",
  "directory_revoke",
]);

export class PlatformDb {
  constructor(
    private readonly cf: Cf,
    private readonly db: { id: string; name: string },
    private readonly env: Env,
    private readonly now: () => number,
  ) {}

  private async read(sql: string, params: unknown[]): Promise<InstallRow[]> {
    const r = await this.cf.d1Query(this.db.id, sql, params);
    return (r[0]?.results ?? []) as unknown as InstallRow[];
  }

  private async write(sql: string, params: unknown[]) {
    assertOwnResource(this.db.name, this.env);
    return this.cf.d1Query(this.db.id, sql, params);
  }

  async byId(id: string): Promise<InstallRow | undefined> {
    return (await this.read("SELECT * FROM installs WHERE id = ?1", [id]))[0];
  }

  async bySlug(slug: string): Promise<InstallRow | undefined> {
    return (
      await this.read("SELECT * FROM installs WHERE slug = ?1", [slug])
    )[0];
  }

  /**
   * Installs, in any state (deleted included), that hold any of these hosts
   * as app host, content host or in the hosts table.
   */
  async holdersOf(hosts: [string, string]): Promise<InstallRow[]> {
    return this.read(
      "SELECT * FROM installs WHERE app_host IN (?1, ?2) OR content_host IN (?1, ?2) OR id IN (SELECT install_id FROM hosts WHERE host IN (?1, ?2))",
      hosts,
    );
  }

  /**
   * One batch (all or nothing): the `creating` row with the next free block
   * of 8 ratelimit ids, both hosts, and the create.start audit row.
   */
  async insertCreating(r: {
    id: InstallId;
    slug: string;
    appHost: string;
    contentHost: string;
    ownerEmail: string;
    testHooks: boolean;
    inputsHash: string;
  }): Promise<InstallRow> {
    const base = RL_BASE[this.env];
    const now = this.now();
    assertOwnResource(this.db.name, this.env);
    await this.cf.d1Batch(this.db.id, [
      {
        sql: `INSERT INTO installs (id, slug, app_host, content_host, owner_email, inputs_hash, test_hooks, state, rl_ns, created_at, updated_at)
SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, 'creating', COALESCE(MAX(rl_ns) + 8, ?8), ?9, ?9
FROM installs WHERE rl_ns >= ?8 AND rl_ns < ?10`,
        params: [
          r.id,
          r.slug,
          r.appHost,
          r.contentHost,
          r.ownerEmail,
          r.inputsHash,
          r.testHooks ? 1 : 0,
          base,
          now,
          base + 1_000_000,
        ],
      },
      {
        sql: "INSERT INTO hosts (host, install_id) VALUES (?1, ?2)",
        params: [r.appHost, r.id],
      },
      {
        sql: "INSERT INTO hosts (host, install_id) VALUES (?1, ?2)",
        params: [r.contentHost, r.id],
      },
      {
        sql: "INSERT INTO hosted_audit (at, install_id, action, detail) VALUES (?1, ?2, 'create.start', ?3)",
        params: [now, r.id, canonicalJson({ slug: r.slug })],
      },
    ]);
    const row = await this.byId(r.id);
    if (!row) throw new Error(`install ${r.id}: row missing after insert`);
    if (row.rl_ns >= base + 1_000_000 || row.rl_ns % 8 !== 0)
      throw new Error(
        `install ${r.id}: ratelimit block ${row.rl_ns} is outside the ${this.env} range`,
      );
    return row;
  }

  /**
   * Updates the row. With `lease`, only while that lease still holds it;
   * false when it does not (the caller lost the lease).
   */
  async update(
    id: InstallId,
    fields: Partial<InstallRow>,
    lease?: string,
  ): Promise<boolean> {
    const keys = Object.keys(fields);
    for (const k of keys)
      if (!UPDATABLE.has(k)) throw new Error(`installs.${k} is not updatable`);
    if (keys.length === 0) return true;
    const set = keys.map((k, i) => `${k} = ?${i + 1}`).join(", ");
    const r = await this.write(
      `UPDATE installs SET ${set}, updated_at = ?${keys.length + 1} WHERE id = ?${keys.length + 2}${lease === undefined ? "" : ` AND lease = ?${keys.length + 3}`}`,
      [
        ...keys.map((k) => (fields as Record<string, unknown>)[k] ?? null),
        this.now(),
        id,
        ...(lease === undefined ? [] : [lease]),
      ],
    );
    return lease === undefined || r[0]?.meta?.changes === 1;
  }

  /** Hosts rows held by another install (any state). */
  async hostsHeldByOthers(id: string, hosts: [string, string]) {
    const r = await this.cf.d1Query(
      this.db.id,
      "SELECT host, install_id FROM hosts WHERE host IN (?1, ?2) AND install_id <> ?3",
      [hosts[0], hosts[1], id],
    );
    return (r[0]?.results ?? []) as { host: string; install_id: string }[];
  }

  /**
   * One batch on resume: re-insert both hosts rows (INSERT OR IGNORE heals a
   * first batch that was not atomic) and the create.resume audit row.
   */
  async resume(r: {
    id: InstallId;
    slug: string;
    appHost: string;
    contentHost: string;
  }): Promise<void> {
    assertOwnResource(this.db.name, this.env);
    const now = this.now();
    await this.cf.d1Batch(this.db.id, [
      {
        sql: "INSERT OR IGNORE INTO hosts (host, install_id) VALUES (?1, ?2)",
        params: [r.appHost, r.id],
      },
      {
        sql: "INSERT OR IGNORE INTO hosts (host, install_id) VALUES (?1, ?2)",
        params: [r.contentHost, r.id],
      },
      {
        sql: "INSERT INTO hosted_audit (at, install_id, action, detail) VALUES (?1, ?2, 'create.resume', ?3)",
        params: [now, r.id, canonicalJson({ slug: r.slug })],
      },
    ]);
  }

  /** Rows of every install in one of `states`. */
  async inStates(states: InstallState[]): Promise<InstallRow[]> {
    return this.read(
      `SELECT * FROM installs WHERE state IN (${states.map((_, i) => `?${i + 1}`).join(", ")}) ORDER BY id`,
      states,
    );
  }

  /**
   * Compare-and-swap: moves the row from one of `from` to `to` and takes the
   * operation lock, only when no live lock is held. False when another
   * operation got there first (or the row is in another state).
   */
  async claim(
    id: InstallId,
    from: InstallState[],
    to: InstallState,
    lease: string,
    until: number,
    rowVersion: number,
  ): Promise<boolean> {
    const now = this.now();
    const r = await this.write(
      `UPDATE installs SET state = ?1, lease = ?2, lease_until = ?3, updated_at = ?4 WHERE id = ?5 AND row_version = ?6 AND state IN (${from.map((_, i) => `?${i + 7}`).join(", ")}) AND (lease_until IS NULL OR lease_until <= ?4)`,
      [to, lease, until, now, id, rowVersion, ...from],
    );
    return r[0]?.meta?.changes === 1;
  }

  /** Renews the lock, a CAS on its value; false when another holds the row now. */
  async renew(id: InstallId, lease: string, until: number): Promise<boolean> {
    const r = await this.write(
      "UPDATE installs SET lease_until = ?1 WHERE id = ?2 AND lease = ?3",
      [until, id, lease],
    );
    return r[0]?.meta?.changes === 1;
  }

  /** Sets the final state and drops the lock, if this lease still holds it. */
  async finish(
    id: InstallId,
    lease: string,
    state: InstallState,
  ): Promise<boolean> {
    const r = await this.write(
      "UPDATE installs SET state = ?1, lease = NULL, lease_until = NULL, updated_at = ?2 WHERE id = ?3 AND lease = ?4",
      [state, this.now(), id, lease],
    );
    return r[0]?.meta?.changes === 1;
  }

  /** The stored render of one version, or undefined. */
  async version(
    id: InstallId,
    version: string,
  ): Promise<StoredVersion | undefined> {
    const r = await this.cf.d1Query(
      this.db.id,
      "SELECT vars, metadata, do_migration_tag FROM install_versions WHERE install_id = ?1 AND version = ?2",
      [id, version],
    );
    const row = r[0]?.results?.[0];
    if (!row) return undefined;
    return {
      vars: JSON.parse(String(row.vars)),
      metadata: JSON.parse(String(row.metadata)),
      do_migration_tag: (row.do_migration_tag ?? null) as string | null,
    };
  }

  /** Stores (or replaces) the render of one version; never a secret value. */
  async putVersion(
    id: InstallId,
    version: string,
    v: StoredVersion,
  ): Promise<void> {
    await this.write(
      "INSERT INTO install_versions (install_id, version, vars, metadata, do_migration_tag, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT (install_id, version) DO UPDATE SET vars = excluded.vars, metadata = excluded.metadata, do_migration_tag = excluded.do_migration_tag, updated_at = excluded.updated_at",
      [
        id,
        version,
        canonicalJson(v.vars),
        canonicalJson(v.metadata),
        v.do_migration_tag,
        this.now(),
      ],
    );
  }

  /** Drops the install's hosts rows (delete's first step, with HOSTS). The installs row keeps both hosts held. */
  async unmapHosts(id: InstallId): Promise<void> {
    await this.write("DELETE FROM hosts WHERE install_id = ?1", [id]);
  }

  /** The highest signed floor seq this env has accepted (0 before any). A cache only. */
  async floorSeq(): Promise<number> {
    const r = await this.cf.d1Query(
      this.db.id,
      "SELECT floor_seq FROM release_floor WHERE id = 1",
      [],
    );
    const row = r[0]?.results?.[0];
    if (!row) return 0;
    // N1: a row that is not a whole number is refused, never read as 0.
    const v = row.floor_seq;
    if (!Number.isSafeInteger(v) || (v as number) < 0)
      throw new Error(
        "platform D1 release_floor.floor_seq is not a whole number",
      );
    return v as number;
  }

  /** Raises the floor_seq cache; MAX, so it never goes down. */
  async raiseFloorSeq(seq: number): Promise<void> {
    if (!Number.isSafeInteger(seq) || seq < 1)
      throw new Error("floor seq must be a positive integer");
    await this.write(
      "INSERT INTO release_floor (id, floor_seq) VALUES (1, ?1) ON CONFLICT (id) DO UPDATE SET floor_seq = MAX(floor_seq, excluded.floor_seq)",
      [seq],
    );
  }

  /**
   * Appends an audit row with its actor (the operator's git email, or the CI
   * run URL): the oa:hosted CLI's before and after rows. `detail` must never
   * carry a secret or an email.
   */
  async auditAs(
    actor: string,
    id: InstallId | "-",
    action: string,
    detail: Record<string, string | number> = {},
  ): Promise<void> {
    if (typeof actor !== "string" || actor === "" || actor.length > 300)
      throw new Error("an audit actor is required");
    await this.write(
      "INSERT INTO hosted_audit (at, actor, install_id, action, detail) VALUES (?1, ?2, ?3, ?4, ?5)",
      [this.now(), actor, id, action, canonicalJson(detail)],
    );
  }

  /** H-DV: one install's revoke state, read only (delete's phase-2 poll). */
  async revokeState(id: InstallId): Promise<{
    state: DirectoryRevoke | null;
    attempts: number;
    revokedAt: number | null;
  } | null> {
    const r = (
      await this.cf.d1Query(
        this.db.id,
        "SELECT directory_revoke, directory_revoke_attempts, directory_revoked_at FROM installs WHERE id = ?1",
        [id],
      )
    )[0]?.results?.[0];
    if (!r) return null;
    return {
      state: (r.directory_revoke ?? null) as DirectoryRevoke | null,
      attempts: Number(r.directory_revoke_attempts ?? 0),
      revokedAt:
        r.directory_revoked_at === null || r.directory_revoked_at === undefined
          ? null
          : Number(r.directory_revoked_at),
    };
  }

  /** Appends an audit row; `detail` must never carry a secret or an email. */
  async audit(
    id: InstallId,
    action: string,
    detail: Record<string, string | number> = {},
  ): Promise<void> {
    await this.write(
      "INSERT INTO hosted_audit (at, install_id, action, detail) VALUES (?1, ?2, ?3, ?4)",
      [this.now(), id, action, canonicalJson(detail)],
    );
  }
}
