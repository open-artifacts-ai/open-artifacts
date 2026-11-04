// The synthetic database migration-timing.ts times new migrations against
// (#1213): the schema at the last release, filled to a fixed shape that
// resembles a large install. Migration 0021 took 278 s per 1M audit rows
// before its index fix (#1175); staging's small databases can't show that.
//
// SHAPE is the row count of each table at scale 1. A rule per table says how
// its rows look, with the value mixes the app's queries care about (user
// status and role, the audit log's action, target and reason, live and
// trashed artifacts, personal and shared spaces). Every table needs a rule:
// a table with none fails the seed, naming it, so the seeder grows with the
// schema. A rule for a table the schema doesn't have yet is skipped, and so
// is a key that isn't a column yet, so a rule can be written ahead of the
// migration that adds its table or column. A NOT NULL column with no default
// that the rule doesn't fill fails the seed, naming the table and column.
//
// Deterministic: a fixed PRNG seed, so the same schema seeds the same rows.
// No Node imports but node:sqlite: the timing CLI and the node test share it.
import type { DatabaseSync } from "node:sqlite";

// The server's @types/node (20.x) predates these parts of node:sqlite.
type SQLInputValue = null | number | bigint | string | Uint8Array;
/** DatabaseSync.close(), which the server's @types/node doesn't declare. */
export const closeDb = (d: DatabaseSync) =>
  (d as unknown as { close(): void }).close();

/** Row counts at scale 1 (the CI shape). */
export const SHAPE = {
  users: 100_000,
  spaces: 2_000, // shared spaces; each user's personal space comes from a trigger
  space_members: 60_000,
  group_mappings: 4_000,
  directory_groups: 1_000,
  directory_members: 50_000,
  directory_state: 10,
  org_group_mappings: 20,
  restricted_groups: 10,
  frozen_edits: 500,
  identities: 100_000,
  artifacts: 300_000,
  versions: 750_000, // 1 to 4 per artifact, 2.5 on average
  shares: 200_000,
  artifact_search: 300_000, // one per live artifact (rowid = the artifact's)
  reserved_artifacts: 1_000,
  uploads: 100_000,
  tokens: 30_000,
  agent_grants: 50_000,
  bus_machines: 20_000,
  bus_device_codes: 500,
  login_codes: 2_000,
  oauth_kv: 100_000,
  counters: 5_000,
  settings: 20,
  audit_events: 1_000_000,
} as const;

type Row = Record<string, SQLInputValue>;

/** State the rules share: ids already written, the PRNG, the clock. */
export interface Ctx {
  rand: () => number;
  /** Uniform integer in [0, n). */
  int: (n: number) => number;
  pick: <T>(xs: readonly T[]) => T;
  /** Picks a key of weights with probability proportional to its weight. */
  weighted: <K extends string>(w: Readonly<Record<K, number>>) => K;
  id: (prefix: string) => string;
  /** A time in the install's two-year life, in ms. */
  time: () => number;
  scale: number;
  count: (table: keyof typeof SHAPE) => number;
  users: { id: string; email: string; status: string; reason: string }[];
  /** The users that aren't active (filled on first use). */
  changed?: Ctx["users"];
  sharedSpaces: string[];
  artifacts: { id: string; owner: string; deleted: boolean }[];
  groups: { id: string; email: string }[];
}

export interface Rule {
  /** Rows to write; row(i) runs for i in [0, rows). */
  rows: (c: Ctx) => number;
  /** One row's values by column; null skips the row. `rowid` is allowed. */
  row: (i: number, c: Ctx) => Row | null;
}

const START = Date.UTC(2024, 10, 1);
const SPAN = 2 * 365 * 86_400_000;
const ROLES = ["viewer", "editor", "manager"] as const;
const FORMATS = ["html", "markdown", "code", "pdf", "image"] as const;
const WORDS =
  "plan report launch budget roadmap draft notes review design spec chart weekly metrics onboarding migration release audit summary sales hiring".split(
    " ",
  );
const words = (c: Ctx, n: number) =>
  Array.from({ length: n }, () => c.pick(WORDS)).join(" ");

/**
 * The audit log's mix (actions the app writes, roughly by how often). The
 * user.status rows that explain every removed or suspended user come on top,
 * written first (see audit_events).
 */
