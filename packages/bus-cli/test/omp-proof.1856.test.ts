// #1856: omp's extension wraps fetch for the instance's /mcp only, and learns
// the instance origin from a file install writes beside the other bus files.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type AdapterDeps,
  installAdapters,
  OMP_ORIGIN_FILE,
  uninstallAdapters,
} from "../src/steps/adapters.ts";

const HUB = "https://oa.example.com";
const setup = (over: Partial<AdapterDeps> = {}, omp = true) => {
  const h = mkdtempSync(join(tmpdir(), "ob-omp1856-inst-"));
  if (omp) mkdirSync(join(h, ".omp/agent"), { recursive: true });
  const deps: AdapterDeps = {
    home: h,
    env: {},
    hub: HUB,
    busBin: ["/usr/local/bin/oa-bus"],
    assets: { pi: "PI", opencodePlugin: "JS" },
    which: (c) => omp && c === "omp",
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    ...over,
  };
  return { h, deps, file: join(h, ".oa-bus", OMP_ORIGIN_FILE) };
};

describe("oa-bus install and uninstall, omp instance origin (#1856)", () => {
  it("install writes the instance origin for omp, readable by its owner only", async () => {
    const s = setup();
    await installAdapters(s.deps);
    expect(JSON.parse(readFileSync(s.file, "utf8"))).toEqual({ origin: HUB });
    expect(statSync(s.file).mode & 0o777).toBe(0o600);
  });

  it("writes only the origin, whatever the hub URL carried", async () => {
    const s = setup({ hub: `${HUB}/some/path?x=1` });
    await installAdapters(s.deps);
    expect(JSON.parse(readFileSync(s.file, "utf8"))).toEqual({ origin: HUB });
  });

  it("writes nothing without omp, or without a hub", async () => {
    const a = setup({}, false);
    await installAdapters(a.deps);
    expect(existsSync(a.file)).toBe(false);
    const b = setup({ hub: undefined });
    await installAdapters(b.deps);
    expect(existsSync(b.file)).toBe(false);
  });

  it("writes it when Pi and omp share one extension file", async () => {
    const d = mkdtempSync(join(tmpdir(), "ob-omp1856-shared-"));
    const s = setup({
      env: { PI_CODING_AGENT_DIR: d },
      which: (c) => c === "pi" || c === "omp",
    });
    await installAdapters(s.deps);
    expect(JSON.parse(readFileSync(s.file, "utf8"))).toEqual({ origin: HUB });
  });

  it("uninstall removes it", async () => {
    const s = setup();
    await installAdapters(s.deps);
    await uninstallAdapters(s.deps);
    expect(existsSync(s.file)).toBe(false);
  });

  it("the extension reads the file install writes", () => {
    const asset = readFileSync(
      join(__dirname, "../../bus-adapter-pi/assets/oa-bus.ts"),
      "utf8",
    );
    expect(asset).toContain(`"${OMP_ORIGIN_FILE}"`);
  });
});
