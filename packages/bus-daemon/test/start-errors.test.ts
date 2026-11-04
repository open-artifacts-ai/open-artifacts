import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newMachineToken } from "@oa/bus-protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  readConfig,
  revokedMarker,
  START_ERROR_CODES,
  StartError,
} from "../src/config.ts";
import { daemonHarness, stopAll } from "./helpers.ts";

const prev = { home: process.env.OA_BUS_HOME, hub: process.env.OA_BUS_INSTANCE };
afterEach(async () => {
  for (const [k, v] of [
    ["OA_BUS_HOME", prev.home],
    ["OA_BUS_INSTANCE", prev.hub],
  ] as const)
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  await stopAll();
});

/** readConfig on a temp home holding `json` (or no machine.json) at `mode`. */
function codeOf(json?: unknown, mode = 0o600): string | undefined {
  const dir = mkdtempSync(join(tmpdir(), "ob-start-"));
  if (json !== undefined) {
    writeFileSync(join(dir, "machine.json"), JSON.stringify(json));
    chmodSync(join(dir, "machine.json"), mode);
  }
  process.env.OA_BUS_HOME = dir;
  try {
    readConfig();
  } catch (e) {
    expect(e).toBeInstanceOf(StartError);
    return (e as StartError).code;
  }
  return undefined;
}

const ok = { hub: "wss://bus.example.com", machine_token: newMachineToken() };

describe("lasting start failures carry a stable code", () => {
  it("readConfig: each refusal has its code", () => {
    expect(codeOf()).toBe("NOT_LOGGED_IN");
    expect(codeOf({ hub: ok.hub })).toBe("NOT_LOGGED_IN");
    expect(codeOf({ ...ok, machine_token: "nope" })).toBe("NOT_LOGGED_IN");
    expect(codeOf(ok, 0o644)).toBe("CREDENTIALS_OPEN");
    expect(codeOf({ ...ok, hub: "ws://bus.example.com" })).toBe("BAD_HUB");
    expect(codeOf(ok, 0o000)).toBe(
      process.getuid?.() === 0 ? undefined : "CREDENTIALS_UNREADABLE",
    );
    process.env.OA_BUS_INSTANCE = "wss://other.example.com";
    expect(codeOf(ok)).toBe("HUB_MISMATCH");
    delete process.env.OA_BUS_INSTANCE;
    expect(codeOf(ok)).toBeUndefined();
  });

  it("readConfig: the revoked marker for machine.json's token is REVOKED; one for another token is stale", () => {
    const dir = mkdtempSync(join(tmpdir(), "ob-start-"));
    const token = newMachineToken();
    writeFileSync(
      join(dir, "machine.json"),
      JSON.stringify({
        hub: "https://bus.example.com",
        machine_id: "m",
        label: "laptop",
        machine_token: token,
      }),
      { mode: 0o600 },
    );
    process.env.OA_BUS_HOME = dir;
    delete process.env.OA_BUS_INSTANCE;
    const revoked = expect.objectContaining({ code: "REVOKED" });
    // An older daemon's marker names no token: it still holds.
    writeFileSync(join(dir, "revoked"), "{}");
    expect(() => readConfig()).toThrow(revoked);
    writeFileSync(join(dir, "revoked"), revokedMarker(token));
    expect(() => readConfig()).toThrow(revoked);
    expect(readFileSync(join(dir, "revoked"), "utf8")).not.toContain(token);
    writeFileSync(join(dir, "revoked"), revokedMarker(newMachineToken()));
    expect(() => readConfig()).not.toThrow();
  });

  it("runDaemon: a socket another daemon answers on is SOCKET_IN_USE", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "ob-sock-")), "d.sock");
    const other = createServer();
    await new Promise<void>((r) => other.listen(path, r));
    try {
      await expect(daemonHarness({ socketPath: path })).rejects.toMatchObject({
        code: "SOCKET_IN_USE",
      });
    } finally {
      other.close();
    }
  });

  it("the codes are the documented set", () => {
    expect(START_ERROR_CODES).toEqual([
      "NOT_LOGGED_IN",
      "HUB_MISMATCH",
      "BAD_HUB",
      "CREDENTIALS_OPEN",
      "CREDENTIALS_UNREADABLE",
      "REVOKED",
      "SOCKET_IN_USE",
      "SOCKET_PATH",
    ]);
  });
});
