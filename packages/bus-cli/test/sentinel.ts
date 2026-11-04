import { existsSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect } from "vitest";

/**
 * HOME and OA_BUS_HOME for every test that does not pass its own: the
 * service code resolves ~/Library/LaunchAgents and ~/.config/systemd/user
 * from HOME, so a unit written here is one a test forgot to point at a temp
 * home, and the file fails.
 */
export const SENTINEL_HOME = mkdtempSync(join(tmpdir(), "ob-cli-sentinel-"));
process.env.HOME = SENTINEL_HOME;
process.env.OA_BUS_HOME = join(SENTINEL_HOME, ".oa-bus");
// As on an installed machine: a writer that never creates ~/.oa-bus
// (the daemon's sent.json) must land here and trip, not fail quietly.
mkdirSync(process.env.OA_BUS_HOME, { mode: 0o700 });
delete process.env.XDG_CONFIG_HOME;

export const SERVICE_DIRS = ["Library/LaunchAgents", ".config/systemd/user"];

/** Files under the sentinel's service folders, as relative paths. */
export function serviceWrites(): string[] {
  return SERVICE_DIRS.flatMap((d) => {
    const dir = join(SENTINEL_HOME, d);
    return existsSync(dir)
      ? readdirSync(dir, { recursive: true }).map((f) => join(d, String(f)))
      : [];
  });
}

/** Files in the sentinel's ~/.oa-bus, as relative paths. */
export function openbusWrites(): string[] {
  return readdirSync(join(SENTINEL_HOME, ".oa-bus"), { recursive: true }).map(
    (f) => join(".oa-bus", String(f)),
  );
}

afterAll(() => {
  expect(serviceWrites()).toEqual([]);
  expect(openbusWrites()).toEqual([]);
});
