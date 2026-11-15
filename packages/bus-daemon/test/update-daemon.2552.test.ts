import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  currentVersion,
  installVersion,
  readPolicy,
  readReports,
  setPending,
  writeState,
} from "../src/index.ts";
import { daemonHarness, stopAll } from "./helpers.ts";

afterEach(async () => {
  await stopAll();
  delete process.env.OA_BUS_HOME;
});

/** A home on 1.0.0 whose daemon is the 1.1.0 folder, a switch pending. */
function switched() {
  const home = mkdtempSync(join(tmpdir(), "oa-ud-"));
  process.env.OA_BUS_HOME = home;
  const fill = (v: string) => (dir: string) => {
    mkdirSync(join(dir, "dist"));
    writeFileSync(join(dir, "dist/index.js"), `// ${v}\n`);
  };
  installVersion(home, "1.0.0", fill("1.0.0"));
  installVersion(home, "1.1.0", fill("1.1.0"));
  writeState(home, { armed: true, current: "1.0.0", previous: "1.0.0" });
  setPending(home, { from: "1.0.0", to: "1.1.0", startedAt: Date.now() });
  return { home, entry: join(home, "bin/dist/index.js") };
}
const every = (fn: () => void, ms: number) => {
  const t = setInterval(fn, Math.min(ms, 20));
  return () => clearInterval(t);
};

describe("the daemon's self-check after a switch (#2552)", () => {
  it("hub link, hello_ok and the agents announced: the new version stays", async () => {
    const w = switched();
    const exit = vi.fn();
    const h = await daemonHarness({
      update: { entryFile: w.entry, exit, every, deadlineMs: 5000 },
    });
    expect(readPolicy(w.home).pending).toBeDefined();
    h.toDaemon({
      id: "w",
      type: "hello_ok",
      machine_id: "1".repeat(16),
      machine_label: "laptop",
      server_version: "1.1.0",
    });
    await vi.waitFor(() => expect(readPolicy(w.home).pending).toBeUndefined());
    expect(readPolicy(w.home).newestRun).toBe("1.1.0");
    expect(readReports(w.home)).toMatchObject([{ event: "updated" }]);
    expect(currentVersion(w.home)).toBe("1.1.0");
    expect(exit).not.toHaveBeenCalled();
  });

  it("a link that never says hello_ok within the deadline steps back and exits 1", async () => {
    const w = switched();
    const exit = vi.fn();
    await daemonHarness({
      update: { entryFile: w.entry, exit, every, deadlineMs: 150 },
    });
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(currentVersion(w.home)).toBe("1.0.0");
    expect(readPolicy(w.home).failed).toEqual([]);
    expect(readPolicy(w.home).refused["1.1.0"]).toBeDefined();
    expect(readReports(w.home)).toMatchObject([{ event: "stepped_back" }]);
  });

  it("with no update deps (every other caller) nothing reads update.json", async () => {
    const w = switched();
    const exit = vi.fn();
    await daemonHarness({});
    await new Promise((r) => setTimeout(r, 100));
    expect(exit).not.toHaveBeenCalled();
    expect(readPolicy(w.home).pending).toBeDefined();
  });

  it("the loop stays off: an armed daemon with a staged version never switches", async () => {
    const w = switched();
    const exit = vi.fn();
    const h = await daemonHarness({
      update: { entryFile: w.entry, exit, every, deadlineMs: 5000 },
    });
    h.toDaemon({
      id: "w",
      type: "hello_ok",
      machine_id: "1".repeat(16),
      machine_label: "laptop",
      server_version: "1.1.0",
    });
    await vi.waitFor(() => expect(readPolicy(w.home).pending).toBeUndefined());
    expect(h.daemon.updater).toBeDefined();
    expect(await h.daemon.updater?.instruct({ version: "1.2.0" })).toEqual({
      kind: "disabled",
    });
    expect(exit).not.toHaveBeenCalled();
  });
});
