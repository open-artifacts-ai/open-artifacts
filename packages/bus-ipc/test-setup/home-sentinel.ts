import { mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect } from "vitest";

/**
 * A vitest setupFile for the client packages: HOME and OA_BUS_HOME point at
 * a fresh, empty dir for each test file, so anything that resolves ~/.oa-bus,
 * ~/.claude or ~/.config without a test's own temp home lands here, and the
 * file fails. A test that brings its own temp home writes there instead.
 */
export const SENTINEL_HOME = mkdtempSync(join(tmpdir(), "oa-bus-home-sentinel-"));
process.env.HOME = SENTINEL_HOME;
process.env.OA_BUS_HOME = join(SENTINEL_HOME, ".oa-bus");
// As on an installed machine: code that writes into an existing ~/.oa-bus
// without creating it (sent.json, held files) must trip too.
mkdirSync(process.env.OA_BUS_HOME, { mode: 0o700 });
delete process.env.XDG_CONFIG_HOME;
delete process.env.OA_BUS_CLAUDE_SESSIONS_DIR;

/** What landed in the sentinel home, as relative paths; the empty ~/.oa-bus is ours. */
export const sentinelWrites = (): string[] =>
  readdirSync(SENTINEL_HOME, { recursive: true })
    .map(String)
    .filter((f) => f !== ".oa-bus")
    .sort();

afterAll(() => expect(sentinelWrites()).toEqual([]));
