// prod-inspect.sh: prod's platform D1 schema, read-only. It resolves
// oa-p-platform by exact name, then runs only its two fixed statements; any
// error fails closed. curl is a stub; the token reaches it on stdin only.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sandbox, script } from "./stubs.ts";

const TOK = "cfut_TOKEN_never_printed_0123456789";
const ACCT = "26ac346086d4405f7a976d48747a2a75";
const UUID = "0d6a2a8e-1c2b-4c3d-8e4f-5a6b7c8d9e0f";
const SCHEMA_SQL =
  "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name";
const MIGRATIONS_SQL =
  "SELECT id, name, applied_at FROM d1_migrations ORDER BY id";

const ok = (result: unknown, info?: Record<string, unknown>) =>
  JSON.stringify({
    success: true,
    errors: [],
    result,
    ...(info ? { result_info: info } : {}),
  });
const rows = (results: unknown[]) => ok([{ results, success: true, meta: {} }]);

// $STATE/d1-<page> answers the listing; $STATE/q-<n> the nth POST, whose
// --data-binary body goes to $STATE/posts, one per line.
const curl = `cfg="$(cat)"
case "$cfg" in *"$TOK_EXPECT"*) ;; *) echo '{"success":false,"errors":[{"message":"bad token"}]}'; exit 0 ;; esac
url="\${@: -1}"; path="\${url#https://api.cloudflare.com/client/v4}"
data=""; prev=""
for a in "$@"; do [ "$prev" = --data-binary ] && data="$a"; prev="$a"; done
case "$path" in
  "/accounts/$STUB_ACCT/d1/database?name=oa-p-platform&per_page=100&page="*)
    f="$STATE/d1-\${path##*page=}" ;;
  "/accounts/$STUB_ACCT/d1/database/$STUB_UUID/query")
    printf '%s\\n' "$data" >> "$STATE/posts"
    n=$(wc -l < "$STATE/posts" | tr -d ' ')
    f="$STATE/q-$n" ;;
  *) echo "UNEXPECTED $path" >> "$STUB_LOG"; echo '{"success":false}'; exit 0 ;;
esac
[ -f "$f" ] || { echo '{"success":false,"errors":[{"message":"no fixture"}]}'; exit 0; }
[ "$(cat "$f")" = NETERR ] && { echo "curl: (6) Could not resolve host" >&2; exit 6; }
cat "$f"`;

const SCHEMA = [
  {
    type: "index",
    name: "installs_revoke_pending",
    tbl_name: "installs",
    sql: "CREATE INDEX installs_revoke_pending ON installs(id)",
  },
  {
    type: "table",
    name: "d1_migrations",
    tbl_name: "d1_migrations",
    sql: "CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)",
  },
  {
    type: "table",
    name: "installs",
    tbl_name: "installs",
    sql: "CREATE TABLE installs(id TEXT PRIMARY KEY)",
  },
];
const MIGS = [
  { id: 1, name: "0001_installs.sql", applied_at: "2026-10-20 10:00:00" },
  { id: 2, name: "0002_release_floor.sql", applied_at: "2026-10-21 10:00:00" },
];
const DB = [
  { uuid: UUID, name: "oa-p-platform" },
  { uuid: "11111111-1111-4111-8111-111111111111", name: "oa-p-platform-old" },
];

const run = (
  d1: string[],
  queries: string[],
  env: Record<string, string> = {},
) => {
  const sb = sandbox({ curl });
  for (const [i, p] of d1.entries())
    writeFileSync(join(sb.dir, `d1-${i + 1}`), p);
  for (const [i, p] of queries.entries())
    writeFileSync(join(sb.dir, `q-${i + 1}`), p);
  const r = sb.run(["bash", script("prod-inspect.sh")], {
    env: {
      STATE: sb.dir,
      CLOUDFLARE_API_TOKEN: TOK,
      TOK_EXPECT: TOK,
      CLOUDFLARE_ACCOUNT_ID: ACCT,
      STUB_ACCT: ACCT,
      STUB_UUID: UUID,
      ...env,
    },
  });
  const log = sb.log();
  const all = [r.out, r.err, ...log].join("\n");
  expect(all).not.toContain(TOK);
  expect(log.filter((l) => l.startsWith("UNEXPECTED"))).toEqual([]);
  const postsFile = join(sb.dir, "posts");
  const posts = existsSync(postsFile)
    ? readFileSync(postsFile, "utf8").split("\n").filter(Boolean)
    : [];
  return { ...r, log, posts };
};
const body = (sql: string) => JSON.stringify({ sql });

