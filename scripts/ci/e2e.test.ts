import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { root, sandbox, script, write } from "./stubs.ts";

const pnpm = 'echo "PW_DIR=$PLAYWRIGHT_HTML_OUTPUT_DIR" >> "$STUB_LOG"';
const run = (arg: string, env: Record<string, string> = {}) => {
  const sb = sandbox({ pnpm, sudo: '"$@"' });
  return { ...sb.run(["bash", script("e2e.sh"), arg], { env }), sb };
};

describe("e2e.sh", () => {
  it("version writes the dashboard's Playwright version", () => {
    const sb = sandbox({});
    const out = join(sb.dir, "out");
    write(out, "");
    const r = sb.run(["bash", script("e2e.sh"), "version"], {
      env: { GITHUB_OUTPUT: out },
    });
    expect(r.code).toBe(0);
    const pkg = JSON.parse(
      readFileSync(
        join(root, "apps/dashboard/node_modules/@playwright/test/package.json"),
        "utf8",
      ),
    );
    expect(readFileSync(out, "utf8")).toBe(`playwright=${pkg.version}\n`);
  });
  it("install takes chromium and webkit from the image, with no OS deps step", () => {
    const pkg = JSON.parse(
      readFileSync(
        join(root, "apps/dashboard/node_modules/@playwright/test/package.json"),
        "utf8",
      ),
    );
    const r = run("install", { PLAYWRIGHT_IMAGE_VERSION: pkg.version });
    expect(r.code).toBe(0);
    expect(r.sb.log()).toContain(
      "pnpm --filter @oa/dashboard exec playwright install chromium webkit",
    );
    expect(r.sb.log().join("\n")).not.toContain("--with-deps");
  });
  it("install fails fast when the image is not the pinned Playwright version", () => {
    const r = run("install", { PLAYWRIGHT_IMAGE_VERSION: "0.0.1" });
    expect(r.code).toBe(1);
    expect(r.sb.log().join("\n")).not.toContain("playwright install");
  });
  it("hosts adds the line once", () => {
    const sb = sandbox({ sudo: '"$@"' });
    const hosts = join(sb.dir, "hosts");
    write(hosts, "127.0.0.1 localhost\n");
    for (let i = 0; i < 2; i++)
      expect(
        sb.run(["bash", script("e2e.sh"), "hosts"], {
          env: { HOSTS_FILE: hosts },
        }).code,
      ).toBe(0);
    expect(readFileSync(hosts, "utf8")).toBe(
      "127.0.0.1 localhost\n127.0.0.1 app.localhost content.localhost\n",
    );
  });
  it("mock and real run their suites into separate reports", () => {
    const mock = run("mock");
    expect(mock.code).toBe(0);
    expect(mock.sb.log()).toEqual([
      "pnpm --filter @oa/dashboard exec playwright test --reporter=list,html",
      "PW_DIR=playwright-report/mock",
    ]);
    const real = run("real");
    expect(real.code).toBe(0);
    expect(real.sb.log()).toEqual([
      "pnpm --filter @oa/dashboard exec playwright test -c playwright.real.config.ts",
      "PW_DIR=playwright-report/real",
    ]);
  });
  it("with E2E_SHARD, mock and real run only that shard, as one blob per suite and shard", () => {
    const blob =
      'echo "BLOB=$PLAYWRIGHT_BLOB_OUTPUT_FILE PW_DIR=$PLAYWRIGHT_HTML_OUTPUT_DIR" >> "$STUB_LOG"';
    for (const suite of ["mock", "real"]) {
      const sb = sandbox({ pnpm: blob });
      const r = sb.run(["bash", script("e2e.sh"), suite], {
        env: { E2E_SHARD: "3/4", E2E_BLOB_DIR: join(sb.dir, "blobs") },
      });
      expect(r.code).toBe(0);
      const config = suite === "real" ? " -c playwright.real.config.ts" : "";
      expect(sb.log()).toEqual([
        `pnpm --filter @oa/dashboard exec playwright test${config} --shard=3/4 --reporter=list,blob`,
        `BLOB=${join(sb.dir, "blobs", suite, "shard-3.zip")} PW_DIR=`,
      ]);
    }
  });
  it("merge builds one html report per suite that has blobs, and nothing without any", () => {
    const none = run("merge", { E2E_BLOB_DIR: "/nonexistent/blobs" });
    expect(none.code).toBe(0);
    expect(none.sb.log()).toEqual([]);
    const sb = sandbox({ pnpm });
    const blobs = join(sb.dir, "blobs");
    write(join(blobs, "real", "shard-1.zip"), "");
    const r = sb.run(["bash", script("e2e.sh"), "merge"], {
      env: { E2E_BLOB_DIR: blobs },
    });
    expect(r.code).toBe(0);
    expect(sb.log()).toEqual([
      `pnpm --filter @oa/dashboard exec playwright merge-reports --reporter=html ${join(blobs, "real")}`,
      "PW_DIR=playwright-report/real",
    ]);
  });
  it("spaces runs its whole suite: an html report locally, a blob in a CI shard", () => {
    const local = run("spaces");
    expect(local.code).toBe(0);
    expect(local.sb.log()).toEqual([
      "pnpm --filter @oa/dashboard test:e2e:spaces",
      "PW_DIR=playwright-report/spaces",
    ]);
    const blob = 'echo "BLOB=$PLAYWRIGHT_BLOB_OUTPUT_FILE" >> "$STUB_LOG"';
    const sb = sandbox({ pnpm: blob });
    const r = sb.run(["bash", script("e2e.sh"), "spaces"], {
      env: { E2E_SHARD: "3/4", E2E_BLOB_DIR: join(sb.dir, "blobs") },
    });
    expect(r.code).toBe(0);
    expect(sb.log()).toEqual([
      "pnpm --filter @oa/dashboard test:e2e:spaces --reporter=list,blob",
      `BLOB=${join(sb.dir, "blobs", "spaces", "shard-3.zip")}`,
    ]);
  });
  it("ui runs the @oa/ui real-browser checks (axe contrast, focus)", () => {
    const r = run("ui");
    expect(r.code).toBe(0);
    expect(r.sb.log()).toEqual([
      "pnpm --filter @oa/ui test:browser",
      "PW_DIR=",
    ]);
  });
  it("rejects an unknown step", () => {
    expect(run("deploy").code).toBe(2);
  });
});
