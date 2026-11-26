import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createSkillRefresher,
  readSkillVersion,
  writeSkillVersion,
} from "../src/skill-refresh.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createSkillRefresher", () => {
  it("runs and stores version when server_version differs from stored", async () => {
    let stored: string | undefined = "1.0.0";
    const logs: string[] = [];
    const run = vi.fn(async () => 0);
    const refresher = createSkillRefresher({
      readStored: () => stored,
      writeStored: (v) => {
        stored = v;
      },
      run,
      log: (m) => logs.push(m),
    });

    await refresher.refresh("1.1.0");
    expect(run).toHaveBeenCalledTimes(1);
    expect(stored).toBe("1.1.0");
    expect(logs).toEqual([]);
  });

  it("does nothing when server_version matches stored", async () => {
    const run = vi.fn(async () => 0);
    const writeStored = vi.fn();
    const refresher = createSkillRefresher({
      readStored: () => "1.1.0",
      writeStored,
      run,
      log: vi.fn(),
    });

    await refresher.refresh("1.1.0");
    expect(run).not.toHaveBeenCalled();
    expect(writeStored).not.toHaveBeenCalled();
  });

  it("does nothing when server_version is empty or missing", async () => {
    const run = vi.fn(async () => 0);
    const writeStored = vi.fn();
    const refresher = createSkillRefresher({
      readStored: () => undefined,
      writeStored,
      run,
      log: vi.fn(),
    });

    await refresher.refresh("");
    await refresher.refresh("   ");
    await refresher.refresh(undefined);
    expect(run).not.toHaveBeenCalled();
    expect(writeStored).not.toHaveBeenCalled();
  });

  it("does not store and logs one line when run exits non-zero", async () => {
    let stored: string | undefined = "1.0.0";
    const logs: string[] = [];
    const run = vi.fn(async () => 1);
    const refresher = createSkillRefresher({
      readStored: () => stored,
      writeStored: (v) => {
        stored = v;
      },
      run,
      log: (m) => logs.push(m),
    });

    await refresher.refresh("1.1.0");
    expect(run).toHaveBeenCalledTimes(1);
    expect(stored).toBe("1.0.0");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("1.1.0");
  });

  it("does not store and logs one line when run rejects", async () => {
    let stored: string | undefined;
    const logs: string[] = [];
    const run = vi.fn(async () => {
      throw new Error("spawn failed");
    });
    const refresher = createSkillRefresher({
      readStored: () => stored,
      writeStored: (v) => {
        stored = v;
      },
      run,
      log: (m) => logs.push(m),
    });

    await refresher.refresh("1.2.0");
    expect(stored).toBeUndefined();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("spawn failed");
  });

  it("does not start a second refresh while one is in flight", async () => {
    let stored: string | undefined;
    const d = deferred<number>();
    const run = vi.fn(() => d.promise);
    const refresher = createSkillRefresher({
      readStored: () => stored,
      writeStored: (v) => {
        stored = v;
      },
      run,
      log: vi.fn(),
    });

    const first = refresher.refresh("1.1.0");
    const second = refresher.refresh("1.2.0");
    expect(run).toHaveBeenCalledTimes(1);
    await second;
    expect(stored).toBeUndefined();

    d.resolve(0);
    await first;
    expect(stored).toBe("1.1.0");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("onHello only refreshes on the main lane", async () => {
    let stored: string | undefined;
    const run = vi.fn(async () => 0);
    const refresher = createSkillRefresher({
      readStored: () => stored,
      writeStored: (v) => {
        stored = v;
      },
      run,
      log: vi.fn(),
    });

    await refresher.onHello(false, "1.1.0");
    expect(run).not.toHaveBeenCalled();
    expect(stored).toBeUndefined();

    await refresher.onHello(true, "1.1.0");
    expect(run).toHaveBeenCalledTimes(1);
    expect(stored).toBe("1.1.0");
  });
});

describe("refresh limits (#3203 review)", () => {
  it("ignores a version that is not a plain release string", async () => {
    const run = vi.fn(async () => 0);
    const r = createSkillRefresher({
      readStored: () => undefined,
      writeStored: vi.fn(),
      run,
      log: vi.fn(),
    });
    await r.refresh("1.0.0\nforged log line");
    await r.refresh("x".repeat(65));
    await r.refresh("\u001b[31m1.0");
    expect(run).not.toHaveBeenCalled();
  });

  it("tries a failed version once per daemon, and a new version again", async () => {
    const run = vi.fn(async () => 1);
    const logs: string[] = [];
    const r = createSkillRefresher({
      readStored: () => undefined,
      writeStored: vi.fn(),
      run,
      log: (m) => logs.push(m),
    });
    await r.refresh("2.0.0");
    await r.refresh("2.0.0");
    await r.refresh("2.0.0");
    expect(run).toHaveBeenCalledTimes(1);
    expect(logs).toHaveLength(1);
    await r.refresh("2.0.1");
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe("skill-version file helpers", () => {
  it("writes mode 0600 and reads back the stored version", () => {
    const dir = mkdtempSync(join(tmpdir(), "oa-skill-ver-"));
    const file = join(dir, "skill-version");
    expect(readSkillVersion(file)).toBeUndefined();

    writeSkillVersion(file, "0.106.0");
    expect(readSkillVersion(file)).toBe("0.106.0");
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });
});
