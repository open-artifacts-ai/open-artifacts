import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = join(dirname(fileURLToPath(import.meta.url)), "../../src");

/**
 * The rule: the scheduler may only call `.scheduled(` on a dispatch stub,
 * never `fetch`. A fetch on a user Worker would run its request handler with
 * the platform's authority, so every use of `DISPATCHER` must be exactly
 *
 *   DISPATCHER.get(<args>) [as unknown as ScheduledFetcher)] .scheduled(
 *
 * in one expression, with no stub variable (so there is no `s.fetch(`, no
 * `s["fetch"]`, no destructuring, no passing the namespace or a stub on). The
 * only other allowed mention is the Env member `DISPATCHER: DispatchNamespace`.
 * Comments and strings are blanked first. Conservative on purpose: anything
 * else fails, and the fix is to keep to the one form.
 *
 * A tripwire against honest mistakes, not a security boundary: it misses
 * code inside template-literal `${}` and computed env keys (`env[k]`).
 * Code review is still the control.
 */
function violations(code: string): string[] {
  const text = blank(code);
  const out: string[] = [];
  // A bracketed string key hides the name from the blanked text.
  if (/\[\s*["'`]DISPATCHER["'`]\s*\]/.test(code))
    out.push("DISPATCHER accessed by string key");
  for (const m of text.matchAll(/\bDISPATCHER\b/g)) {
    const at = m.index as number;
    const rest = text.slice(at + "DISPATCHER".length);
    if (/^\s*:\s*DispatchNamespace\s*;/.test(rest)) continue;
    const get = /^\s*\.get\s*\(/.exec(rest);
    if (!get) {
      out.push(`DISPATCHER used other than .get( at ${at}`);
      continue;
    }
    const open = at + "DISPATCHER".length + get[0].length - 1;
    const close = matching(text, open);
    if (close < 0) {
      out.push(`unbalanced DISPATCHER.get( at ${at}`);
      continue;
    }
    const after = text.slice(close + 1);
    if (
      !/^\s*(?:as\s+unknown\s+as\s+ScheduledFetcher\s*\)\s*)?\.scheduled\s*\(/.test(
        after,
      )
    )
      out.push(`DISPATCHER.get(...) not followed by .scheduled( at ${at}`);
  }
  return out;
}

/** Index of the paren closing the one at `open`, or -1. */
function matching(t: string, open: number): number {
  let d = 0;
  for (let i = open; i < t.length; i++) {
    if (t[i] === "(") d++;
    else if (t[i] === ")" && --d === 0) return i;
  }
  return -1;
}

/** Blank comments and string/template contents, keeping offsets. */
function blank(code: string): string {
  return code.replace(
    /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`/g,
    (m) => m.replace(/[^\n]/g, " "),
  );
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory()
      ? files(p)
      : /\.[mc]?[jt]sx?$/.test(p)
        ? [p]
        : [];
  });
}

describe("DISPATCHER is only ever called with .scheduled(", () => {
  it("every use in apps/scheduler/src", () => {
    const all = files(src);
    expect(all.length).toBeGreaterThan(0);
    let uses = 0;
    for (const f of all) {
      const code = readFileSync(f, "utf8");
      uses += (blank(code).match(/\bDISPATCHER\b/g) ?? []).length;
      expect({ f, v: violations(code) }).toEqual({ f, v: [] });
    }
    // The checker is looking at the real call, not nothing.
    expect(uses).toBeGreaterThanOrEqual(2);
  });

  it("accepts the real forms", () => {
    expect(violations("DISPATCHER: DispatchNamespace;")).toEqual([]);
    expect(
      violations(
        "await (env.DISPATCHER.get(names(id).script) as unknown as ScheduledFetcher).scheduled({})",
      ),
    ).toEqual([]);
    expect(violations("env.DISPATCHER.get(x).scheduled({})")).toEqual([]);
    expect(
      violations("// DISPATCHER.get(x).fetch(r)\nconst s = 'DISPATCHER.fetch'"),
    ).toEqual([]);
  });

  it.each([
    "env.DISPATCHER.get(x).fetch(req)",
    "env.DISPATCHER.get(x)['fetch'](req)",
    'env.DISPATCHER.get(x)["fetch"](req)',
    "const s = env.DISPATCHER.get(x); s.fetch(req); s.scheduled({})",
    "const s = env.DISPATCHER.get(x); s['fetch'](req)",
    "env.DISPATCHER.get(x)?.fetch(req)",
    "env.DISPATCHER.get(x).scheduled",
    "(env.DISPATCHER.get(x) as ScheduledFetcher).fetch(req)",
    "const { DISPATCHER } = env",
    "const d = env.DISPATCHER; d.get(x).fetch(r)",
    "env.DISPATCHER['get'](x).fetch(r)",
    "fn(env.DISPATCHER)",
    "env.DISPATCHER.get(x",
    'env["DISPATCHER"].get(x).fetch(r)',
    "env['DISPATCHER'].get(x).fetch(r)",
    "env[`DISPATCHER`].get(x).fetch(r)",
    'const k = env["DISPATCHER"]',
  ])("rejects %s", (code) => {
    expect(violations(code).length).toBeGreaterThan(0);
  });
});
