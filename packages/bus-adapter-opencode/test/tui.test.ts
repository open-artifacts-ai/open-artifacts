import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const PLUGIN = new URL("../assets/opencode-tui/tui.js", import.meta.url).href;

type Plugin = { id: string; setup: (api: unknown) => void };

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("opencode tui presence plugin", () => {
  it("lists each root session it opens in OA_BUS_HOME/opencode-tui/<pid>.json", async () => {
    vi.useFakeTimers();
    const home = mkdtempSync(join(tmpdir(), "ob-tui-"));
    vi.stubEnv("OA_BUS_HOME", home);
    const parents: Record<string, { parentID?: string }> = {
      ses_child: { parentID: "ses_root" },
      ses_root: {},
      ses_other: {},
    };
    let route: { type: string; sessionID?: string } = { type: "home" };
    const api = {
      ui: { router: { current: () => route } },
      data: { session: { get: (id: string) => parents[id] } },
    };
    const plugin = (await import(PLUGIN)).default as Plugin;
    expect(plugin.id).toBe("oa-bus.opencode.presence");
    plugin.setup(api);

    const file = join(home, "opencode-tui", `${process.pid}.json`);
    vi.advanceTimersByTime(500);
    expect(existsSync(file)).toBe(false); // home screen: nothing open

    route = { type: "session", sessionID: "ses_child" };
    vi.advanceTimersByTime(500);
    route = { type: "session", sessionID: "ses_other" };
    vi.advanceTimersByTime(500);
    const body = JSON.parse(readFileSync(file, "utf8"));
    expect(body).toMatchObject({
      pid: process.pid,
      sessionIDs: ["ses_root", "ses_other"],
    });
    // Written atomically: no temp file is left beside it.
    expect(readdirSync(join(home, "opencode-tui"))).toEqual([
      `${process.pid}.json`,
    ]);
  });

  it("treats an empty OA_BUS_HOME as unset: lists in ~/.oa-bus, never the cwd", async () => {
    vi.useFakeTimers();
    const home = mkdtempSync(join(tmpdir(), "ob-tui-h-"));
    vi.stubEnv("OA_BUS_HOME", "");
    vi.stubEnv("HOME", home);
    const api = {
      ui: { router: { current: () => ({ type: "session", sessionID: "s" }) } },
      data: { session: { get: () => ({}) } },
    };
    ((await import(PLUGIN)).default as Plugin).setup(api);
    vi.advanceTimersByTime(500);
    expect(
      existsSync(join(home, ".oa-bus", "opencode-tui", `${process.pid}.json`)),
    ).toBe(true);
  });
});
