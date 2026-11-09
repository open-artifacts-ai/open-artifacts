// #1690: on Windows Hermes's default home is %LOCALAPPDATA%\hermes, not ~/.hermes
// (hermes_constants.py _platform_default_hermes_home). Paths here are posix-style
// because the tests run anywhere; only the platform argument is under test.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  hermesEnv,
  hermesHome,
  hermesPluginDir,
  hermesPluginDirs,
  hermesRoot,
} from "../src/steps/hermes.ts";

const W = "win32" as const;

describe("hermes home on Windows", () => {
  it("defaults to LOCALAPPDATA/hermes", () => {
    const env = { LOCALAPPDATA: "/L" };
    expect(hermesHome("/h", env, W)).toBe(join("/L", "hermes"));
    expect(hermesRoot("/h", env, W)).toBe(join("/L", "hermes"));
    expect(hermesPluginDir("/h", env, W)).toBe(
      join("/L", "hermes", "plugins", "oa-bus"),
    );
    expect(hermesEnv("/h", env, W)).toEqual({
      HERMES_HOME: join("/L", "hermes"),
    });
  });

  it.each([
    ["unset", {}],
    ["blank", { LOCALAPPDATA: "  " }],
  ])(
    "falls back to <home>/AppData/Local/hermes when LOCALAPPDATA is %s",
    (_n, env) => {
      const want = join("/h", "AppData", "Local", "hermes");
      expect(hermesHome("/h", env, W)).toBe(want);
      expect(hermesRoot("/h", env, W)).toBe(want);
    },
  );

  it("lets HERMES_HOME win, outside or inside the default", () => {
    const env = { LOCALAPPDATA: "/L", HERMES_HOME: "/opt/data" };
    expect(hermesHome("/h", env, W)).toBe("/opt/data");
    expect(hermesRoot("/h", env, W)).toBe("/opt/data");
    // Under the Windows default, that default is the root.
    const under = { LOCALAPPDATA: "/L", HERMES_HOME: "/L/hermes/custom" };
    expect(hermesRoot("/h", under, W)).toBe(join("/L", "hermes"));
    // ~/.hermes is not special on Windows.
    const posix = { LOCALAPPDATA: "/L", HERMES_HOME: "/h/.hermes" };
    expect(hermesRoot("/h", posix, W)).toBe("/h/.hermes");
  });

  it("keeps the active folder in hermesPluginDirs", () => {
    const env = { LOCALAPPDATA: "/L", HERMES_HOME: "/L/hermes/custom" };
    expect(hermesPluginDirs("/h", env, W)).toEqual([
      join("/L", "hermes", "plugins", "oa-bus"),
      join("/L", "hermes", "custom", "plugins", "oa-bus"),
    ]);
  });
});

describe("hermes home off Windows is unchanged", () => {
  it.each(["linux", "darwin"] as const)("%s keeps ~/.hermes", (p) => {
    const env = { LOCALAPPDATA: "/L" };
    expect(hermesHome("/h", env, p)).toBe("/h/.hermes");
    expect(hermesRoot("/h", env, p)).toBe("/h/.hermes");
    expect(hermesPluginDir("/h", env, p)).toBe("/h/.hermes/plugins/oa-bus");
  });
  it("defaults to the running platform", () => {
    expect(hermesHome("/h", { LOCALAPPDATA: "/L" })).toBe(
      process.platform === "win32" ? join("/L", "hermes") : "/h/.hermes",
    );
  });
});
