// MIG-2 (#1137): a migration that can lose data needs a person. prod's guard
// (scripts/ci/prod-migration-guard.sh) trusts the first-line marker; here a
// forgotten marker holds too. A false positive costs one manual upgrade, and
// a miss costs data, so this reads broadly.

export const NON_ADDITIVE_MARK = "-- oa:non-additive";

/** Comments and quoted strings gone, so only real SQL is read. */
function stripped(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i] as string;
    const two = sql.slice(i, i + 2);
    if (two === "--") {
      const n = sql.indexOf("\n", i);
      i = n < 0 ? sql.length : n;
    } else if (two === "/*") {
      const n = sql.indexOf("*/", i + 2);
      i = n < 0 ? sql.length : n + 2;
    } else if (c === "'") {
      // '' inside a string is an escaped quote: two strings in a row here.
      const n = sql.indexOf("'", i + 1);
      i = n < 0 ? sql.length : n + 1;
      out += "''";
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const RULES: readonly (readonly [string, RegExp])[] = Object.freeze([
  ["drop_table", /\bDROP\s+TABLE\b/i],
  ["drop_column", /\bALTER\s+TABLE\b[\s\S]*\bDROP\b/i],
  ["rename", /\bRENAME\b/i],
]);

/** Why this file can lose data, or null when it can't. */
export function nonAdditiveReason(sql: string): string | null {
  if (sql.split("\n", 1)[0]?.trimEnd() === NON_ADDITIVE_MARK) return "marker";
  for (const statement of stripped(sql).split(";")) {
    for (const [why, re] of RULES) if (re.test(statement)) return why;
    const s = statement.trim();
    if (/^DELETE\s+FROM\b/i.test(s) && !/\bWHERE\b/i.test(s))
      return "delete_all";
    if (/^UPDATE\b/i.test(s) && !/\bWHERE\b/i.test(s)) return "update_all";
  }
  return null;
}
