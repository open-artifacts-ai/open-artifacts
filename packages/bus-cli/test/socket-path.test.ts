// C15: status, doctor and purge find the daemon's short socket folder.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonSocketPath, shortSocketDir } from "@oa/bus-adapter-claude-code";
import { runDaemon, StartError } from "@oa/bus-daemon";
import { newMachineToken } from "@oa/bus-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { daemon } from "../src/commands/daemon.ts";
import { doctor } from "../src/commands/doctor.ts";
import { status as statusCmd } from "../src/commands/status.ts";
import { purge } from "../src/steps/purge.ts";
import { fakeCtx, status, transcript } from "./fake.ts";

const made: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))),
  );
  for (const p of made.splice(0)) rmSync(p, { recursive: true, force: true });
});

/** A home over 104 bytes holding machine.json; its short folder is cleaned up. */
function longHome(): string {
  const h = join(mkdtempSync(join(tmpdir(), "ob-cl-long-")), "x".repeat(110));
  mkdirSync(h, { recursive: true });
  writeFileSync(
    join(h, "machine.json"),
    JSON.stringify({
      hub: "https://bus.example.com",
      machine_id: "m",
      label: "laptop",
      machine_token: newMachineToken(),
    }),
    { mode: 0o600 },
  );
  made.push(shortSocketDir(h));
  return h;
}

const listen = async (path: string) => {
  const s = createServer();
  await new Promise<void>((r) => s.listen(path, () => r()));
  servers.push(s);
};

describe("a long OA_BUS_HOME", () => {
  it("status and doctor dial the short folder's socket", async () => {
    const home = longHome();
    const want = join(shortSocketDir(home), "daemon.sock");
    for (const run of [statusCmd, doctor]) {
      const st = vi.fn(async (_req: { path: string }) => status());
      const ctx = fakeCtx({ home, status: st });
      await run(ctx);
      expect(st.mock.calls[0]?.[0]).toMatchObject({ path: want });
    }
  });

  it("doctor names an unsafe short folder and how to fix it", async () => {
    const home = longHome();
    const dir = shortSocketDir(home);
    mkdirSync(dir);
    chmodSync(dir, 0o755);
    const ctx = fakeCtx({ home });
    expect(await doctor(ctx)).toBe(1);
    expect(ctx.all()).toEqual(
      expect.arrayContaining(
        ctx.copy.socketFolderUnsafe(
          dir,
          "is open to other users (mode 755)",
        ) as string[],
      ),
    );
  });

  it("purge removes the short folder's sockets and the folder", async () => {
    const home = longHome();
    const dir = shortSocketDir(home);
    mkdirSync(join(dir, "claude-return"), { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    await listen(join(dir, "daemon.sock"));
    await listen(join(dir, "claude-return", "ab12cd34.sock"));
    const out = purge(home, { isDefault: false });
    expect(out).toMatchObject({ leftDir: false });
    expect(existsSync(dir)).toBe(false);
  });

  it("purge never follows a symlinked short folder", async () => {
    const home = longHome();
    const target = mkdtempSync(join(tmpdir(), "ob-cl-target-"));
    made.push(target);
    writeFileSync(join(target, "daemon.sock"), "");
    symlinkSync(target, shortSocketDir(home));
    purge(home, { isDefault: false });
    expect(existsSync(join(target, "daemon.sock"))).toBe(true);
  });

  it("under a service, a socket it cannot bind exits 0 (no restart loop); in a terminal, 1", async () => {
    const path = join(
      mkdtempSync(join(tmpdir(), "ob-cl-sock-")),
      "z".repeat(120),
    );
    for (const [env, code] of [
      [{ OA_BUS_SERVICE: "1" }, 0],
      [{}, 1],
    ] as const) {
      const ctx = fakeCtx({ env });
      let err: unknown;
      const exit = await daemon(
        ctx,
        (deps) =>
          runDaemon({
            ...deps,
            config: {
              hub: "wss://bus.example.com",
              machine_id: "m1",
              label: "laptop",
              machine_token: "oa_machine_SECRETSECRETSECRET",
            },
            socketPath: path,
          }).catch((e) => {
            err = e;
            throw e;
          }),
        new (await import("node:events")).EventEmitter() as never,
      );
      expect(err).toBeInstanceOf(StartError);
      expect(err).toMatchObject({ code: "SOCKET_PATH" });
      expect(exit).toBe(code);
    }
  });

  it("doctor checks the folder when only the Claude return sockets are in it (M5)", async () => {
    // A home where daemon.sock fits and claude-return/<8 hex>.sock does not.
    const base = realpathSync(mkdtempSync(join(tmpdir(), "ob-cl-mid-")));
    const pad = 85 - Buffer.byteLength(base) - 1;
    const home = join(base, "m".repeat(pad));
    mkdirSync(home);
    made.push(shortSocketDir(home));
    expect(daemonSocketPath(home)).toBe(join(home, "daemon.sock"));
    const dir = shortSocketDir(home);
    mkdirSync(dir);
    chmodSync(dir, 0o755);
    const ctx = fakeCtx({ home });
    expect(await doctor(ctx)).toBe(1);
    expect(ctx.all()).toEqual(
      expect.arrayContaining(
        ctx.copy.socketFolderUnsafe(
          dir,
          "is open to other users (mode 755)",
        ) as string[],
      ),
    );
  });

  it("another user's folder is not ours to remove: the copy says to ask an admin (I2)", () => {
    const c = fakeCtx().copy;
    const lines = c.socketFolderNotYours("/tmp/oa-bus-501-abcd1234");
    expect(lines.join("\n")).toContain("sudo rm -r /tmp/oa-bus-501-abcd1234");
    expect(lines.join("\n")).not.toMatch(/^\s*Remove it/m);
  });

  it("a SOCKET_PATH start failure in a terminal prints designed copy, not the raw message (M6)", async () => {
    const ctx = fakeCtx();
    const e = new StartError(
      "SOCKET_PATH",
      "/tmp/oa-bus-501-abcd1234 is a symlink; refusing to use it",
    );
    const code = await daemon(
      ctx,
      async () => {
        throw e;
      },
      new (await import("node:events")).EventEmitter() as never,
    );
    expect(code).toBe(1);
    expect(ctx.err()).toEqual(transcript("## 1. First run, browser opens")[2]);
  });
});
