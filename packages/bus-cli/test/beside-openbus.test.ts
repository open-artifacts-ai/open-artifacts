// The new client runs beside the old OpenBus daemon while our machines switch
// (design: The open-bus repo, package and issues). Nothing it owns may share a
// name or a path with OpenBus's.
import { homedir } from "node:os";
import { join } from "node:path";
import {
  busHome,
  daemonSocketPath,
  shortSocketDir,
} from "@oa/bus-adapter-claude-code";
import { CODEX_TOOL_NAMESPACE } from "@oa/bus-daemon";
import { CONFIG_FILE } from "@oa/bus-protocol";
import { describe, expect, it } from "vitest";
import { HARNESS_ENTRY } from "../src/steps/adapters.ts";
import { CODEX_ENTRY } from "../src/steps/codex.ts";
import { LAUNCHD_LABEL, SYSTEMD_UNIT } from "../src/steps/service.ts";

/** OpenBus 0.63.0's own names (open-bus packages/cli, daemon, shared). */
const OPENBUS = {
  home: join(homedir(), ".openbus"),
  homeEnv: "OPENBUS_HOME",
  shortDirPrefix: "openbus-",
  launchd: "ai.open-bus.daemon",
  systemd: "open-bus.service",
  entry: "openbus",
  config: ".openbus.json",
};

describe("beside OpenBus", () => {
  it("has its own home, and ignores OPENBUS_HOME", () => {
    expect(busHome({})).toBe(join(homedir(), ".oa-bus"));
    expect(busHome({})).not.toBe(OPENBUS.home);
    expect(busHome({ [OPENBUS.homeEnv]: "/elsewhere" })).toBe(
      join(homedir(), ".oa-bus"),
    );
  });

  it("listens on its own socket, short folder included", () => {
    const home = busHome({});
    expect(daemonSocketPath(home)).not.toBe(daemonSocketPath(OPENBUS.home));
    expect(shortSocketDir(home).split("/").at(-1)).toMatch(/^oa-bus-\d+-/);
    expect(shortSocketDir(home).split("/").at(-1)).not.toMatch(
      new RegExp(`^${OPENBUS.shortDirPrefix}`),
    );
  });

  it("installs its own service", () => {
    expect(LAUNCHD_LABEL).toBe("com.open-artifacts.bus");
    expect(SYSTEMD_UNIT).toBe("oa-bus.service");
    expect(LAUNCHD_LABEL).not.toBe(OPENBUS.launchd);
    expect(SYSTEMD_UNIT).not.toBe(OPENBUS.systemd);
  });

  it("registers its own harness entry, and Codex tool namespace", () => {
    expect(HARNESS_ENTRY).toBe("oa_bus");
    expect(CODEX_ENTRY).toBe(HARNESS_ENTRY);
    expect(CODEX_TOOL_NAMESPACE).toBe(`mcp__${HARNESS_ENTRY}`);
    expect(HARNESS_ENTRY).not.toBe(OPENBUS.entry);
  });

  it("reads its own repo config file", () => {
    expect(CONFIG_FILE).toBe(".oa-bus.json");
    expect(CONFIG_FILE).not.toBe(OPENBUS.config);
  });
});
