import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  authorityWindows,
  EMBEDDED_ROOT,
  rootIsLive,
} from "../src/update/trusted-root.ts";

const DAY = 24 * 3600 * 1000;

describe("embedded Sigstore trust root", () => {
  it("is live today and records where it came from", () => {
    expect(rootIsLive(EMBEDDED_ROOT, new Date())).toBe(true);
    expect((EMBEDDED_ROOT._source as { sha256: string }).sha256).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  // Fails 30 days before any live key or CA chain runs out, so the refresh
  // (node scripts/refresh-trusted-root.mjs, then review the diff) happens
  // while releases still verify.
  it("has no live key or CA ending within 30 days", () => {
    const now = Date.now();
    const w = authorityWindows(EMBEDDED_ROOT);
    const ends: [string, Date][] = [];
    for (const [kind, list] of [
      ["tlog", w.tlogs],
      ["ctlog", w.ctlogs],
      ["ca", w.cas],
    ] as const) {
      for (const v of list)
        if (v.end && v.end.getTime() > now) ends.push([kind, v.end]);
    }
    w.caCerts.forEach((c, i) => {
      const ca = w.cas[i];
      if (ca?.end && ca.end.getTime() <= now) return; // retired
      for (const v of c.windows) if (v.end) ends.push(["ca cert", v.end]);
    });
    for (const [kind, end] of ends) {
      expect(
        end.getTime() - now,
        `${kind} ends ${end.toISOString()}: refresh the root`,
      ).toBeGreaterThan(30 * DAY);
    }
  });

  it("goes stale when every authority has ended", () => {
    expect(rootIsLive(EMBEDDED_ROOT, new Date("2100-01-01T00:00:00Z"))).toBe(
      false,
    );
  });
});

describe("pins are constants", () => {
  it("nothing in src/update reads the environment, install.json, machine.json or settings", () => {
    const dir = new URL("../src/update/", import.meta.url).pathname;
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts"))) {
      const text = readFileSync(join(dir, f), "utf8")
        .split("\n")
        .filter((l) => !l.trim().startsWith("//"))
        .join("\n");
      expect(text, f).not.toMatch(
        /process\.env|install\.json|machine\.json|settings\.json|\.npmrc/,
      );
    }
  });
});