const AUDIT_ACTIONS = {
  "artifact.create": 20,
  "version.file": 18,
  "version.text": 10,
  "data.write": 12,
  "data.read": 6,
  "artifact.share": 8,
  "artifact.unshare": 2,
  "artifact.visibility": 3,
  "artifact.delete": 3,
  "artifact.undelete": 1,
  "artifact.purge": 2,
  "artifact.move": 1,
  "artifact.transfer": 1,
  "auth.signin": 6,
  "space.member.add": 2,
  "space.member.remove": 1,
  "space.member.role": 1,
  "user.status": 1,
  "user.role": 1,
  "directory.sync": 1,
} as const;

const TARGET: Record<string, string> = {
  auth: "user",
  user: "user",
  space: "space",
  directory: "directory",
};

/** A rule per table. Order matters: later rules read ids earlier ones wrote. */
export const RULES: Record<string, Rule> = {
  users: {
    rows: (c) => c.count("users"),
    row(i, c) {
      const id = c.id("u");
      const email = `user${i}@example${i % 7}.com`;
      const status =
        i === 0
          ? "active"
          : c.weighted({ active: 94, suspended: 3, removed: 3 });
      // Most removals come from directory sync (0021's backfill marks them).
      const reason =
        status === "active"
          ? ""
          : c.weighted({ directory_delete: 6, directory_suspend: 1, admin: 3 });
      c.users.push({ id, email, status, reason });
      const created = c.time();
      return {
        id,
        email,
        name: `User ${i}`,
        role:
          i === 0 ? "owner" : c.weighted({ admin: 1, member: 85, guest: 14 }),
        created_at: created,
        last_seen_at: c.rand() < 0.9 ? created + c.int(SPAN / 2) : null,
        display_name: c.rand() < 0.3 ? `Display ${i}` : null,
        session_epoch: c.int(3),
        status,
        restricted_manual: c.rand() < 0.01 ? 1 : 0,
        restricted_sync: c.rand() < 0.02 ? 1 : 0,
        guest_lapsed: c.rand() < 0.01 ? 1 : 0,
        status_changed_at: status === "active" ? null : created + c.int(SPAN),
        google_relink: 0,
        removed_by_sync:
          status === "removed" && reason.startsWith("directory_") ? 1 : 0,
      };
    },
  },
  spaces: {
    rows: (c) => c.count("spaces"),
    row(i, c) {
      const id = c.id("s");
      c.sharedSpaces.push(id);
      return {
        id,
        kind: "shared",
        name: `Space ${i} ${c.pick(WORDS)}`,
        owner_user_id: null,
        all_members_role: c.rand() < 0.3 ? c.pick(ROLES) : null,
        public_links: c.rand() < 0.5 ? 1 : 0,
        created_at: c.time(),
        deleted_at: c.rand() < 0.03 ? c.time() : null,
      };
    },
  },
  directory_groups: {
    rows: (c) => c.count("directory_groups"),
    row(i, c) {
      const g = { id: c.id("g"), email: `group${i}@example.com` };
      c.groups.push(g);
      return {
        group_id: g.id,
        email: g.email,
        parent_ids:
          i > 10 && c.rand() < 0.2 ? `["${c.groups[c.int(10)]?.id}"]` : "[]",
        gen: c.int(50),
      };
    },
  },
  directory_members: {
    rows: (c) => c.count("directory_members"),
    row(i, c) {
      const g = c.groups[i % c.groups.length];
      const u = c.users[(i * 7919) % c.users.length];
      if (!g || !u) return null;
      return { group_id: g.id, user_id: u.id, gen: c.int(50) };
    },
  },
  directory_state: {
    rows: (c) => Math.min(c.count("directory_state"), 10),
    row: (i, c) => ({ key: `state_${i}`, value: `{"gen":${c.int(50)}}` }),
  },
  space_members: {
    rows: (c) => c.count("space_members"),
    row(i, c) {
      const s = c.sharedSpaces[i % c.sharedSpaces.length];
      const u = c.users[(i * 104729) % c.users.length];
      if (!s || !u) return null;
      return {
        space_id: s,
        user_id: u.id,
        role: c.weighted({ viewer: 5, editor: 4, manager: 1 }),
        source: c.rand() < 0.4 ? "sync" : "manual",
        created_at: c.time(),
      };
    },
  },
  group_mappings: {
    rows: (c) =>
      Math.min(
        c.count("group_mappings"),
        c.sharedSpaces.length * c.groups.length,
      ),
    row(i, c) {
      // Distinct (space, group) pairs: the k-th lap over the spaces shifts
      // the group by k.
      const lap = Math.floor(i / c.sharedSpaces.length);
      const s = c.sharedSpaces[i % c.sharedSpaces.length];
      const g = c.groups[(i + lap) % c.groups.length];
      if (!s || !g) return null;
      return {
        space_id: s,
        group_id: g.id,
        group_email: g.email,
        role: c.pick(ROLES),
      };
    },
  },
  org_group_mappings: {
    rows: (c) => Math.min(c.count("org_group_mappings"), c.groups.length),
    row(i, c) {
      const g = c.groups[i];
      if (!g) return null;
      return { group_id: g.id, group_email: g.email, role: c.pick(ROLES) };
    },
  },
  restricted_groups: {
    rows: (c) => Math.min(c.count("restricted_groups"), c.groups.length),
    row(i, c) {
      const g = c.groups[c.groups.length - 1 - i];
      if (!g) return null;
      return { group_id: g.id, group_email: g.email, created_at: c.time() };
    },
  },
  frozen_edits: {
    rows: (c) => c.count("frozen_edits"),
    row(i, c) {
      const s = c.sharedSpaces[i % c.sharedSpaces.length];
      const u = c.users[(i * 15485863) % c.users.length];
      if (!s || !u) return null;
      const kind = c.weighted({ override: 6, delete: 2, manual: 2 });
      return {
        space_id: s,
        user_id: u.id,
        at: c.time(),
        manual_role: kind === "delete" ? null : c.pick(ROLES),
        kind,
      };
    },
  },
  identities: {
    rows: (c) => Math.min(c.count("identities"), c.users.length),
    row(i, c) {
      const u = c.users[i];
      if (!u) return null;
      return {
        provider: "google",
        subject: `${100_000_000_000 + i}`,
        tenant: `tenant${i % 3}`,
        user_id: u.id,
        created_at: c.time(),
        directory_bound: c.rand() < 0.6 ? 1 : 0,
      };
    },
  },
  artifacts: {
    rows: (c) => c.count("artifacts"),
    row(i, c) {
      // Owners skew: a tenth of the users own most artifacts.
      const owner =
        c.users[
          c.rand() < 0.7
            ? c.int(Math.ceil(c.users.length / 10))
            : c.int(c.users.length)
        ];
      if (!owner) return null;
      const id = c.id("a");
      const deleted = c.rand() < 0.05;
      c.artifacts.push({ id, owner: owner.id, deleted });
      const created = c.time();
      const shared = c.sharedSpaces.length > 0 && c.rand() < 0.15;
      return {
        id,
        owner_id: owner.id,
        title: `${words(c, 3)} ${i}`,
        description: c.rand() < 0.5 ? words(c, 8) : null,
        format: c.weighted({
          html: 6,
          markdown: 2,
          code: 1,
          pdf: 0.5,
          image: 0.5,
        }),
        visibility: c.weighted({ private: 6, team: 3, public: 1 }),
        current_version: 1 + (i % 4),
        capabilities: '{"db":false,"viewer":false,"storage":false}',
        allow_anonymous_writes: 0,
        has_thumbnail: c.rand() < 0.8 ? 1 : 0,
        last_agent_name: c.rand() < 0.7 ? "claude-code" : null,
        last_agent_version: c.rand() < 0.7 ? "2.1.0" : null,
        created_at: created,
        updated_at: created + c.int(SPAN / 4),
        deleted_at: deleted ? created + c.int(SPAN / 4) : null,
        purge_attempts: 0,
        purge_after: null,
        thumbnail_version: c.rand() < 0.8 ? 1 + (i % 4) : null,
        space_id: shared ? c.pick(c.sharedSpaces) : owner.id,
        data_writers: c.rand() < 0.9 ? "viewers" : "editors",
      };
    },
  },
  versions: {
    // 1 to 4 versions per artifact (i % 4 + 1), matching current_version.
    rows: (c) => c.artifacts.length * 4,
    row(i, c) {
      const a = c.artifacts[Math.floor(i / 4)];
      const v = (i % 4) + 1;
      if (!a || v > (Math.floor(i / 4) % 4) + 1) return null;
      return {
        artifact_id: a.id,
        version: v,
        entry: "index.html",
        manifest: '[{"path":"index.html","size":4096}]',
        language: null,
        message: c.rand() < 0.5 ? words(c, 4) : null,
        agent_name: "claude-code",
        agent_version: "2.1.0",
        created_by: a.owner,
        created_at: c.time(),
        text_indexed: 1,
        format: c.pick(FORMATS),
        agent_via: c.rand() < 0.5 ? "mcp" : null,
        index_failed: 0,
        thumb_failed: 0,
      };
    },
  },
  shares: {
    rows: (c) => c.count("shares"),
    row(i, c) {
      const a = c.artifacts[(i * 7) % c.artifacts.length];
      if (!a) return null;
      // Mostly members' addresses, some outside guests.
      const u = c.users[(i * 48271) % c.users.length];
      return {
        artifact_id: a.id,
        email: c.rand() < 0.8 && u ? u.email : `ext${i}@outside${i % 13}.org`,
        role: c.rand() < 0.7 ? "viewer" : "editor",
        created_by: a.owner,
        created_at: c.time(),
      };
    },
  },
  artifact_search: {
    rows: (c) => c.artifacts.length,
    row(i, c) {
      const a = c.artifacts[i];
      if (!a || a.deleted) return null;
      return {
        rowid: i + 1,
        artifact_id: a.id,
        title: words(c, 3),
        description: words(c, 8),
        body: words(c, 60),
      };
    },
  },
  reserved_artifacts: {
    rows: (c) => c.count("reserved_artifacts"),
    row(i, c) {
      const u = c.users[i % c.users.length];
      if (!u) return null;
      return { id: c.id("a"), user_id: u.id, created_at: c.time() };
    },
  },
  uploads: {
    rows: (c) => c.count("uploads"),
    row(i, c) {
      const a = c.artifacts[i % c.artifacts.length];
      if (!a) return null;
      const id = c.id("up");
      return {
        id,
        artifact_id: a.id,
        user_id: a.owner,
        r2_key: `uploads/${id}`,
        size: 1024 + c.int(5_000_000),
        content_type: c.pick(["text/html", "image/png", "application/pdf"]),
        path: c.pick(["index.html", "img/a.png", "doc.pdf"]),
        created_at: c.time(),
        consumed: c.rand() < 0.95 ? 1 : 0,
        received_at: c.rand() < 0.97 ? c.time() : null,
      };
    },
  },
  tokens: {
    rows: (c) => c.count("tokens"),
    row(i, c) {
      const u = c.users[(i * 3) % c.users.length];
      if (!u) return null;
      return {
        id: c.id("t"),
        user_id: u.id,
        label: `token ${i}`,
        token_hash: `${c.id("h")}${i}`,
        created_at: c.time(),
        last_used_at: c.rand() < 0.7 ? c.time() : null,
        revoked_at: c.rand() < 0.2 ? c.time() : null,
        versions_published: c.int(500),
      };
    },
  },
  // #1291: approved bus machines (token hashes only) and pending device codes.
  bus_machines: {
    rows: (c) => c.count("bus_machines"),
    row(i, c) {
      const u = c.users[(i * 7) % c.users.length];
      if (!u) return null;
      return {
        id: c.id("bm"),
        user_id: u.id,
        label: `machine ${i}`,
        token_hash: `${c.id("bh")}${i}`,
        created_at: c.time(),
        last_used_at: c.rand() < 0.7 ? c.time() : null,
        revoked_at: c.rand() < 0.2 ? c.time() : null,
      };
    },
  },
  bus_device_codes: {
    rows: (c) => c.count("bus_device_codes"),
    row(i, c) {
      const u = c.users[(i * 11) % c.users.length];
      const approved = c.rand() < 0.5;
      return {
        id: c.id("dc"),
        device_code_hash: `${c.id("dh")}${i}`,
        user_code: `${c.id("uc")}${i}`,
        label: `machine ${i}`,
        ip_tag: c.id("ip"),
        created_at: c.time(),
        expires_at: c.time(),
        last_poll_at: c.rand() < 0.5 ? c.time() : null,
        user_id: approved && u ? u.id : null,
        approved_at: approved ? c.time() : null,
        denied_at: null,
      };
    },
  },
  agent_grants: {
    rows: (c) => c.count("agent_grants"),
    row(i, c) {
      const u = c.users[(i * 5) % c.users.length];
      if (!u) return null;
      return {
        grant_id: c.id("gr"),
        user_id: u.id,
        label: c.rand() < 0.5 ? "Claude Code" : null,
        last_used_at: c.rand() < 0.8 ? c.time() : null,
        client_version: "2.1.0",
        versions_published: c.int(500),
      };
    },
  },
  login_codes: {
    rows: (c) => c.count("login_codes"),
    row(i, c) {
      const at = c.time();
      return {
        email_key: `k${i % 1000}`,
        request_id: c.id("r"),
        code_hash: c.id("h"),
        expires_at: at + 600_000,
        attempts: c.int(3),
        created_at: at,
      };
    },
  },
  oauth_kv: {
    rows: (c) => c.count("oauth_kv"),
    row(i, c) {
      const kind = c.pick(["grant", "token", "client"]);
      return {
        key: `${kind}:${c.id("k")}${i}`,
        value: `{"kind":"${kind}","data":"${c.id("v")}"}`,
        expires_at: kind === "client" ? null : c.time(),
        metadata: kind === "grant" ? '{"label":"Claude Code"}' : null,
      };
    },
  },
  counters: {
    rows: (c) => c.count("counters"),
    row: (i, c) => ({
      key: `rate:${i}`,
      n: c.int(1000),
      day: `2026-${String(1 + (i % 12)).padStart(2, "0")}-01`,
    }),
  },
  settings: {
    rows: (c) => Math.min(c.count("settings"), 20),
    row: (i) => ({ key: `setting_${i}`, value: '{"on":true}' }),
  },
  audit_events: {
    // First a user.status row for every removed or suspended user (its
    // latest, which is what 0021's backfill reads), then the general mix.
    rows: (c) => c.count("audit_events"),
    row(i, c) {
      c.changed ??= c.users.filter((u) => u.status !== "active");
      const changed = c.changed;
      const at = START + Math.floor((SPAN * i) / c.count("audit_events"));
      const actor = c.users[c.int(Math.ceil(c.users.length / 50))];
      const base = {
        id: c.id("ev"),
        at,
        actor_kind: "user",
        actor_id: actor?.id ?? null,
        space_id: null,
        actor_cred_kind: c.rand() < 0.5 ? "session" : "token",
        actor_cred_id: null,
      };
      // The changed users' rows go at the end of the log (the latest).
      const tail = c.count("audit_events") - changed.length;
      if (i >= tail) {
        const u = changed[i - tail];
        if (u) {
          return {
            ...base,
            action: "user.status",
            target_type: "user",
            target_id: u.id,
            detail: JSON.stringify({ status: u.status, reason: u.reason }),
          };
        }
      }
      const action = c.weighted(AUDIT_ACTIONS);
      const target = TARGET[action.split(".")[0] ?? ""] ?? "artifact";
      const targetId =
        target === "user"
          ? c.pick(c.users).id
          : target === "space"
            ? c.sharedSpaces.length
              ? c.pick(c.sharedSpaces)
              : null
            : target === "directory"
              ? null
              : c.artifacts.length
                ? c.pick(c.artifacts).id
                : null;
      const detail =
        action === "user.status"
          ? JSON.stringify({ status: "active", reason: "admin" })
          : action.startsWith("version.")
            ? JSON.stringify({ version: 1 + c.int(4), bytes: c.int(100_000) })
            : "{}";
      return {
        ...base,
        action,
        target_type: target,
        target_id: targetId,
        detail,
      };
    },
  },
};

