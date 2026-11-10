import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { root } from "./stubs.ts";

type Rl = {
  name: string;
  namespace_id: string;
  simple: { limit: number; period: number };
};
type Cfg = { ratelimits?: Rl[]; env?: { staging?: { ratelimits?: Rl[] } } };
const parse = (f: string): Cfg =>
  JSON.parse(
    readFileSync(join(root, "apps/server", f), "utf8")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/,(\s*[}\]])/g, "$1"),
  );
const configs: [string, (c: Cfg) => Rl[]][] = [
  ["wrangler.template.jsonc", (c) => c.ratelimits ?? []],
  ["wrangler.staging.jsonc", (c) => c.env?.staging?.ratelimits ?? []],
  ["wrangler.test.jsonc", (c) => c.ratelimits ?? []],
];

describe("ratelimit bindings", () => {
  for (const [file, get] of configs) {
    it(`${file} binds RL_ANON (30/60 s), RL_ANON_WRITES (120/60 s, 4x) and RL_AUTH (20/60 s) on distinct namespaces`, () => {
      const rl = get(parse(file));
      const by = Object.fromEntries(rl.map((r) => [r.name, r]));
      expect(by.RL_ANON?.simple).toEqual({ limit: 30, period: 60 });
      expect(by.RL_ANON_WRITES?.simple).toEqual({ limit: 120, period: 60 });
      expect(by.RL_AUTH?.simple).toEqual({ limit: 20, period: 60 });
      const ids = rl.map((r) => r.namespace_id);
      expect(new Set(ids).size).toBe(ids.length);
      // Hosted installs get their own ids from 1,000,000 up; literals stay below.
      for (const id of ids) expect(Number(id)).toBeLessThan(1_000_000);
    });
  }
});
