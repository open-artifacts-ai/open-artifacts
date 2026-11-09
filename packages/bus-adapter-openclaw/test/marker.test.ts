import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { HABITS_MARKER, markerOn, pluginDir } from "../src/singleton.ts";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "ocm-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

it("finds the folder holding openclaw.plugin.json from the file's own location, not cwd", () => {
  const bundle = tmp(); // the built shape: index.js beside the manifest
  writeFileSync(join(bundle, "openclaw.plugin.json"), "{}");
  expect(pluginDir(join(bundle, "index.js"))).toBe(bundle);
  const pkg = tmp(); // the source shape: src/ under the manifest
  mkdirSync(join(pkg, "src"));
  writeFileSync(join(pkg, "openclaw.plugin.json"), "{}");
  expect(pluginDir(join(pkg, "src", "singleton.ts"))).toBe(pkg);
});

it("is on only while the marker is a file in that folder, checked each time", () => {
  const d = tmp();
  const on = markerOn(d);
  expect(on()).toBe(false);
  writeFileSync(join(d, HABITS_MARKER), "");
  expect(on()).toBe(true);
  rmSync(join(d, HABITS_MARKER));
  expect(on()).toBe(false);
  mkdirSync(join(d, HABITS_MARKER)); // a folder of that name is not the marker
  expect(on()).toBe(false);
});
