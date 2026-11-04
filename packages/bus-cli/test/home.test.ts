import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { home, socketPath } from "../src/config.ts";
import { realCtx } from "../src/context.ts";

afterEach(() => vi.unstubAllEnvs());

describe("cli OA_BUS_HOME", () => {
  it("treats an empty OA_BUS_HOME as unset: ~/.oa-bus, never the cwd", () => {
    vi.stubEnv("OA_BUS_HOME", "");
    const def = join(homedir(), ".oa-bus");
    expect(home()).toBe(def);
    expect(socketPath()).toBe(
      join(realpathSync.native(homedir()), ".oa-bus", "daemon.sock"),
    );
    expect(realCtx(true).home).toBe(def);
  });
});
