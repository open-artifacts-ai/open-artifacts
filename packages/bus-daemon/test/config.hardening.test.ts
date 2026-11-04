import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readConfig } from "../src/config.ts";

const TOKEN = `oa_machine_${"2".repeat(32)}`;
const env = { ...process.env };
afterEach(() => {
  process.env = { ...env };
});
function home(body: string, mode = 0o600) {
  const d = mkdtempSync(join(tmpdir(), "ob-adv-"));
  writeFileSync(join(d, "machine.json"), body);
  chmodSync(join(d, "machine.json"), mode);
  process.env.OA_BUS_HOME = d;
  delete process.env.OA_BUS_HUB;
}

describe("readConfig hardening", () => {
  it("a corrupted machine.json does not leak the token in the thrown error", () => {
    home('{"hub":"wss://h","machine_token":"oa_machine_SECRETSECRET" x}');
    let msg = "";
    try {
      readConfig();
    } catch (e) {
      msg = String((e as Error).message);
    }
    expect(msg).not.toBe("");
    expect(msg).not.toContain("SECRET");
  });

  it("refuses plain ws:// to a remote host (bearer token in the clear)", () => {
    home(
      JSON.stringify({ hub: "ws://bus.example.com/hub", machine_token: TOKEN }),
    );
    expect(() => readConfig()).toThrow();
  });

  it("refuses an OA_BUS_HUB override to plain ws:// on a remote host", () => {
    home(
      JSON.stringify({
        hub: "wss://bus.example.com/hub",
        machine_token: TOKEN,
      }),
    );
    process.env.OA_BUS_HUB = "ws://evil.example.com/hub";
    expect(() => readConfig()).toThrow();
  });

  it("refuses a machine.json readable by group/other", () => {
    home(JSON.stringify({ hub: "wss://h/hub", machine_token: TOKEN }), 0o644);
    expect(() => readConfig()).toThrow();
  });

  it("refuses a non-string machine_token", () => {
    home(JSON.stringify({ hub: "wss://h/hub", machine_token: 12345 }));
    expect(() => readConfig()).toThrow();
  });

  it("a JSON null machine.json gives the login error, not a TypeError", () => {
    home("null");
    expect(() => readConfig()).toThrow(/not logged in/);
  });

  it("accepts wss and loopback ws with a valid token", () => {
    home(
      JSON.stringify({ hub: "ws://127.0.0.1:8787/hub", machine_token: TOKEN }),
    );
    expect(readConfig().hub).toBe("ws://127.0.0.1:8787/hub");
    home(
      JSON.stringify({
        hub: "wss://bus.example.com/hub",
        machine_token: TOKEN,
      }),
    );
    expect(readConfig().machine_token).toBe(TOKEN);
  });

  it("refuses a malformed token and a non-object machine.json", () => {
    home(JSON.stringify({ hub: "wss://h/hub", machine_token: "oa_machine_x" }));
    expect(() => readConfig()).toThrow(/token/);
    home("[1]");
    expect(() => readConfig()).toThrow(/not logged in/);
  });

  it("tells the user to chmod 600", () => {
    home(JSON.stringify({ hub: "wss://h/hub", machine_token: TOKEN }), 0o644);
    expect(() => readConfig()).toThrow(/chmod 600/);
  });

  it("refuses an OA_BUS_HUB on another origin: the token goes only to the hub that issued it", () => {
    home(
      JSON.stringify({ hub: "https://bus.example.com", machine_token: TOKEN }),
    );
    process.env.OA_BUS_HUB = "https://other.example.org";
    let msg = "";
    try {
      readConfig();
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/other\.example\.org.*bus\.example\.com/);
    expect(msg).not.toContain(TOKEN);
  });

  it("accepts an OA_BUS_HUB on the same origin, ws or http alike", () => {
    home(
      JSON.stringify({ hub: "https://bus.example.com", machine_token: TOKEN }),
    );
    process.env.OA_BUS_HUB = "wss://bus.example.com/";
    expect(readConfig().hub).toBe("wss://bus.example.com/");
  });
});
