import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { stampPi } from "../scripts/stamp.mjs";

const pi = readFileSync(
  new URL("../../bus-adapter-pi/assets/oa-bus.ts", import.meta.url),
  "utf8",
);

it("stamps the Pi extension's IPC marker with the given version (C23c)", () => {
  const out: string = stampPi(pi, "1.2.3-rc.4");
  expect(out).toContain('const CLIENT_VERSION = "1.2.3-rc.4";');
  expect(out).not.toContain('const CLIENT_VERSION = "0.0.0";');
  // Only the marker changes.
  expect(out.replace('"1.2.3-rc.4"', '"0.0.0"')).toBe(pi);
});

it("refuses an extension without the marker", () => {
  expect(() => stampPi("export {};", "1.2.3")).toThrow(/CLIENT_VERSION/);
});
