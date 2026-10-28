import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const script = join(root, "scripts/ci/check-no-test-hooks.ts");

/** A one-module bundle whose fetch handler is `body`. */
function bundle(body: string): string {
  const d = mkdtempSync(join(tmpdir(), "oa-cnth-"));
  writeFileSync(
    join(d, "index.js"),
    `export class ArtifactRuntime { fetch() { return new Response(null); } }
export default { async fetch(req, env) { const p = new URL(req.url).pathname; ${body} } };`,
  );
  return d;
}

function run(dir: string) {
  const r = spawnSync(
    process.execPath,
    ["--experimental-strip-types", script, dir],
    { encoding: "utf8", timeout: 60_000 },
  );
  return { code: r.status, lines: r.stdout.trim().split("\n") };
}

const healthy = `if (p === "/healthz") return Response.json({ ok: true });`;

describe("check-no-test-hooks.ts", () => {
  it("every /__test/* path 404 with hooks switched on: exit 0, one line", () => {
    const r = run(
      bundle(`${healthy}
        if (env.TEST_HOOKS !== "1" || env.TEST_HOOK_KEY.length !== 48 || !env.TEST_DOMAIN) return new Response("env", { status: 500 });
        return new Response("nf", { status: 404 });`),
    );
    expect(r.lines).toEqual([
      "check-no-test-hooks: ok: 14 /__test/* requests all 404 with TEST_HOOKS=1",
    ]);
    expect(r.code).toBe(0);
  }, 60_000);

  it("a hook that answers: exit 1 naming it", () => {
    const r = run(
      bundle(`${healthy}
        if (req.method === "POST" && p === "/__test/session") return Response.json({ cookie: "c" });
        return new Response("nf", { status: 404 });`),
    );
    expect(r.lines).toEqual([
      "check-no-test-hooks: FAIL: POST /__test/session -> 200 (want 404)",
    ]);
    expect(r.code).toBe(1);
  }, 60_000);

  it("a 404 carrying a hook refusal reason: exit 1 naming it", () => {
    const r = run(
      bundle(`${healthy}
        if (req.method === "GET" && p === "/__test/audit") return Response.json({ error: { code: "not_found", message: "Not found", details: { reason: "bad_route" } } }, { status: 404 });
        return Response.json({ error: { code: "not_found", message: "Not found" } }, { status: 404 });`),
    );
    expect(r.lines).toEqual([
      "check-no-test-hooks: FAIL: GET /__test/audit -> 404 with a hook refusal reason",
    ]);
    expect(r.code).toBe(1);
  }, 60_000);

  it("/healthz reporting testHooks, or not serving: exit 1", () => {
    const hooks = run(
      bundle(
        `if (p === "/healthz") return Response.json({ ok: true, testHooks: true }); return new Response("nf", { status: 404 });`,
      ),
    );
    expect(hooks.lines).toEqual([
      "check-no-test-hooks: FAIL: GET /healthz reports testHooks",
    ]);
    expect(hooks.code).toBe(1);
    const dead = run(bundle(`return new Response("nf", { status: 404 });`));
    expect(dead.lines).toEqual([
      "check-no-test-hooks: FAIL: GET /healthz -> 404 (bundle not serving)",
    ]);
    expect(dead.code).toBe(1);
  }, 60_000);

  it("checks every @oa/shared TEST_HOOKS path", () => {
    const shared = readFileSync(
      join(root, "packages/shared/src/hosted/test-hooks.ts"),
      "utf8",
    );
    const block = /export const TEST_HOOKS = \{([^}]*)\}/.exec(shared)?.[1];
    const paths = [...(block ?? "").matchAll(/"(\/__test\/[^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(paths.length).toBeGreaterThan(4);
    expect(paths).toContain("/__test/code-caps/reset");
    const src = readFileSync(script, "utf8");
    for (const p of paths) expect(src).toContain(`"${p}"`);
  });

  it("no bundle: exit 1", () => {
    const r = run(join(tmpdir(), "oa-cnth-missing"));
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatch(/^check-no-test-hooks: FAIL: no bundle at /);
    expect(r.code).toBe(1);
  });
});
