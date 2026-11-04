import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { socketPath } from "../assets/oa-bus.ts";

afterEach(() => vi.unstubAllEnvs());

describe("pi extension daemon socket", () => {
  it("treats an empty OA_BUS_HOME as unset: ~/.oa-bus, never the cwd", () => {
    vi.stubEnv("OA_BUS_HOME", "");
    expect(socketPath()).toBe(
      join(realpathSync.native(homedir()), ".oa-bus", "daemon.sock"),
    );
  });
});
