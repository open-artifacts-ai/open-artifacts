// The CLI as `pnpm oa:hosted` runs it: plain node with type stripping, no
// bundler. Vitest resolves `./x.js` to `./x.ts`; node does not, so only a
// real start catches a local import node can't load.
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");

it("node loads src/cli.ts and prints the help", () => {
  const out = execFileSync(process.execPath, ["src/cli.ts", "--help"], {
    cwd: pkg,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    timeout: 30_000,
  });
  expect(out).toContain("Usage: pnpm oa:hosted");
  expect(out).toContain("publish-release");
});