/** Tables the seeder doesn't own: SQLite's, D1's and FTS shadow tables. */
export function seedableTables(db: DatabaseSync): string[] {
  const rows = db
    .prepare(
      "select name, sql from sqlite_master where type = 'table' order by name",
    )
    .all() as { name: string; sql: string | null }[];
  const virtual = rows
    .filter((r) => /^create virtual table/i.test(r.sql ?? ""))
    .map((r) => r.name);
  return rows
    .map((r) => r.name)
    .filter(
      (n) =>
        !n.startsWith("sqlite_") &&
        !n.startsWith("_cf_") &&
        n !== "d1_migrations" &&
        !virtual.some((v) => n.startsWith(`${v}_`)),
    );
}

/** Tables with no seed rule; empty when the seeder covers the schema. */
export function missingRules(
  db: DatabaseSync,
  rules: Record<string, Rule> = RULES,
): string[] {
  return seedableTables(db).filter((t) => !(t in rules));
}

/** Mulberry32: small, fast, deterministic. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function context(scale: number): Ctx {
  const rand = prng(1213);
  const int = (n: number) => Math.floor(rand() * n);
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  return {
    rand,
    int,
    pick: <T>(xs: readonly T[]) => xs[int(xs.length)] as T,
    weighted<K extends string>(w: Readonly<Record<K, number>>): K {
      const entries = Object.entries(w) as [K, number][];
      let r = rand() * entries.reduce((s, [, n]) => s + n, 0);
      for (const [k, n] of entries) {
        r -= n;
        if (r < 0) return k;
      }
      return (entries[entries.length - 1] as [K, number])[0];
    },
    id(prefix: string) {
      let s = `${prefix}_`;
      for (let i = 0; i < 16; i++) s += alphabet[int(36)];
      return s;
    },
    time: () => START + int(SPAN),
    scale,
    count: (t) => Math.max(1, Math.round(SHAPE[t] * scale)),
    users: [],
    sharedSpaces: [],
    artifacts: [],
    groups: [],
  };
}

export interface SeedResult {
  /** Rows written per table (trigger rows not included). */
  rows: Record<string, number>;
  ms: number;
}

