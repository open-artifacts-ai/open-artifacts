// C15 fix round 1: the short socket folder is checked before every bind.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  daemonSocketPath,
  MAX_SOCKET_PATH,
  shortSocketDir,
  socketBase,
} from "@oa/bus-adapter-claude-code";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareReturnDir } from "../src/config.ts";
import { ClaudeTransport } from "../src/transports/claude.ts";
import { daemonHarness, stopAll } from "./helpers.ts";

const prev = process.env.OA_BUS_HOME;
const made: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await stopAll();
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))),
  );
  if (prev === undefined) delete process.env.OA_BUS_HOME;
  else process.env.OA_BUS_HOME = prev;
  for (const p of made.splice(0)) rmSync(p, { recursive: true, force: true });
});

const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));

function longHome(): string {
  const h = join(tmp("ob-hl-"), "x".repeat(110));
  mkdirSync(h, { recursive: true });
  process.env.OA_BUS_HOME = h;
  made.push(shortSocketDir(h));
  return h;
}

const agent = {
  ref: "s1",
  kind: "claude-code",
  proposedName: "a",
  busName: "a",
  namespace: "n",
  global: false,
  pid: 1,
  cwd: "/",
  live: true,
} as const;

describe("I1: Claude return sockets in the short folder", () => {
  it("a folder recreated by someone else after start is refused, never bound in", async () => {
    const h = longHome();
    const dir = shortSocketDir(h);
    const ret = join(dir, "claude-return");
    // A cleaner removed ours; someone recreated it open to others.
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(dir, 0o755);
    const target = join(tmp("ob-hc-"), "c.sock");
    const claude = createServer((c) => c.destroy());
    await new Promise<void>((r) => claude.listen(target, () => r()));
    servers.push(claude);
    const t = new ClaudeTransport({
      socketsDir: ret,
      prepareDir: (d) => prepareReturnDir(d, h),
      statusWindowMs: 20,
      target: () => ({ socketPath: target, peerToken: "tok" }),
    });
    const out = await t.deliver(agent, {
      msg_id: "m1",
      from_name: "peer",
      namespace: "n",
      body: "hi",
    });
    await t.close();
    expect(out).toMatchObject({ ok: false, reason: "closed" });
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("I2: the short folder's base", () => {
  it("Linux prefers /run/user/<uid> when it is ours and 0700, else /tmp; macOS keeps /tmp", () => {
    const run = tmp("ob-run-");
    chmodSync(run, 0o700);
    expect(socketBase("linux", run)).toBe(run);
    expect(socketBase("darwin", run)).toBe("/tmp");
    expect(socketBase("linux", join(run, "missing"))).toBe("/tmp");
    chmodSync(run, 0o755);
    expect(socketBase("linux", run)).toBe("/tmp");
    const link = join(tmp("ob-runl-"), "l");
    chmodSync(run, 0o700);
    symlinkSync(run, link);
    expect(socketBase("linux", link)).toBe("/tmp");
  });
});

describe("M1, M2: one canonical home", () => {
  it("two spellings of one home through a symlink name the same socket", () => {
    const real = tmp("ob-hr-");
    const link = join(tmp("ob-hlk-"), "y".repeat(110));
    symlinkSync(real, link);
    expect(daemonSocketPath(link)).toBe(daemonSocketPath(real));
    expect(daemonSocketPath(real)).toBe(join(real, "daemon.sock"));
  });

  it("a case-insensitive volume gives one folder for both cases", () => {
    const h = join(tmp("ob-hcase-"), "Long".repeat(30));
    mkdirSync(h);
    const upper = h.toUpperCase();
    // Only meaningful where the file system ignores case (APFS default).
    if (!existsSync(upper)) return;
    expect(shortSocketDir(upper)).toBe(shortSocketDir(h));
  });
});

describe("M3: the daemon notices its socket is gone", () => {
  it("a removed or replaced socket calls onSocketLost", async () => {
    for (const replace of [false, true]) {
      const path = join(tmp("ob-hs-"), "d.sock");
      const lost = vi.fn();
      await daemonHarness({
        socketPath: path,
        socketCheckMs: 20,
        onSocketLost: lost,
      });
      unlinkSync(path);
      if (replace) {
        const other = createServer();
        await new Promise<void>((r) => other.listen(path, () => r()));
        servers.push(other);
      }
      await vi.waitFor(() => expect(lost).toHaveBeenCalledOnce());
      await stopAll();
    }
  });
});

describe("M4, M6: lasting failures at the socket path", () => {
  it("a regular file at the socket path is SOCKET_PATH (ENOTSOCK), not a restart loop", async () => {
    const path = join(tmp("ob-hf-"), "d.sock");
    writeFileSync(path, "");
    await expect(daemonHarness({ socketPath: path })).rejects.toMatchObject({
      code: "SOCKET_PATH",
    });
  });

  it("a regular file at the short folder is refused: not a folder", async () => {
    const h = longHome();
    writeFileSync(shortSocketDir(h), "");
    await expect(
      daemonHarness({ socketPath: undefined }),
    ).rejects.toMatchObject({
      code: "SOCKET_PATH",
      message: expect.stringContaining("is not a folder"),
    });
  });

  it("the limit is the platform's", () => {
    expect(MAX_SOCKET_PATH).toBe(process.platform === "linux" ? 107 : 103);
  });
});
