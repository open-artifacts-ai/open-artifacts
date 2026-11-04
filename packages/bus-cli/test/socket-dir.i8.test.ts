// I8: the CLI dials the short socket folder without checking it first.
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shortSocketDir } from "@oa/bus-adapter-claude-code";
import { newMachineToken } from "@oa/bus-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { doctor } from "../src/commands/doctor.ts";
import { status as statusCmd } from "../src/commands/status.ts";
import { fakeCtx, status } from "./fake.ts";

const made: string[] = [];
afterEach(() => {
  for (const p of made.splice(0)) rmSync(p, { recursive: true, force: true });
});

/** A home too long for `<home>/daemon.sock`, so the socket is in the short folder. */
function longHome(): string {
  const h = join(mkdtempSync(join(tmpdir(), "ob-i8-long-")), "x".repeat(110));
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

describe("I8: an unsafe short socket folder", () => {
  it("status and doctor never take an answer from a socket in a folder another user can reach", async () => {
    // Another user made the folder first and listens in it: the daemon
    // refuses it, but whatever answers there is shown as the daemon.
    const home = longHome();
    const dir = shortSocketDir(home);
    mkdirSync(dir);
    chmodSync(dir, 0o777);
    for (const run of [statusCmd, doctor]) {
      const st = vi.fn(async (_req: { path: string }) => status());
      const ctx = fakeCtx({ home, status: st });
      await run(ctx);
      expect(st).not.toHaveBeenCalled();
    }
  });
});