/**
 * Fills every seedable table of `db` (already migrated) by RULES. Throws,
 * naming the table, when a table has no rule, and naming the column when a
 * rule leaves a required column empty.
 */
export function seed(
  db: DatabaseSync,
  opts: { scale?: number; rules?: Record<string, Rule> } = {},
): SeedResult {
  const rules = opts.rules ?? RULES;
  const missing = missingRules(db, rules);
  if (missing.length > 0) {
    throw new Error(
      `no seed rule for table(s): ${missing.join(", ")}. Add a rule to RULES in apps/server/scripts/migration-seed.ts`,
    );
  }
  const tables = new Set(seedableTables(db));
  const c = context(opts.scale ?? 1);
  const out: Record<string, number> = {};
  const t0 = performance.now();
  for (const [table, rule] of Object.entries(rules)) {
    if (!tables.has(table)) continue; // a rule ahead of its migration
    const info = db.prepare(`pragma table_info(\`${table}\`)`).all() as {
      name: string;
      notnull: number;
      dflt_value: unknown;
    }[];
    const cols = new Set(info.map((r) => r.name));
    const n = rule.rows(c);
    let stmt: ReturnType<DatabaseSync["prepare"]> | undefined;
    let keys: string[] = [];
    let written = 0;
    db.exec("begin");
    try {
      for (let i = 0; i < n; i++) {
        const row = rule.row(i, c);
        if (!row) continue;
        if (!stmt) {
          keys = Object.keys(row).filter((k) => k === "rowid" || cols.has(k));
          for (const col of info) {
            if (
              col.notnull &&
              col.dflt_value === null &&
              !keys.includes(col.name)
            ) {
              throw new Error(
                `seed rule for ${table} leaves required column ${col.name} empty`,
              );
            }
          }
          stmt = db.prepare(
            `insert into \`${table}\` (${keys.map((k) => `\`${k}\``).join(", ")}) values (${keys.map(() => "?").join(", ")})`,
          );
        }
        stmt.run(...keys.map((k) => row[k] ?? null));
        written++;
      }
      db.exec("commit");
    } catch (e) {
      db.exec("rollback");
      throw e;
    }
    out[table] = written;
  }
  return { rows: out, ms: performance.now() - t0 };
}
