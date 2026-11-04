import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonSocketPath } from "@oa/bus-adapter-claude-code";
import { afterEach, describe, expect, it, vi } from "vitest";
import { socketPath } from "../assets/oa-bus.ts";

afterEach(() => vi.unstubAllEnvs());

const block = (url: URL) => {
  const s = readFileSync(url, "utf8");
  const start = s.indexOf("// <socket-path>");
  const end = s.indexOf("// </socket-path>");
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return s.slice(start, end);
};

describe("pi extension socket path", () => {
  it("is a byte-identical copy of the shared one", () => {
    expect(block(new URL("../assets/oa-bus.ts", import.meta.url))).toBe(
      block(new URL("../../bus-adapter-claude-code/src/socket-path.ts", import.meta.url)),
    );
  });

  it("names the same path as the shared function, short or long home", () => {
    const short = mkdtempSync(join(tmpdir(), "ob-pi-s-"));
    for (const h of [short, join(short, "x".repeat(110))]) {
      vi.stubEnv("OA_BUS_HOME", h);
      expect(socketPath()).toBe(daemonSocketPath(h));
    }
    // /tmp, or /run/user/<uid> on a Linux host that has one (CI does).
    expect(socketPath()).toMatch(
      /^(\/tmp|\/run\/user\/\d+)\/oa-bus-\d+-[0-9a-f]{8}\/daemon\.sock$/,
    );
  });
});
