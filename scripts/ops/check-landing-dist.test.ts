import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const script = join(root, "scripts/ops/check-landing-dist.ts");
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "landing-dist-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const put = (rel: string, body: string | Buffer) => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), body);
};
const run = (d = dir) => {
  const r = spawnSync("node", [script, d], { encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

describe("check-landing-dist", () => {
  it("fails on TODO in html", () => {
    put("index.html", "<p>ok</p>\n<p>TODO fix</p>");
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toContain(
      `::error file=${join(dir, "index.html")}::landing not release-ready: found "TODO" in ${join(dir, "index.html")}:2`,
    );
    expect(r.out).toContain("::error::Landing deploy skipped:");
  });
  it("fails on TODO in llms.txt", () => {
    put("llms.txt", "# setup\nTODO: instructions");
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toContain("llms.txt:2");
  });
  it("fails on {{ placeholder", () => {
    put("a/b.json", '{"x":"{{ name }}"}');
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toContain('found "{{"');
  });
  it("fails on OA-UNRELEASED marker and names it", () => {
    put("docs/setup.html", "<p>OA-UNRELEASED</p>");
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toContain('found "OA-UNRELEASED"');
    expect(r.out).toContain("OA-UNRELEASED");
    expect(r.out).toMatch(/::error::Landing deploy skipped:.*OA-UNRELEASED/);
  });
  it("passes on a clean dir", () => {
    put("index.html", '<html><head><meta charset="utf-8"></head><p>hi</p>');
    put("llms.txt", "setup");
    const r = run();
    expect(r.code).toBe(0);
    expect(r.out).toContain("ok: landing dist clean");
  });
  const page = (links: string) =>
    `<html><head><meta charset="utf-8"></head><body>\n${links}\n</body></html>`;
  it("fails when a Get started free link goes to #pricing", () => {
    put(
      "index.html",
      page(
        '<a class="btn p" href="https://app.example.com/sign-up">Get started free</a>\n<a class="btn p" href="#pricing">Get started free</a>',
      ),
    );
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toContain("Get started free link without a sign-up URL");
    expect(r.out).toContain("HOSTED_SIGNUP_URL");
    expect(r.out).toContain(`${join(dir, "index.html")}:3`);
    expect(r.out).not.toContain(`${join(dir, "index.html")}:2`);
  });
  it("fails when a Get started free link has no href", () => {
    put("index.html", page("<a>Get started free</a>"));
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toContain("Get started free link without a sign-up URL");
  });
  it("passes when every Get started free link goes to the sign-up URL", () => {
    put(
      "index.html",
      page(
        '<a class="btn" href="https://app.example.com/sign-up">Get started free</a>\n<a href="#pricing">Pricing</a>',
      ),
    );
    expect(run().code).toBe(0);
  });
  it("fails on a page without a leading utf-8 charset meta", () => {
    put("ok.html", '<head>\n  <meta charset="UTF-8" />\n<title>x</title>');
    put("none.html", "<head><title>x</title></head>");
    put("late.html", '<head><title>x</title><meta charset="utf-8"></head>');
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toContain(`missing charset`);
    expect(r.out).toContain(`${join(dir, "none.html")}:1`);
    expect(r.out).toContain(`${join(dir, "late.html")}:1`);
    expect(r.out).not.toContain("ok.html");
  });
  it("exits 2 when dist is missing", () => {
    expect(run(join(dir, "nope")).code).toBe(2);
  });
  it("ignores binary files", () => {
    put("img.png", Buffer.from("TODO {{ \0\x01"));
    put("font.woff2", Buffer.from("TODO"));
    expect(run().code).toBe(0);
  });
  it("caps output lines", () => {
    put("x.txt", Array.from({ length: 100 }, () => "TODO").join("\n"));
    const lines = run()
      .out.split("\n")
      .filter((l) => l.startsWith("::error"));
    expect(lines.length).toBeLessThanOrEqual(22);
  });
});
