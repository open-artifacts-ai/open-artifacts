import { chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MachineLabelSchema, newMachineToken } from "@oa/bus-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { readConfig } from "../src/config.ts";

const prev = process.env.OA_BUS_HOME;
afterEach(() => {
  if (prev === undefined) delete process.env.OA_BUS_HOME;
  else process.env.OA_BUS_HOME = prev;
});

describe("readConfig", () => {
  it("fails with 'not logged in' when machine.json is missing the token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ob-cfg-"));
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      join(dir, "machine.json"),
      JSON.stringify({ hub: "wss://h" }),
    );
    chmodSync(join(dir, "machine.json"), 0o600);
    process.env.OA_BUS_HOME = dir;
    expect(() => readConfig()).toThrow(/not logged in/);
  });

  it("sanitizes a stored label the hub would reject", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ob-cfg-"));
    const { writeFileSync } = await import("node:fs");
    const base = {
      hub: "wss://h",
      machine_token: newMachineToken(),
    };
    const read = (label: unknown) => {
      writeFileSync(
        join(dir, "machine.json"),
        JSON.stringify({ ...base, label }),
      );
      chmodSync(join(dir, "machine.json"), 0o600);
      process.env.OA_BUS_HOME = dir;
      return readConfig().label;
    };
    for (const label of [
      " laptop\u200b",
      "\u200b",
      "x".repeat(300),
      "a\u202Eb",
    ])
      expect(MachineLabelSchema.safeParse(read(label)).success).toBe(true);
    expect(read("laptop")).toBe("laptop");
    expect(read(42)).toBe("machine");
  });
});
