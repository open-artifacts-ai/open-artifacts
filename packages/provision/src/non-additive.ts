// MIG-2 (#1137): a migration that can lose data needs a person. prod's guard
// (scripts/ci/prod-migration-guard.sh) trusts the first-line marker; here a
// forgotten marker holds too. This is an allowlist over real tokens: a
// statement passes only in a form known to keep data, and anything else,
// unreadable SQL included, is held. A false hold costs one manual upgrade, and
// a miss costs data.

export const NON_ADDITIVE_MARK = "-- oa:non-additive";

type Token =
  | { t: "word"; v: string }
  /** A quoted name: never a keyword. */
  | { t: "name"; v: string }
  /** A string. */
  | { t: "lit" }
  | { t: "punct"; v: string };

/** Comments dropped, quoted things one token each; null when it doesn't end. */
function tokens(sql: string): Token[] | null {
  const out: Token[] = [];
  let i = 0;
  // A doubled quote inside reads as two strings in a row: the same tokens.
  const quoted = (close: string): boolean => {
    const n = sql.indexOf(close, i + 1);
    if (n < 0) return false;
    i = n + 1;
    return true;
  };
  while (i < sql.length) {
    const c = sql[i] as string;
    const two = sql.slice(i, i + 2);
    if (/\s/.test(c)) i++;
    else if (two === "--") {
      const n = sql.indexOf("\n", i);
      i = n < 0 ? sql.length : n;
    } else if (two === "/*") {
      const n = sql.indexOf("*/", i + 2);
      if (n < 0) return null;
      i = n + 2;
    } else if (c === "'" || c === '"' || c === "`") {
      const at = i;
      if (!quoted(c)) return null;
      out.push(
        c === "'"
          ? { t: "lit" }
          : { t: "name", v: sql.slice(at + 1, i - 1).toUpperCase() },
      );
    } else if (c === "[") {
      const at = i;
      if (!quoted("]")) return null;
      out.push({ t: "name", v: sql.slice(at + 1, i - 1).toUpperCase() });
    } else {
      const w = /^[\p{L}\p{N}_$]+/u.exec(sql.slice(i))?.[0];
      if (w) {
        out.push({ t: "word", v: w.toUpperCase() });
        i += w.length;
      } else {
        out.push({ t: "punct", v: c });
        i++;
      }
    }
  }
  return out;
}

const word = (x: Token | undefined) => (x?.t === "word" ? x.v : "");

/** The index just past this statement's end; a trigger ends at its END. */
function statementEnd(ts: readonly Token[], from: number): number {
  const second = word(ts[from + 1]);
  const trigger =
    word(ts[from]) === "CREATE" &&
    (second === "TRIGGER" ||
      ((second === "TEMP" || second === "TEMPORARY") &&
        word(ts[from + 2]) === "TRIGGER"));
  let depth = 0;
  let body = false;
  let cases = 0;
  for (let i = from; i < ts.length; i++) {
    const x = ts[i] as Token;
    if (x.t === "punct" && x.v === "(") depth++;
    else if (x.t === "punct" && x.v === ")") depth--;
    else if (trigger && word(x) === "BEGIN") body = true;
    else if (body && word(x) === "CASE") cases++;
    else if (body && word(x) === "END") {
      if (cases === 0) return i + 1;
      cases--;
    } else if (x.t === "punct" && x.v === ";" && depth === 0 && !body)
      return i + 1;
  }
  return ts.length;
}

/** The statements, without their `;`. */
function statements(ts: readonly Token[]): Token[][] {
  const out: Token[][] = [];
  for (let i = 0; i < ts.length; ) {
    const end = statementEnd(ts, i);
    const s = ts.slice(i, end).filter((x, k, a) => {
      return !(k === a.length - 1 && x.t === "punct" && x.v === ";");
    });
    if (s.length > 0) out.push(s);
    i = end;
  }
  return out;
}

const isPunct = (x: Token | undefined, v: string) =>
  x?.t === "punct" && x.v === v;

/** The tokens split on these words, outside every parenthesis. */
function splitTop(s: readonly Token[], words: readonly string[]): Token[][] {
  const out: Token[][] = [[]];
  let depth = 0;
  for (const x of s) {
    if (isPunct(x, "(")) depth++;
    else if (isPunct(x, ")")) depth--;
    if (depth === 0 && words.includes(word(x))) out.push([]);
    else out.at(-1)?.push(x);
  }
  return out;
}

const NOT_A_COLUMN =
  /^(\d.*|NULL|TRUE|FALSE|NOT|CASE|EXISTS|SELECT|CURRENT_TIME|CURRENT_DATE|CURRENT_TIMESTAMP)$/;

