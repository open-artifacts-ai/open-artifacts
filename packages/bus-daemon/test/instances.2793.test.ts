import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addProblem,
  credentialsFor,
  defaultHomeLookup,
  instanceChecks,
  instanceFile,
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

describe("instance key file checks (#2793 S1b)", () => {
  const c = {
    name: "work",
    hub: "https://w.example.com",
    machine_id: "",
    label: "l",
    machine_token: TOKEN,
  };
  const posixOnly = process.platform === "win32" ? it.skip : it;

  posixOnly("reads a file saved by saveInstance", () => {
    const h = scratch();
    saveInstance(c, h);
    expect(credentialsFor("work", h).machine_token).toBe(TOKEN);
    expect(listInstances(h).map((i) => i.name)).toEqual(["work"]);
  });

  posixOnly("refuses a symlinked key file", () => {
    const h = scratch();
    saveInstance(c, h);
    const real = join(h, "real.json");
    writeFileSync(real, "{}", { mode: 0o600 });
    rmSync(instanceFile("work", h));
    symlinkSync(real, instanceFile("work", h));
    expect(() => credentialsFor("work", h)).toThrow(/not a link/);
    expect(listInstances(h).find((i) => i.name === "work")?.hub).toBe("");
  });

  posixOnly("refuses a symlinked instances folder", () => {
    const h = scratch();
    const other = scratch();
    saveInstance(c, h);
    const elsewhere = join(other, "instances");
    mkdirSync(elsewhere, { mode: 0o700 });
    writeFileSync(join(elsewhere, "work.json"), "{}", { mode: 0o600 });
    rmSync(join(h, "instances"), { recursive: true });
    symlinkSync(elsewhere, join(h, "instances"));
    expect(() => credentialsFor("work", h)).toThrow(/real folder/);
    expect(() =>
      saveInstance({ ...c, name: "two", hub: "https://t.example.com" }, h),
    ).toThrow(/real folder/);
    expect(listInstances(h).map((i) => i.name)).toEqual(["work"]);
  });

  posixOnly("refuses a key file owned by someone else", () => {
    const h = scratch();
    saveInstance(c, h);
    const file = instanceFile("work", h);
    const real = instanceChecks.lstat;
    const spy = vi.spyOn(instanceChecks, "lstat").mockImplementation(((
      p: string,
    ) => {
      const st = real(p);
      return p === file
        ? Object.assign(Object.create(Object.getPrototypeOf(st)), st, {
            uid: st.uid + 1,
          })
        : st;
    }) as typeof real);
    try {
      expect(() => credentialsFor("work", h)).toThrow(
        /cannot read .*work\.json: it must belong to you/,
      );
    } finally {
      spy.mockRestore();
    }
  });

  posixOnly("refuses a folder owned by someone else", () => {
    const h = scratch();
    saveInstance(c, h);
    const spy = vi
      .spyOn(instanceChecks, "uid")
      .mockReturnValue((process.getuid?.() ?? 0) + 1);
    try {
      expect(() => credentialsFor("work", h)).toThrow(
        /instances must belong to you/,
      );
    } finally {
      spy.mockRestore();
    }
  });

  posixOnly("refuses an instances folder with group or other bits", () => {
    const h = scratch();
    saveInstance(c, h);
    chmodSync(join(h, "instances"), 0o755);
    expect(() => credentialsFor("work", h)).toThrow(/chmod 700/);
  });

  posixOnly("an open instances folder keeps the folder unmapped", () => {
    const h = scratch();
    vi.stubEnv("OA_BUS_HOME", h);
    writeFileSync(
      join(h, "machine.json"),
      JSON.stringify({ hub: "https://m.example.com", machine_token: TOKEN }),
      { mode: 0o600 },
    );
    saveInstance(c, h);
    chmodSync(join(h, "instances"), 0o755);
    expect(listInstances(h).map((i) => i.name)).toEqual(["main", "work"]);
    expect(defaultHomeLookup("/any/where")).toEqual({ unmapped: true });
    expect(addProblem("again", "https://w.example.com", h)).toMatch(
      /open to other users/,
    );
  });

  posixOnly("refuses a key file with group or other bits", () => {
    const h = scratch();
    saveInstance(c, h);
    chmodSync(instanceFile("work", h), 0o644);
    expect(() => credentialsFor("work", h)).toThrow(/chmod 600/);
  });

  posixOnly(
    "saveInstance keeps the folder 0700 and the file 0600",
    async () => {
      const h = scratch();
      saveInstance(c, h);
      const { statSync } = await import("node:fs");
      expect(statSync(join(h, "instances")).mode & 0o777).toBe(0o700);
      expect(statSync(instanceFile("work", h)).mode & 0o777).toBe(0o600);
    },
  );

  it("a home with only machine.json lists main and is unaffected", () => {
    const h = scratch();
    writeFileSync(
      join(h, "machine.json"),
      JSON.stringify({ hub: "https://m.example.com" }),
      { mode: 0o600 },
    );
    expect(listInstances(h)).toEqual([
      { name: "main", hub: "https://m.example.com", main: true },
    ]);
  });
});
