// #1252: the local pair's opt-in T19 flag. Off, every generated config is
// byte for byte what it was before the flag existed (the fixtures were
// written from the unchanged code), so the red-line suite's own runs can't
// change. On, it adds only the release's assets block, HOSTED and
// Cloudflare's always-pass Turnstile test keys.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  localT19Of,
  requireT19Assets,
  T19_ASSETS,
  TURNSTILE_TEST_SECRET,
  TURNSTILE_TEST_SITE_KEY,
  t19Assets,
  wranglerConfig,
} from "../src/local-pair.ts";

const ROOT = resolve(import.meta.dirname, "..", "..", "..");
const I = {
  name: "rl-a",
  testDomain: "oa-redline-a.fyi",
  installId: "itestfixture0",
};
const FIXTURES = join(import.meta.dirname, "fixtures", "local-pair-config");
const text = (v: unknown) =>
  `${JSON.stringify(v, null, 2).split(ROOT).join("<root>")}\n`;
// .txt, not .json: the formatter would rewrite them, and they must stay
// exactly what JSON.stringify(config, null, 2) wrote before the flag.
const fixture = (name: string) =>
  readFileSync(join(FIXTURES, `${name}.txt`), "utf8");

describe("local pair config, T19 flag off", () => {
  it("is byte-identical to the config before the flag (base, google, d1)", () => {
    expect(text(wranglerConfig(I, 8787))).toBe(fixture("base-kv"));
    expect(text(wranglerConfig(I, 8787, undefined, "base", "kv", false))).toBe(
      fixture("base-kv"),
    );
    expect(text(wranglerConfig(I, 8787, undefined, "google"))).toBe(
      fixture("google-kv"),
    );
    expect(text(wranglerConfig(I, 8787, undefined, "base", "d1"))).toBe(
      fixture("base-d1"),
    );
  });

  it("REDLINE_LOCAL_T19: off unless exactly 1", () => {
    expect(localT19Of({})).toBe(false);
    expect(localT19Of({ REDLINE_LOCAL_T19: "" })).toBe(false);
    expect(localT19Of({ REDLINE_LOCAL_T19: "1" })).toBe(true);
    for (const v of ["true", "yes", "0", " 1"])
      expect(() => localT19Of({ REDLINE_LOCAL_T19: v })).toThrow(
        /REDLINE_LOCAL_T19/,
      );
  });
});

describe("local pair config, T19 flag on", () => {
  const on = wranglerConfig(I, 8787, undefined, "base", "kv", true) as Record<
    string,
    unknown
  > & { vars: Record<string, string> };
  const off = wranglerConfig(I, 8787) as Record<string, unknown> & {
    vars: Record<string, string>;
  };

  it("adds only assets, HOSTED and the Turnstile test keys", () => {
    const { assets, vars, ...rest } = on;
    const { vars: offVars, ...offRest } = off;
    expect(rest).toEqual(offRest);
    expect(assets).toEqual(t19Assets());
    expect(vars).toEqual({
      ...offVars,
      HOSTED: "1",
      TURNSTILE_SITE_KEY: TURNSTILE_TEST_SITE_KEY,
      TURNSTILE_SECRET: TURNSTILE_TEST_SECRET,
    });
  });

  it("uses only Cloudflare's published always-pass test keys", () => {
    expect(TURNSTILE_TEST_SITE_KEY).toBe("1x00000000000000000000AA");
    expect(TURNSTILE_TEST_SECRET).toBe("1x0000000000000000000000000000000AA");
  });

  it("the assets block is the release's, at apps/server/dist-assets", () => {
    // The release config (comments stripped, placeholders are strings).
    const raw = readFileSync(
      join(ROOT, "apps", "server", "wrangler.template.jsonc"),
      "utf8",
    );
    const json = raw
      .split("\n")
      .filter((l) => !/^\s*\/\//.test(l))
      .join("\n");
    const tpl = JSON.parse(json) as { assets: Record<string, unknown> };
    expect({ ...t19Assets(), directory: tpl.assets.directory }).toEqual(
      tpl.assets,
    );
    expect(T19_ASSETS).toBe(join(ROOT, "apps", "server", "dist-assets"));
  });

  it("fails clearly when apps/server/dist-assets isn't built", () => {
    const dir = mkdtempSync(join(tmpdir(), "t19-assets-"));
    try {
      expect(() => requireT19Assets(dir)).toThrow(
        /index\.html is missing; build the assets first with pnpm --filter @oa\/server build/,
      );
      writeFileSync(join(dir, "index.html"), "<!doctype html>");
      expect(() => requireT19Assets(dir)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
