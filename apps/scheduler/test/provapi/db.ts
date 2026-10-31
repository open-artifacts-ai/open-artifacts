// Platform D1 rows for the provapi tests (local D1, every platform-db
// migration applied). Defaults follow packages/provision/test/platform-db.ts.
import { applyD1Migrations } from "cloudflare:test";
import { env as testEnv } from "cloudflare:workers";
import type { D1Migration } from "@cloudflare/vitest-plugin";

export const db = (testEnv as unknown as { PLATFORM_DB: D1Database })
  .PLATFORM_DB;

export async function migrate(): Promise<void> {
  const m = (testEnv as unknown as { TEST_MIGRATIONS: D1Migration[] })
    .TEST_MIGRATIONS;
  await applyD1Migrations(db, m);
}

const TABLES = [
  "platform_state",
  "jobs",
  "install_lifecycle",
  "signups",
  "signup_secret",
  "audit_refusals",
  "sessions",
  "agent_tokens",
  "oauth_clients",
  "rate_counters",
  "signup_accounts",
  "prodclean_reports",
  "install_versions",
  "hosts",
  "installs",
];

/** Empties every table the tests write; admin_audit is append-only, so never. */
export async function reset(): Promise<void> {
  await db.batch(TABLES.map((t) => db.prepare(`DELETE FROM ${t}`)));
}

export type Row = Record<string, string | number | null>;

export async function insert(table: string, row: Row): Promise<void> {
  const cols = Object.keys(row);
  await db
    .prepare(
      `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map((_, i) => `?${i + 1}`).join(", ")})`,
    )
    .bind(...cols.map((c) => row[c] ?? null))
    .run();
}

let seq = 0;
const next = () => ++seq;

/** "i" + 11 chars, distinct per call. */
export const installId = (n = next()) => `i${n.toString(36).padStart(11, "0")}`;

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** A valid ULID, distinct per call. */
export function jobId(n = next()): string {
  let s = "";
  for (let v = n; s.length < 26; v = Math.floor(v / 32))
    s = CROCKFORD[v % 32] + s;
  return `0${s.slice(1)}`;
}

/** An installs row (0001 columns), active by default. */
export async function install(id: string, over: Row = {}): Promise<Row> {
  const n = next();
  const row = {
    id,
    slug: `s${n}`,
    app_host: `s${n}.app.test`,
    content_host: `s${n}.content.test`,
    owner_email: `owner${n}@customer.test`,
    rl_ns: 8 * n,
    inputs_hash: "h",
    state: "active",
    created_at: 1,
    updated_at: 1,
    ...over,
  };
  await insert("installs", row);
  return row;
}

export async function lifecycle(id: string, over: Row = {}): Promise<void> {
  await insert("install_lifecycle", {
    install_id: id,
    source: "admin",
    created_at: 1,
    updated_at: 1,
    ...over,
  });
}

export async function job(installId: string, over: Row = {}): Promise<string> {
  const id = (over.id as string | undefined) ?? jobId();
  await insert("jobs", {
    id,
    kind: "create",
    workflow: "provision_install",
    install_id: installId,
    actor_kind: "admin",
    actor_key: "admin:a",
    actor_label: "a",
    request_id: `req-${id}`,
    body_hash: "h",
    args: "{}",
    status: "queued",
    created_at: 1,
    updated_at: 1,
    ...over,
  });
  return id;
}

export async function signup(over: Row = {}): Promise<string> {
  const id = jobId();
  await insert("signups", {
    signup_id: id,
    source: "admin",
    slug: `sg${id.slice(-8).toLowerCase()}`,
    job_id: id,
    vars: "{}",
    status: "pending",
    created_at: 1,
    updated_at: 1,
    ...over,
  });
  return id;
}

export async function rows(sql: string, ...bind: unknown[]): Promise<Row[]> {
  return (
    await db
      .prepare(sql)
      .bind(...bind)
      .all<Row>()
  ).results;
}

/** Every log line, captured; console is restored by vi.restoreAllMocks. */
export function captureLogs(
  spyOn: (o: Console, k: "log" | "warn" | "error") => {
    mockImplementation(f: (...a: unknown[]) => void): unknown;
  },
): string[] {
  const lines: string[] = [];
  const rec = (...a: unknown[]) => {
    lines.push(a.map(String).join(" "));
  };
  for (const k of ["log", "warn", "error"] as const)
    spyOn(console, k).mockImplementation(rec);
  return lines;
}
