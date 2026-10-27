import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Coverage proof for the broker transport (auth/broker-transport.ts): no code
// path reaches AUTH_BROKER_URL or DIRECTORY_BROKER_URL except brokerFetch's
// HTTPS branch, which is unreachable on HOSTED=1.
// - Every global fetch() in src is listed with what it fetches (its first
//   argument), so a new one has to be justified here. None is a broker URL
//   except brokerFetch's.
// - In brokerFetch, the HTTPS fetch comes after the HOSTED=1 throw.
// - The broker bindings (BROKER, DIRECTORY_BROKER) and props keys are read
//   only by the helper; the broker URL variables only where a transport is
//   resolved (no fetch there).

const SRC = join(import.meta.dirname, "../../src");
const HELPER = "auth/broker-transport.ts";

/** `file: enclosing function: first argument` → what it fetches. */
const FETCHES: Record<string, string> = {
  "auth/broker-transport.ts: brokerFetch: req":
    "the broker over HTTPS: self-host only (after the HOSTED=1 throw)",
  "auth/providers/google.ts: exchange: GOOGLE_TOKEN_URL":
    "Google's token endpoint (direct transport, self-host)",
  "auth/providers/access.ts: redeem: `${issuer}/token`":
    "Cloudflare Access token endpoint",
  "auth/turnstile.ts: verifyTurnstile: SITEVERIFY": "Turnstile siteverify",
  "directory/direct.ts: token: GOOGLE_TOKEN_URL":
    "Google's token endpoint (direct directory transport)",
  "directory/direct.ts: revoke: GOOGLE_REVOKE_URL":
    "Google's revoke endpoint (direct directory transport)",
  "directory/google.ts: get: url": "the Admin SDK and Reports API",
  "services/usage.ts: query: GRAPHQL": "Cloudflare GraphQL analytics",
};

/** Identifiers only the helper (and env.ts, the declaration) may name. */
const HELPER_ONLY = ["BROKER", "DIRECTORY_BROKER", "AUTH_BROKER"];
/** The broker URL variables: read only where a transport is resolved. */
const URL_READS = new Set([
  "auth/config.ts",
  "directory/transport.ts",
  "env.ts",
]);

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return files(p);
    return e.name.endsWith(".ts") && !e.name.endsWith(".generated.ts")
      ? [p]
      : [];
  });
}

function enclosing(n: ts.Node): string {
  for (let p = n.parent; p; p = p.parent) {
    if ((ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)) && p.name)
      return p.name.getText();
    if (
      ts.isVariableDeclaration(p) &&
      p.initializer &&
      (ts.isArrowFunction(p.initializer) ||
        ts.isFunctionExpression(p.initializer))
    )
      return p.name.getText();
    if (ts.isArrowFunction(p) || ts.isFunctionExpression(p)) {
      const v = p.parent;
      if (!(ts.isVariableDeclaration(v) && v.initializer === p))
        return "(anonymous)";
    }
  }
  return "(module)";
}

/** A call of the global fetch: fetch(...), globalThis.fetch(...), self.fetch(...). */
const isGlobalFetch = (c: ts.CallExpression) => {
  const f = c.expression;
  if (ts.isIdentifier(f)) return f.text === "fetch";
  return (
    ts.isPropertyAccessExpression(f) &&
    f.name.text === "fetch" &&
    ts.isIdentifier(f.expression) &&
    ["globalThis", "self", "window"].includes(f.expression.text)
  );
};

function scan(root: string) {
  const fetches: string[] = [];
  const helperOnly: string[] = [];
  const urlReads: string[] = [];
  for (const file of files(root)) {
    const rel = relative(root, file);
    const src = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && isGlobalFetch(n))
        fetches.push(
          `${rel}: ${enclosing(n)}: ${n.arguments[0]?.getText() ?? ""}`,
        );
      const name =
        ts.isIdentifier(n) ||
        ts.isStringLiteral(n) ||
        ts.isNoSubstitutionTemplateLiteral(n)
          ? n.text
          : null;
      if (
        name &&
        HELPER_ONLY.includes(name) &&
        rel !== HELPER &&
        rel !== "env.ts"
      )
        helperOnly.push(`${rel}: ${enclosing(n)}: ${name}`);
      if (
        name &&
        (name === "AUTH_BROKER_URL" || name === "DIRECTORY_BROKER_URL") &&
        !URL_READS.has(rel)
      )
        urlReads.push(`${rel}: ${enclosing(n)}: ${name}`);
      ts.forEachChild(n, visit);
    };
    visit(src);
  }
  return {
    fetches: [...new Set(fetches)].sort(),
    helperOnly: [...new Set(helperOnly)].sort(),
    urlReads: [...new Set(urlReads)].sort(),
  };
}

describe("broker transport coverage", () => {
  const found = scan(SRC);

  it("every global fetch() in src is listed; the only broker fetch is brokerFetch's", () => {
    expect(found.fetches).toEqual(Object.keys(FETCHES).sort());
  });

  it("brokerFetch's HTTPS fetch is unreachable on HOSTED=1", () => {
    const text = readFileSync(join(SRC, HELPER), "utf8");
    const body = text.slice(text.indexOf("export async function brokerFetch"));
    const hosted = body.indexOf(
      'if (env.HOSTED === "1") throw new BrokerUnavailableError(which);',
    );
    const net = body.indexOf("return fetch(req);");
    expect(hosted).toBeGreaterThan(0);
    expect(net).toBeGreaterThan(hosted);
    // The binding and props branches return before it; nothing else fetches.
    expect(body.match(/\bfetch\(/g)?.length).toBe(3);
  });

  it("the broker bindings and props are named only by the helper", () => {
    expect(found.helperOnly).toEqual([]);
  });

  it("the broker URL variables are read only where a transport resolves", () => {
    expect(found.urlReads).toEqual([]);
  });

  it("the scan catches every fetch form and a stray binding or URL read", () => {
    const got = scan(join(import.meta.dirname, "fixtures/broker"));
    expect(got.fetches).toEqual([
      "probe.ts: direct: `${env.AUTH_BROKER_URL}/google/redeem`",
      "probe.ts: later: u",
      "probe.ts: viaGlobal: env.DIRECTORY_BROKER_URL",
    ]);
    expect(got.helperOnly).toEqual([
      "probe.ts: (module): BROKER", // its type: a binding named anywhere counts
      "probe.ts: viaBinding: BROKER",
      "probe.ts: viaProps: AUTH_BROKER",
    ]);
    expect(got.urlReads).toEqual([
      "probe.ts: (module): AUTH_BROKER_URL",
      "probe.ts: (module): DIRECTORY_BROKER_URL",
      "probe.ts: direct: AUTH_BROKER_URL",
      "probe.ts: viaGlobal: DIRECTORY_BROKER_URL",
    ]);
  });
});
