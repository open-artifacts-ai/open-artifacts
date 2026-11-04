import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { R } from "../../../packages/shared/src/routes.ts";

/**
 * #1204/#1313: the server routes that answer only an interactive sign-in,
 * found by reading apps/server/src. A handler counts when it calls
 * interactiveSession(c) directly or through any chain of helpers that do,
 * in its own file or imported from another (share-notices' browserUser,
 * directory's disconnect). A static read, so it errs loud: a path it can't
 * resolve comes back as `<METHOD> ?<expression>` and fails the guard.
 */

export const SERVER_SRC = join(import.meta.dirname, "../../../apps/server/src");

export interface SourceFile {
  path: string;
  src: string;
}

export function serverSources(dir = SERVER_SRC): SourceFile[] {
  const out: SourceFile[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (n.endsWith(".ts") && !n.endsWith(".d.ts"))
        out.push({ path: relative(dir, p), src: readFileSync(p, "utf8") });
    }
  };
  walk(dir);
  return out;
}

/**
 * The source with comments blanked and string, template and regex literal
 * bodies replaced by spaces (same length), so brackets and names can be
 * counted. Literal text stays readable in `src` at the same offsets.
 */
export function codeMask(src: string): string {
  const out = src.split("");
  const blank = (a: number, b: number) => {
    for (let k = a; k < b; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  let prev = ""; // last significant code char, for the regex heuristic
  const tpl: number[] = []; // brace depth at each open ${ in a template
  let depth = 0;
  const str = (q: string) => {
    const s = i++;
    while (i < src.length && src[i] !== q) i += src[i] === "\\" ? 2 : 1;
    blank(s + 1, i);
    i++;
    prev = q;
  };
  const template = () => {
    // From just after ` (or after the } closing a ${), to the next ` or ${.
    const s = i;
    while (i < src.length && src[i] !== "`") {
      if (src[i] === "\\") i += 2;
      else if (src[i] === "$" && src[i + 1] === "{") {
        blank(s, i);
        tpl.push(depth);
        depth++;
        i += 2;
        prev = "{";
        return;
      } else i++;
    }
    blank(s, i);
    i++;
    prev = "`";
  };
  while (i < src.length) {
    const ch = src[i] as string;
    const nx = src[i + 1];
    if (ch === "/" && nx === "/") {
      const s = i;
      while (i < src.length && src[i] !== "\n") i++;
      blank(s, i);
    } else if (ch === "/" && nx === "*") {
      const e = src.indexOf("*/", i + 2);
      const end = e < 0 ? src.length : e + 2;
      blank(i, end);
      i = end;
    } else if (ch === '"' || ch === "'") str(ch);
    else if (ch === "`") {
      i++;
      template();
    } else if (
      ch === "/" &&
      (prev === "" || "(,=:[!&|?{};+-*%<>~^".includes(prev))
    ) {
      const s = i++;
      let cls = false;
      while (i < src.length && (cls || src[i] !== "/") && src[i] !== "\n") {
        if (src[i] === "\\") i++;
        else if (src[i] === "[") cls = true;
        else if (src[i] === "]") cls = false;
        i++;
      }
      blank(s + 1, i);
      i++;
      prev = "/";
    } else if (ch === "}" && tpl.length && tpl[tpl.length - 1] === depth - 1) {
      tpl.pop();
      depth--;
      i++;
      template();
    } else {
      if (ch === "{" || ch === "(" || ch === "[") depth++;
      else if (ch === "}" || ch === ")" || ch === "]") depth--;
      if (!/\s/.test(ch)) prev = ch;
      i++;
    }
  }
  return out.join("");
}

/** Index of the bracket closing the one at `open`, in a masked source. */
function closing(code: string, open: number): number {
  let d = 0;
  for (let k = open; k < code.length; k++) {
    const ch = code[k];
    if (ch === "(" || ch === "{" || ch === "[") d++;
    else if (ch === ")" || ch === "}" || ch === "]") {
      d--;
      if (d === 0) return k;
    }
  }
  return code.length;
}

/** The end of a declaration starting at `start`: its closing } or ; at its own depth. */
function declEnd(code: string, start: number): number {
  let d = 0;
  for (let k = start; k < code.length; k++) {
    const ch = code[k];
    if (ch === "(" || ch === "{" || ch === "[") d++;
    else if (ch === ")" || ch === "]") d--;
    else if (ch === "}") {
      d--;
      if (d === 0) return k + 1;
      if (d < 0) return k;
    } else if (ch === ";" && d === 0) return k;
  }
  return code.length;
}

/** Whether the initializer at `at` (just past `=`) is a function. */
function isFunction(code: string, at: number): boolean {
  const s = code.slice(at).replace(/^\s*(?:async\s+)?/, "");
  if (/^function\b/.test(s) || /^[A-Za-z_$][\w$]*\s*=>/.test(s)) return true;
  if (!s.startsWith("(")) return false;
  const off = code.length - s.length;
  const after = code.slice(closing(code, off) + 1).trimStart();
  if (after.startsWith("=>")) return true;
  // A return type: `(c): Member => ...`.
  return after.startsWith(":") && /^:[^;{]*=>/.test(after);
}

const DECL =
  /\b(?:(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)|(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=)/g;

const refers = (text: string, names: Iterable<string>) => {
  for (const n of names)
    if (
      new RegExp(`(?<![\\w$.])${n.replace(/\$/g, "\\$")}(?![\\w$])`).test(text)
    )
      return true;
  return false;
};

interface Parsed {
  path: string;
  src: string;
  code: string;
  decls: { name: string; body: string; exported: boolean }[];
  imports: Set<string>;
  consts: Map<string, string>;
}

function parse(f: SourceFile): Parsed {
  const code = codeMask(f.src);
  const decls: Parsed["decls"] = [];
  for (const m of code.matchAll(DECL)) {
    const name = (m[1] ?? m[2]) as string;
    const at = m.index + m[0].length;
    // Only functions are helpers: `const user = browserUser(c)` inside a
    // handler is a value, and tainting it would flag every other `user`.
    if (m[2] && !isFunction(code, at)) continue;
    const body = code.slice(at, declEnd(code, at));
    decls.push({ name, body, exported: m[0].startsWith("export") });
  }
  const imports = new Set<string>();
  for (const m of code.matchAll(/\bimport\s+(?:type\s+)?\{([^}]*)\}/g))
    for (const part of (m[1] as string).split(",")) {
      const local = part
        .trim()
        .split(/\s+as\s+/)
        .pop()
        ?.trim();
      if (local && !local.startsWith("type ")) imports.add(local);
    }
  // `const NAME = "..."` / `const NAME = \`...\`` / `const NAME = R.x;`
  const consts = new Map<string, string>();
  for (const m of code.matchAll(
    /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(?=["'`]|R\.\w+\s*;)/g,
  )) {
    const at = m.index + m[0].length;
    let e = at;
    for (let d = 0; e < code.length; e++) {
      const ch = code[e];
      if (ch === "(" || ch === "{" || ch === "[") d++;
      else if (ch === ")" || ch === "}" || ch === "]") d--;
      else if ((ch === ";" || ch === "\n") && d === 0) break;
    }
    consts.set(m[1] as string, f.src.slice(at, e).trim());
  }
  return { ...f, code, decls, imports, consts };
}

/**
 * Resolve a route's path argument (source text) to its Hono pattern: a
 * string literal, R.name, a top-of-file string constant, or a template of
 * those. Anything else is null.
 */
function resolvePath(
  arg: string,
  consts: ReadonlyMap<string, string>,
  seen = 0,
): string | null {
  const a = arg.trim();
  if (seen > 8) return null;
  const lit = /^"([^"]*)"$|^'([^']*)'$/.exec(a);
  if (lit) return (lit[1] ?? lit[2]) as string;
  const ref = (e: string): string | null => {
    const r = /^R\.(\w+)$/.exec(e);
    if (r) {
      const v = (R as Record<string, unknown>)[r[1] as string];
      return typeof v === "string" ? v : null;
    }
    const c = /^[A-Za-z_$][\w$]*$/.test(e) ? consts.get(e) : undefined;
    return c === undefined ? null : resolvePath(c, consts, seen + 1);
  };
  if (a.startsWith("`") && a.endsWith("`")) {
    let ok = true;
    const p = a.slice(1, -1).replace(/\$\{([^}]*)\}/g, (_, e: string) => {
      const v = ref(e.trim());
      if (v === null) ok = false;
      return v ?? "";
    });
    return ok ? p : null;
  }
  return ref(a);
}

const ROUTE =
  /\b(\w*[aA]pp)(?:\.(get|post|put|patch|delete|all|on)|\[(\w+)\])\s*\(/g;

/**
 * Every route whose handler reaches interactiveSession(c), as "METHOD /path";
 * with `all`, every route the scan sees (to prove it misses none).
 */
export function interactiveRoutes(
  files: readonly SourceFile[],
  { all = false } = {},
): string[] {
  const parsed = files.map(parse);
  const tainted = new Map<Parsed, Set<string>>(
    parsed.map((p) => [p, new Set(["interactiveSession"])]),
  );
  // Fixpoint: a declaration is tainted when it refers to a tainted name; an
  // exported tainted name taints the files that import it.
  for (let changed = true; changed; ) {
    changed = false;
    const exported = new Set<string>();
    for (const p of parsed)
      for (const d of p.decls)
        if (d.exported && tainted.get(p)?.has(d.name)) exported.add(d.name);
    for (const p of parsed) {
      const t = tainted.get(p) as Set<string>;
      for (const n of exported)
        if (p.imports.has(n) && !t.has(n)) {
          t.add(n);
          changed = true;
        }
      for (const d of p.decls)
        if (!t.has(d.name) && refers(d.body, t)) {
          t.add(d.name);
          changed = true;
        }
    }
  }
  const found: string[] = [];
  for (const p of parsed) {
    const t = tainted.get(p) as Set<string>;
    for (const m of p.code.matchAll(ROUTE)) {
      const open = m.index + m[0].length - 1;
      const close = closing(p.code, open);
      const code = p.code.slice(open + 1, close);
      // Split the arguments at depth 0.
      const args: [number, number][] = [];
      let d = 0;
      let s = 0;
      for (let k = 0; k < code.length; k++) {
        const ch = code[k];
        if (ch === "(" || ch === "{" || ch === "[") d++;
        else if (ch === ")" || ch === "}" || ch === "]") d--;
        else if (ch === "," && d === 0) {
          args.push([s, k]);
          s = k + 1;
        }
      }
      args.push([s, code.length]);
      const text = (a: [number, number]) =>
        p.src.slice(open + 1 + a[0], open + 1 + a[1]);
      let methods = [(m[2] ?? "").toUpperCase()];
      let rest = args;
      if (m[3]) {
        // `for (const method of ["put", "delete"] as const) app[method](...)`
        const loop = new RegExp(
          `for\\s*\\(\\s*const\\s+${m[3]}\\s+of\\s+\\[([^\\]]*)\\]`,
        ).exec(p.src.slice(Math.max(0, m.index - 300), m.index));
        methods = loop
          ? [...(loop[1] as string).matchAll(/"(\w+)"/g)].map((x) =>
              (x[1] as string).toUpperCase(),
            )
          : [`?${m[3]}`];
      } else if (m[2] === "on") {
        methods = [
          ...text(args[0] as [number, number]).matchAll(/"(\w+)"/g),
        ].map((x) => x[1] as string);
        rest = args.slice(1);
      }
      const [pathArg, ...handlers] = rest;
      if (!pathArg) continue;
      const handlerCode = handlers.map((a) => code.slice(a[0], a[1])).join(",");
      if (!all && !refers(handlerCode, t)) continue;
      const raw = text(pathArg).trim();
      const path = resolvePath(raw, p.consts) ?? `?${raw}`;
      for (const meth of methods) found.push(`${meth} ${path}`);
    }
  }
  return [...new Set(found)].sort();
}
