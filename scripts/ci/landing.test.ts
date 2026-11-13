import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { root, sandbox, script, write } from "./stubs.ts";

describe("landing-gate.sh", () => {
  const gate = (exists: boolean) => {
    const sb = sandbox({});
    const cfg = join(sb.dir, "wrangler.jsonc");
    if (exists) write(cfg, "{}");
    const out = join(sb.dir, "out");
    write(out, "");
    const r = sb.run(["bash", script("landing-gate.sh")], {
      env: { LANDING_CONFIG: cfg, GITHUB_OUTPUT: out },
    });
    return { code: r.code, out: readFileSync(out, "utf8") };
  };
  it("reports present=true when the landing app exists", () => {
    expect(gate(true)).toEqual({ code: 0, out: "present=true\n" });
  });
  it("reports present=false otherwise", () => {
    expect(gate(false)).toEqual({ code: 0, out: "present=false\n" });
  });
});

describe("check-landing-dist.ts (release gate)", () => {
  const check = (html: string) => {
    const sb = sandbox({});
    write(join(sb.dir, "dist/index.html"), html);
    return sb.run([
      "node",
      join(root, "scripts/ops/check-landing-dist.ts"),
      join(sb.dir, "dist"),
    ]);
  };
  it("passes on a clean dist", () => {
    expect(
      check(
        '<head><meta charset="utf-8"></head><h1>Open Artifacts</h1><a href="https://signup.example.com/">Log in</a><a href="https://signup.example.com/">Sign up</a>',
      ).code,
    ).toBe(0);
  });
  it("fails when the home page has no sign-up link, or one that goes to #pricing", () => {
    const head = '<head><meta charset="utf-8"></head><h1>Open Artifacts</h1>';
    expect(check(head).code).toBe(1);
    expect(check(`${head}<a href="#pricing">Sign up</a>`).code).toBe(1);
  });
  it("fails on a TODO", () => {
    expect(check("<p>TODO</p>").code).toBe(1);
  });
});

describe("landing-preview-url.sh", () => {
  // Real-looking `wrangler preview --json` stdout, banner included.
  const banner =
    " ⛅️ wrangler 4.45.0\n───────────────────\nUploading assets...\n";
  const json = (url: string) =>
    `{\n  "preview": {\n    "name": "pr-7",\n    "urls": [\n      "${url}"\n    ]\n  }\n}\n`;
  const preview = (stdout: string) => {
    const sb = sandbox({ pnpm: 'printf %s "$WRANGLER_OUT"' });
    const out = join(sb.dir, "gh-out");
    write(out, "");
    const r = sb.run(["bash", script("landing-preview-url.sh"), "7"], {
      env: { GITHUB_OUTPUT: out, WRANGLER_OUT: stdout },
    });
    return { ...r, sb, output: readFileSync(out, "utf8") };
  };
  it("extracts the URL after the banner", () => {
    const r = preview(banner + json("https://pr-7.example.workers.dev"));
    expect(r.code).toBe(0);
    expect(r.output).toBe("url=https://pr-7.example.workers.dev\n");
    expect(r.sb.log()).toEqual([
      "pnpm exec wrangler preview --name pr-7 --json",
    ]);
  });
  it("fails and dumps raw output when no URL is found", () => {
    const r = preview(`${banner}{ "preview": { "urls": [] } }\n`);
    expect(r.code).toBe(1);
    expect(r.out).toContain("could not parse preview URL");
    expect(r.output).toBe("");
  });
});
