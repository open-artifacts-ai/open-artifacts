import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { BUS_CMD } from "@oa/bus-protocol";
import { expect, it } from "vitest";

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });

it("#1448 item 5: no bus package hard-codes the npx command; BUS_CMD is the one place", () => {
  const root = resolve(import.meta.dirname, "../..");
  const hits: string[] = [];
  for (const pkg of readdirSync(root).filter((n) => n.startsWith("bus-")))
    for (const f of walk(join(root, pkg, "src")))
      for (const line of readFileSync(f, "utf8").split("\n"))
        if (
          line.includes("npx @open-artifacts/bus") &&
          !/^\s*(\/\/|\*|\/\*)/.test(line) &&
          !f.endsWith("bus-protocol/src/meta.ts")
        )
          hits.push(`${f}: ${line.trim()}`);
  expect(hits).toEqual([]);
  expect(BUS_CMD).toBe("npx @open-artifacts/bus");
});