describe("prod-inspect.sh", () => {
  it("prints the DDL and the migrations, one object per line", () => {
    const r = run([ok(DB)], [rows(SCHEMA), rows(MIGS)]);
    expect(r.code).toBe(0);
    expect(r.out.split("\n")).toEqual([
      `oa-p-platform (${UUID})`,
      "sqlite_master:",
      ...SCHEMA.map((s) => JSON.stringify(s)),
      "d1_migrations:",
      ...MIGS.map((m) => JSON.stringify(m)),
      "",
    ]);
    expect(r.posts).toEqual([body(SCHEMA_SQL), body(MIGRATIONS_SQL)]);
  });

  it("says d1_migrations is absent when sqlite_master has no such table", () => {
    // An index or view named d1_migrations is not the table.
    const schema = [
      ...SCHEMA.filter((s) => s.name !== "d1_migrations"),
      { type: "view", name: "d1_migrations", tbl_name: "x", sql: "v" },
    ];
    const r = run([ok(DB)], [rows(schema)]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("d1_migrations: absent\n");
    expect(r.posts).toEqual([body(SCHEMA_SQL)]);
  });

  it("pages through the listing for the one exact match", () => {
    const r = run(
      [
        ok([{ uuid: "1".repeat(8), name: "oa-p-platform-2" }], {
          total_pages: 2,
        }),
        ok(DB, { total_pages: 2 }),
      ],
      [rows(SCHEMA), rows(MIGS)],
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain(`(${UUID})`);
  });

  it.each([
    ["zero", [DB[1]], "0 found"],
    ["two", [...DB, { uuid: UUID, name: "oa-p-platform" }], "2 found"],
  ])("fails on %s matches and queries nothing", (_, list, msg) => {
    const r = run([ok(list)], [rows(SCHEMA)]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(msg);
    expect(r.posts).toEqual([]);
    expect(r.out).toBe("");
  });

  it.each([
    [
      "a listing error",
      [JSON.stringify({ success: false, errors: [{ code: 10000, m: "x" }] })],
      [],
      "list D1 databases",
    ],
    ["a network error", ["NETERR"], [], "network error"],
    ["an unparsable listing", ["<html>"], [], "unparsable response"],
    [
      "a query error",
      [ok(DB)],
      [JSON.stringify({ success: false, errors: [{ code: 7500 }] })],
      "read sqlite_master failed",
    ],
    ["an unparsable query", [ok(DB)], ["nope"], "unparsable response"],
    [
      "a failed statement",
      [ok(DB)],
      [ok([{ results: [], success: false }])],
      "unexpected response shape",
    ],
    [
      "a migrations error",
      [ok(DB)],
      [rows(SCHEMA), JSON.stringify({ success: false, errors: [] })],
      "read d1_migrations failed",
    ],
  ])("fails closed on %s", (_, d1, q, msg) => {
    const r = run(d1 as string[], q as string[]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(msg);
    expect(r.out).toBe("");
  });

  it("takes no arguments", () => {
    const sb = sandbox({ curl });
    const r = sb.run(["bash", script("prod-inspect.sh"), "SELECT 1"], {
      env: { CLOUDFLARE_API_TOKEN: TOK, CLOUDFLARE_ACCOUNT_ID: ACCT },
    });
    expect(r.code).toBe(2);
    expect(sb.log()).toEqual([]);
  });

  it("sends the token on stdin only, never in argv", () => {
    const r = run([ok(DB)], [rows(SCHEMA), rows(MIGS)]);
    const curls = r.log.filter((l) => l.startsWith("curl "));
    expect(curls).toHaveLength(3);
    for (const l of curls) {
      expect(l).toContain("-K -");
      expect(l).not.toContain(TOK);
      expect(l).not.toContain("Authorization");
    }
  });

  describe("allow_sql", () => {
    const check = (...args: string[]) =>
      sandbox({}).run(
        [
          "bash",
          "-c",
          `. "$0"; allow_sql "$@"`,
          script("prod-inspect.sh"),
          ...args,
        ],
        { env: { PROD_INSPECT_LIB: "1" } },
      );
    it("allows exactly the two statements", () => {
      expect(check(SCHEMA_SQL).code).toBe(0);
      expect(check(MIGRATIONS_SQL).code).toBe(0);
    });
    it.each([
      "SELECT COUNT(*) FROM installs",
      "SELECT * FROM installs",
      `${SCHEMA_SQL};`,
      ` ${SCHEMA_SQL}`,
      `${SCHEMA_SQL}; DELETE FROM installs`,
      SCHEMA_SQL.toLowerCase(),
      "",
    ])("refuses %j", (sql) => {
      const r = check(sql);
      expect(r.code).toBe(1);
      expect(r.err).toContain("refused");
    });
    it("refuses no statement or two", () => {
      expect(check().code).toBe(1);
      expect(check(SCHEMA_SQL, MIGRATIONS_SQL).code).toBe(1);
    });
  });
});
