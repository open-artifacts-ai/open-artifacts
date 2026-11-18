import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
const made: string[] = [];
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), "ob-inst-"));
  made.push(d);
  return d;
};

afterEach(() => {
  vi.unstubAllEnvs();
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

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

describe("defaultHomeLookup without main (#2793 S1)", () => {
  it("is unmapped when only an added instance exists and there is no machine.json", () => {
    const h = scratch();
    vi.stubEnv("OA_BUS_HOME", h);
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
    expect(listInstances(h).map((i) => i.name)).toEqual(["work"]);
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