/** A column reference at the start of `c`: its name and length, else null. */
function columnAt(c: readonly Token[]): { name: string; len: number } | null {
  const one = (x: Token | undefined) =>
    x?.t === "name" || (x?.t === "word" && !NOT_A_COLUMN.test(x.v))
      ? x.v
      : null;
  const a = one(c[0]);
  if (a === null) return null;
  if (!isPunct(c[1], ".")) return { name: a, len: 1 };
  const b = one(c[2]);
  return b === null ? null : { name: b, len: 3 };
}

const COMPARISONS = ["=", "<", ">", "!"];
const WORD_COMPARISONS = ["IS", "IN", "LIKE", "GLOB", "BETWEEN"];

/** `column op value`, where the value isn't that same column. */
function comparesColumn(c: readonly Token[]): boolean {
  const col = columnAt(c);
  if (!col) return false;
  let i = col.len;
  if (word(c[i]) === "NOT") i++;
  const op = c[i];
  const compares =
    (op?.t === "punct" && COMPARISONS.includes(op.v)) ||
    WORD_COMPARISONS.includes(word(op));
  if (!compares) return false;
  const rhs = c.slice(i + 1).filter((x) => x.t !== "punct" || x.v !== "=");
  if (rhs.length === 0) return false;
  // new.id and old.id, in a trigger, are another row's: anything else named
  // like the column may be the column.
  return !rhs.some((x, k) => {
    const same = (x.t === "word" || x.t === "name") && x.v === col.name;
    const row = /^(NEW|OLD)$/.test(word(rhs[k - 2]));
    return same && !(isPunct(rhs[k - 1], ".") && row);
  });
}

/**
 * A WHERE that really narrows: outside every parenthesis, no OR, and at least
 * one AND term compares a real column. Anything else holds, so a clause that's
 * always true can't pass, whatever form it takes.
 */
function narrowed(s: readonly Token[]): boolean {
  const [, ...where] = splitTop(s, ["WHERE"]);
  if (where.length !== 1) return false;
  const [clause] = splitTop(where[0] as Token[], [
    "RETURNING",
    "ORDER",
    "LIMIT",
  ]);
  const c = clause as Token[];
  if (splitTop(c, ["OR"]).length > 1) return false;
  return splitTop(c, ["AND"]).some(comparesColumn);
}

const has = (s: readonly Token[], ...seq: string[]) =>
  s.some((_, i) => seq.every((w, k) => word(s[i + k]) === w));

/** Why this statement can lose data, or null when its form keeps data. */
function statementRisk(s: readonly Token[]): string | null {
  const [a, b] = [word(s[0]), word(s[1])];
  switch (a) {
    case "SELECT":
      return null;
    case "CREATE": {
      if (b === "TABLE" || b === "INDEX" || b === "VIEW") return null;
      if (b === "VIRTUAL" && word(s[2]) === "TABLE") return null;
      if (b === "UNIQUE" && word(s[2]) === "INDEX") return null;
      if (b !== "TRIGGER") return "unknown";
      const at = s.findIndex((x) => word(x) === "BEGIN");
      if (at < 0 || word(s.at(-1)) !== "END") return "unknown";
      for (const body of statements(s.slice(at + 1, -1))) {
        const why = statementRisk(body);
        if (why) return `trigger_${why}`;
      }
      return null;
    }
    case "DROP":
      if (b === "INDEX") return null;
      return b === "TABLE" ? "drop_table" : "unknown";
    case "ALTER": {
      if (b !== "TABLE") return "unknown";
      if (has(s, "RENAME")) return "rename";
      if (has(s, "DROP")) return "drop_column";
      return has(s, "ADD") ? null : "unknown";
    }
    case "REPLACE":
      return "replace";
    case "INSERT":
      if (has(s, "DO", "UPDATE")) return "upsert";
      if (b === "INTO" || (b === "OR" && word(s[2]) === "IGNORE")) return null;
      return b === "OR" ? "replace" : "unknown";
    case "UPDATE":
      if (b === "OR") return "replace";
      return narrowed(s) ? null : "update_all";
    case "DELETE":
      return narrowed(s) ? null : "delete_all";
    default:
      return "unknown";
  }
}

/** Why this file can lose data, or null when it can't. */
export function nonAdditiveReason(sql: string): string | null {
  if (sql.split("\n", 1)[0]?.trimEnd() === NON_ADDITIVE_MARK) return "marker";
  const ts = tokens(sql);
  if (!ts) return "unreadable";
  for (const s of statements(ts)) {
    const why = statementRisk(s);
    if (why) return why;
  }
  return null;
}
