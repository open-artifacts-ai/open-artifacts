import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { missingSecrets, requiredSecrets } from "./check-staging-secrets";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const envTs = readFileSync(join(root, "apps/server/src/env.ts"), "utf8");
const wrangler = readFileSync(
  join(root, "apps/server/wrangler.staging.jsonc"),
  "utf8",
);
const list = (...names: string[]) =>
  names.map((name) => ({ name, type: "secret_text" }));
const ALL = ["ACCESS_CLIENT_SECRET", "SESSION_SECRET", "CONTENT_SIGNING_KEY"];

describe("requiredSecrets", () => {
  it("OWNER_EMAIL is a deploy var (#1084): never committed, never a required secret", () => {
    expect(requiredSecrets(envTs, wrangler)).not.toContain("OWNER_EMAIL");
  });
  it("derives non-optional, non-var string fields of Env", () => {
    // Superset: new required secrets may be added to Env over time.
    expect(requiredSecrets(envTs, wrangler)).toEqual(
      expect.arrayContaining(ALL),
    );
  });
});

describe("CF_ACCOUNT_ID is a var", () => {
  it("is not required as a secret", () => {
    expect(requiredSecrets(envTs, wrangler)).not.toContain("CF_ACCOUNT_ID");
    expect(missingSecrets(envTs, wrangler, list(...ALL))).not.toContain(
      "CF_ACCOUNT_ID",
    );
  });
});

describe("requiredSecrets parser (fixtures)", () => {
  const W = '{"env":{"staging":{"vars":{"V":"x"}}}}';
  const env = (body: string) =>
    `import x from "y";\nexport interface Env {\n${body}\n}\nexport const z = 1;\n`;
  const req = (body: string) => requiredSecrets(env(body), W);
  it("accepts readonly, , and ; terminators", () => {
    expect(req("  readonly A: string;\n  B: string,\n  C: string")).toEqual([
      "A",
      "B",
      "C",
    ]);
  });
  it("treats `| undefined` and `?` as optional", () => {
    expect(
      req(
        "  A: string | undefined;\n  B?: string;\n  C?: string | undefined;\n  D: string;",
      ),
    ).toEqual(["D"]);
  });
  it("skips vars, literal unions (multi-line) and bindings", () => {
    expect(
      req(
        [
          "  V: string;",
          '  E: "dev" | "production";',
          "  M:",
          '    | "a"',
          '    | "b";',
          "  DB: D1Database;",
          "  F: R2Bucket; K: KVNamespace;",
          "  DO: DurableObjectNamespace<Foo>;",
          "  AS: Fetcher;",
          "  RL: RateLimit;",
          "  EM?: SendEmail;",
          "  S: string;",
        ].join("\n"),
      ),
    ).toEqual(["S"]);
  });
  it("ignores comments, including braces and fake fields in them", () => {
    expect(
      req(
        "  // X: string;\n  /* Y: string; } */\n  A: string; // trailing }\n  /** doc\n   * Z: string;\n   */\n  B: string;",
      ),
    ).toEqual(["A", "B"]);
  });
  it("does not truncate at an inner closing brace line", () => {
    expect(() =>
      req("  A: string;\n  N: {\n    x: string;\n  };\n  B: string;"),
    ).toThrow();
  });
  it("throws on unknown types", () => {
    expect(() => req("  A: SomethingNew;")).toThrow(/A/);
    expect(() => req("  A: number;")).toThrow();
    expect(() => req("  A: string[];")).toThrow();
  });
  it("throws on a nested object", () => {
    expect(() => req("  A: { b: string };")).toThrow();
  });
  it("throws when interface Env is missing", () => {
    expect(() => requiredSecrets("export interface Other {}", W)).toThrow();
  });
});

describe("missingSecrets", () => {
  it("names every missing required secret", () => {
    expect(
      missingSecrets(envTs, wrangler, list("ACCESS_CLIENT_SECRET")),
    ).toEqual(["SESSION_SECRET", "CONTENT_SIGNING_KEY"]);
  });
  it("is ok when all are present", () => {
    expect(missingSecrets(envTs, wrangler, list(...ALL))).toEqual([]);
  });
  it("ignores a missing optional field and extra secrets", () => {
    expect(
      missingSecrets(envTs, wrangler, list(...ALL, "ANALYTICS_TOKEN")),
    ).toEqual([]);
    expect(missingSecrets(envTs, wrangler, list(...ALL, "OTHER"))).toEqual([]);
  });
});

describe("cli", () => {
  const run = (stdin: string) =>
    spawnSync("node", [join(root, "scripts/ops/check-staging-secrets.ts")], {
      input: stdin,
      encoding: "utf8",
      cwd: root,
    });
  it("exits non-zero naming missing secrets (names only)", () => {
    const r = run(JSON.stringify(list("SESSION_SECRET")));
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toContain(
      "::error::missing Worker secrets: ACCESS_CLIENT_SECRET, CONTENT_SIGNING_KEY",
    );
  });
  it("exits zero when complete", () => {
    expect(run(JSON.stringify(list(...ALL))).status).toBe(0);
  });
  it("fails on unparseable input with exit 2", () => {
    const r = run("not json");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("cannot parse");
  });
  it("extracts the array from the first [ of noisy output", () => {
    const r = run(` ⛅️ wrangler 4.151.1\n${JSON.stringify(list(...ALL))}\n`);
    expect(r.status).toBe(0);
  });
});
