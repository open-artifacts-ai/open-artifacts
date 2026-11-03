// MIG-2 (#1137): a migration that can lose data needs a person. prod's guard
// (scripts/ci/prod-migration-guard.sh) trusts the first-line marker; here a
// forgotten marker holds too. This is an allowlist over real tokens: a
// statement passes only in a form known to keep data, and anything else,
// unreadable SQL included, is held. A false hold costs one manual upgrade, and
// a miss costs data.

export const NON_ADDITIVE_MARK = "-- oa:non-additive";

type Token =
  | { t: "word"; v: string }
  | { t: "lit" }
  | { t: "punct"; v: string };

/** Comments dropped, quoted things one token each; null when it doesn't end. */
function tokens(sql: string): Token[] | null {
  const out: Token[] = [];
  let i = 0;
  const quoted = (close: string, doubled: boolean): boolean => {
    for (let j = i + 1; j < sql.length; j++) {
      if (sql[j] !== close) continue;
      if (doubled && sql[j + 1] === close) {
        j++;
        continue;
      }
      i = j + 1;
      return true;
    }
    return false;
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
      if (!quoted(c, true)) return null;
      out.push({ t: "lit" });
    } else if (c === "[") {
      if (!quoted("]", false)) return null;
      out.push({ t: "lit" });
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
  const trigger =
    word(ts[from]) === "CREATE" &&
    ts.slice(from, from + 4).some((x) => word(x) === "TRIGGER");
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

/** A WHERE outside every parenthesis, that isn't always true. */
function narrowed(s: readonly Token[]): boolean {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const x = s[i] as Token;
    if (x.t === "punct" && x.v === "(") depth++;
    else if (x.t === "punct" && x.v === ")") depth--;
    else if (depth === 0 && word(x) === "WHERE")
      return s
        .slice(i + 1)
        .some(
          (y) =>
            y.t === "lit" ||
            (y.t === "word" && !/^(\d+|TRUE|NOT|NULL)$/.test(y.v)),
        );
  }
  return false;
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
