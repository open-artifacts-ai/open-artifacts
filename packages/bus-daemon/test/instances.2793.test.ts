import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addProblem,
  defaultHomeLookup,
  instancesDir,
  listInstances,
  saveInstance,
} from "../src/instances.ts";

const TOKEN = `oa_machine_${"a".repeat(28)}7f3a`;
const scratch = () => mkdtempSync(join(tmpdir(), "ob-inst-"));

afterEach(() => vi.unstubAllEnvs());

describe("defaultHomeLookup (#2793 S1)", () => {
  it("maps every folder to main when it is the only instance, else unmapped", () => {
    const h = scratch();
    vi.stubEnv("OA_BUS_HOME", h);
    writeFileSync(
      join(h, "machine.json"),
      JSON.stringify({ hub: "https://m.example.com", machine_token: TOKEN }),
      { mode: 0o600 },
    );
    expect(defaultHomeLookup("/any/where")).toEqual({ instance: "main" });
    saveInstance(
      {
        name: "work",
        hub: "https://w.example.com",
        machine_id: "",
        label: "l",
        machine_token: TOKEN,
      },
      h,
    );
    expect(defaultHomeLookup("/any/where")).toEqual({ unmapped: true });
  });
});

describe("instance store", () => {
  it("lists only main when there is no instances folder", () => {
    const h = scratch();
    expect(listInstances(h)).toEqual([{ name: "main", hub: "", main: true }]);
    mkdirSync(instancesDir(h));
    expect(listInstances(h).map((i) => i.name)).toEqual(["main"]);
  });

  it("refuses duplicates by name and by address", () => {
    const h = scratch();
    const c = {
      name: "work",
      hub: "https://w.example.com",
      machine_id: "",
      label: "l",
      machine_token: TOKEN,
    };
    saveInstance(c, h);
    expect(addProblem("work", "https://x.example.com", h)).toMatch(/exists/);
    expect(addProblem("two", "https://w.example.com/", h)).toMatch(/work/);
    expect(() => saveInstance({ ...c, name: "two" }, h)).toThrow(/work/);
  });
});
