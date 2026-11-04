// C15: a home too long for a unix socket never crash-loops the daemon.
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  busHome,
  daemonSocketPath,
  MAX_SOCKET_PATH,
  shortSocketDir,
} from "@oa/bus-adapter-claude-code";
import { connectDaemon } from "@oa/bus-ipc";
import { afterEach, describe, expect, it } from "vitest";
import { claudeReturnDir, socketPath } from "../src/config.ts";
import { daemonHarness, hello, stopAll } from "./helpers.ts";

const prev = process.env.OA_BUS_HOME;
const made: string[] = [];
afterEach(async () => {
  await stopAll();
  if (prev === undefined) delete process.env.OA_BUS_HOME;
  else process.env.OA_BUS_HOME = prev;
  for (const p of made.splice(0)) rmSync(p, { recursive: true, force: true });
});

/** A temp home over 104 bytes, set as OA_BUS_HOME; its short folder is cleaned up. */
function longHome(): string {
  const h = join(mkdtempSync(join(tmpdir(), "ob-long-")), "x".repeat(110));
  mkdirSync(h, { recursive: true });
  process.env.OA_BUS_HOME = h;
  made.push(shortSocketDir(h));
  return h;
}

describe("socket paths", () => {
  it("a short home keeps <home>/daemon.sock and <home>/claude-return", () => {
    // Canonical: /var/folders is /private/var/folders on macOS.
    const h = realpathSync(mkdtempSync(join(tmpdir(), "ob-short-")));
    expect(daemonSocketPath(h)).toBe(join(h, "daemon.sock"));
    expect(claudeReturnDir(h)).toBe(join(h, "claude-return"));
  });

  it("a long home moves both to one short per-user folder that fits", () => {
    const h = longHome();
    const dir = shortSocketDir(h);
    expect(dir).toMatch(
      // /tmp, or /run/user/<uid> on a Linux host that has one (CI does).
      new RegExp(
        `^(/tmp|/run/user/${process.getuid?.()})/oa-bus-${process.getuid?.()}-[0-9a-f]{8}$`,
      ),
    );
    expect(socketPath()).toBe(join(dir, "daemon.sock"));
    expect(claudeReturnDir()).toBe(join(dir, "claude-return"));
    expect(
      Buffer.byteLength(join(claudeReturnDir(), "00000000.sock")),
    ).toBeLessThanOrEqual(MAX_SOCKET_PATH);
  });

  it("names the same folder before and after the home exists", () => {
    const parent = mkdtempSync(join(tmpdir(), "ob-later-"));
    const h = join(parent, "y".repeat(110));
    const before = shortSocketDir(h);
    mkdirSync(h);
    expect(shortSocketDir(h)).toBe(before);
  });
});

describe("the daemon on a long home", () => {
  it("binds in the short folder (0700), and an adapter connects through the shared path", async () => {
    longHome();
    const h = await daemonHarness({ socketPath: undefined });
    const path = daemonSocketPath(busHome());
    expect(dirname(path)).toBe(shortSocketDir(busHome()));
    expect(readdirSync(dirname(path))).toContain("daemon.sock");
    expect(lstatSync(dirname(path)).mode & 0o777).toBe(0o700);
    const c = await connectDaemon({ path, hello: hello({ agent_ref: "A" }) });
    expect(c.welcome).toMatchObject({ type: "welcome" });
    c.close();
    expect(h.daemon).toBeDefined();
  });

  it("refuses a short folder open to other users: a lasting SOCKET_PATH failure", async () => {
    const dir = shortSocketDir(longHome());
    mkdirSync(dir);
    chmodSync(dir, 0o755);
    await expect(
      daemonHarness({ socketPath: undefined }),
    ).rejects.toMatchObject({
      code: "SOCKET_PATH",
      message: expect.stringContaining("open to other users"),
    });
    expect(readdirSync(dir)).toEqual([]);
  });

  it("refuses a symlinked short folder and never follows it", async () => {
    const dir = shortSocketDir(longHome());
    const target = mkdtempSync(join(tmpdir(), "ob-target-"));
    made.push(target);
    symlinkSync(target, dir);
    await expect(
      daemonHarness({ socketPath: undefined }),
    ).rejects.toMatchObject({
      code: "SOCKET_PATH",
      message: expect.stringContaining("is a symlink"),
    });
    expect(readdirSync(target)).toEqual([]);
  });

  it("a socket path too long even so is a lasting SOCKET_PATH failure", async () => {
    const p = join(mkdtempSync(join(tmpdir(), "ob-toolong-")), "z".repeat(120));
    await expect(daemonHarness({ socketPath: p })).rejects.toMatchObject({
      code: "SOCKET_PATH",
    });
    expect(existsSync(p)).toBe(false);
  });
});
