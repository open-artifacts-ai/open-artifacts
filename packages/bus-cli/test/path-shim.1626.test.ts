import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { doctor } from "../src/commands/doctor.ts";
import { install } from "../src/commands/install.ts";
import { uninstall } from "../src/commands/uninstall.ts";
import {
  installShim,
  removeShim,
  SHIM_MARKER,
  shimState,
} from "../src/steps/path-shim.ts";
import { fakeCtx, HUB, LABEL, status, TOKEN } from "./fake.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "oa-1626-"));

/** A temp user home with a bus home, a fake launcher and entry. */
function world(over: { busHome?: string; platform?: string } = {}) {
  const userHome = tmp();
  const busHome = over.busHome ?? join(userHome, ".oa-bus");
  mkdirSync(join(busHome, "bin"), { recursive: true });
  const launcher = join(busHome, "bin", "node");
  writeFileSync(launcher, '#!/bin/sh\necho "ran:$OA_BUS_HOME:$*"\n', {
    mode: 0o755,
  });
  const argv = [launcher, join(busHome, "bin", "dist", "index.js")];
  const local = join(userHome, ".local", "bin");
  const home = join(userHome, "bin");
  const base = {
    userHome,
    busHome,
    argv,
    platform: over.platform ?? "linux",
  };
  return { ...base, local, bin: home };
}

describe("oa-bus on PATH (#1626)", () => {
  it("fresh install: a shim in ~/.local/bin when it is on PATH, and it runs the CLI", () => {
    const w = world();
    mkdirSync(w.local, { recursive: true });
    const r = installShim({ ...w, env: { PATH: `${w.local}:/usr/bin:/bin` } });
    expect(r).toMatchObject({
      kind: "installed",
      path: join(w.local, "oa-bus"),
      onPath: true,
    });
    const run = spawnSync(join(w.local, "oa-bus"), ["status", "a b"], {
      env: { PATH: "/usr/bin:/bin" },
      encoding: "utf8",
    });
    // The default home needs no OA_BUS_HOME; the arguments arrive intact.
    expect(run.stdout.trim()).toBe(`ran::${w.argv[1]} status a b`);
    expect(readFileSync(join(w.local, "oa-bus"), "utf8")).toContain(
      SHIM_MARKER,
    );
  });

  it("a dir not on PATH: makes the shim in ~/.local/bin anyway and prints the exact line", () => {
    const w = world();
    const r = installShim({ ...w, env: { PATH: "/usr/bin:/bin" } });
    expect(r).toMatchObject({
      kind: "installed",
      path: join(w.local, "oa-bus"),
      onPath: false,
      hint: 'export PATH="$HOME/.local/bin:$PATH"',
    });
    expect(existsSync(join(w.local, "oa-bus"))).toBe(true);
    // No shell profile is touched.
    expect(existsSync(join(w.userHome, ".bashrc"))).toBe(false);
    expect(existsSync(join(w.userHome, ".profile"))).toBe(false);
    expect(existsSync(join(w.userHome, ".zshrc"))).toBe(false);
  });

  it("macOS takes the first of ~/.local/bin or ~/bin that is on PATH", () => {
    const w = world({ platform: "darwin" });
    mkdirSync(w.bin, { recursive: true });
    const r = installShim({ ...w, env: { PATH: `${w.bin}:/usr/bin` } });
    expect(r).toMatchObject({ path: join(w.bin, "oa-bus"), onPath: true });
    const both = world({ platform: "darwin" });
    const r2 = installShim({
      ...both,
      env: { PATH: `${both.bin}:${both.local}` },
    });
    expect(r2).toMatchObject({ path: join(both.local, "oa-bus") });
  });

  it("re-install refreshes our shim, a symlink into the bus home included", () => {
    const w = world();
    const env = { PATH: `${w.local}:/usr/bin` };
    installShim({ ...w, env });
    const moved = [...w.argv.slice(0, 1), "/elsewhere/index.js"];
    expect(installShim({ ...w, argv: moved, env }).kind).toBe("installed");
    expect(readFileSync(join(w.local, "oa-bus"), "utf8")).toContain(
      "/elsewhere/index.js",
    );
    // A symlink pointing into the bus home is ours too.
    const s = world();
    mkdirSync(s.local, { recursive: true });
    symlinkSync(s.argv[0] as string, join(s.local, "oa-bus"));
    expect(
      installShim({ ...s, env: { PATH: `${s.local}:/usr/bin` } }).kind,
    ).toBe("installed");
    expect(lstatSync(join(s.local, "oa-bus")).isSymbolicLink()).toBe(false);
  });

  it("never overwrites a foreign oa-bus, a script or a symlink, and says so", () => {
    const w = world();
    mkdirSync(w.local, { recursive: true });
    const file = join(w.local, "oa-bus");
    writeFileSync(file, "#!/bin/sh\necho mine\n", { mode: 0o755 });
    const env = { PATH: `${w.local}:/usr/bin` };
    expect(installShim({ ...w, env })).toMatchObject({
      kind: "foreign",
      path: file,
    });
    expect(readFileSync(file, "utf8")).toBe("#!/bin/sh\necho mine\n");
    expect(removeShim(w)).toBeUndefined();
    expect(readFileSync(file, "utf8")).toBe("#!/bin/sh\necho mine\n");

    const l = world();
    mkdirSync(l.local, { recursive: true });
    const target = join(tmp(), "npm-oa-bus");
    writeFileSync(target, "x");
    symlinkSync(target, join(l.local, "oa-bus"));
    expect(
      installShim({ ...l, env: { PATH: `${l.local}:/usr/bin` } }).kind,
    ).toBe("foreign");
    expect(lstatSync(join(l.local, "oa-bus")).isSymbolicLink()).toBe(true);
    expect(removeShim(l)).toBeUndefined();
    expect(lstatSync(join(l.local, "oa-bus")).isSymbolicLink()).toBe(true);
  });

  it("uninstall removes only ours", () => {
    const w = world();
    const env = { PATH: `${w.local}:/usr/bin` };
    installShim({ ...w, env });
    expect(removeShim({ ...w, env })).toBe(join(w.local, "oa-bus"));
    expect(existsSync(join(w.local, "oa-bus"))).toBe(false);
    expect(removeShim({ ...w, env })).toBeUndefined();
  });

  it("OA_BUS_HOME: the shim carries the moved home, and only that home's uninstall removes it", () => {
    const moved = join(tmp(), "elsewhere");
    const w = world({ busHome: moved });
    const env = { PATH: `${w.local}:/usr/bin` };
    installShim({ ...w, env });
    const run = spawnSync(join(w.local, "oa-bus"), ["x"], {
      env: { PATH: "/usr/bin:/bin" },
      encoding: "utf8",
    });
    expect(run.stdout.trim()).toBe(`ran:${moved}:${w.argv[1]} x`);
    expect(removeShim({ ...w, busHome: join(tmp(), "other") })).toBeUndefined();
    expect(existsSync(join(w.local, "oa-bus"))).toBe(true);
    expect(removeShim({ ...w, env })).toBe(join(w.local, "oa-bus"));
  });

  it("Windows: no shim, nothing written", () => {
    const w = world({ platform: "win32" });
    const r = installShim({ ...w, env: { PATH: w.local } });
    expect(r.kind).toBe("skipped");
    expect(existsSync(w.local)).toBe(false);
    expect(shimState({ ...w, env: { PATH: w.local } })).toBeUndefined();
    expect(removeShim(w)).toBeUndefined();
  });

  it("state: ours on PATH, missing, another oa-bus first, ours off PATH", () => {
    const w = world();
    const env = { PATH: `${w.local}:/usr/bin` };
    installShim({ ...w, env });
    expect(shimState({ ...w, env })).toMatchObject({ kind: "ours" });
    expect(shimState({ ...w, env: { PATH: "/usr/bin" } })).toMatchObject({
      kind: "off-path",
      hint: 'export PATH="$HOME/.local/bin:$PATH"',
    });
    const other = tmp();
    writeFileSync(join(other, "oa-bus"), "#!/bin/sh\n", { mode: 0o755 });
    chmodSync(join(other, "oa-bus"), 0o755);
    expect(
      shimState({ ...w, env: { PATH: `${other}:${w.local}` } }),
    ).toMatchObject({ kind: "other", path: join(other, "oa-bus") });
    const none = world();
    expect(shimState({ ...none, env: { PATH: "/usr/bin" } })).toMatchObject({
      kind: "missing",
    });
  });
});

describe("review fixes (#1626)", () => {
  it("state skips npx's node_modules/.bin, which holds the package's own oa-bus", () => {
    const w = world();
    const env0 = { PATH: `${w.local}:/usr/bin` };
    installShim({ ...w, env: env0 });
    const npx = join(tmp(), "_npx", "abc", "node_modules", ".bin");
    mkdirSync(npx, { recursive: true });
    writeFileSync(join(npx, "oa-bus"), "#!/bin/sh\n", { mode: 0o755 });
    expect(
      shimState({ ...w, env: { PATH: `${npx}:${w.local}:/usr/bin` } }),
    ).toMatchObject({ kind: "ours", path: join(w.local, "oa-bus") });
    // Only the npx entry: nothing real on PATH.
    expect(shimState({ ...w, env: { PATH: `${npx}:/usr/bin` } })).toMatchObject(
      { kind: "off-path" },
    );
  });

  it("a project's own node_modules/.bin oa-bus is still seen", () => {
    const w = world();
    installShim({ ...w, env: { PATH: `${w.local}:/usr/bin` } });
    const proj = join(tmp(), "project", "node_modules", ".bin");
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, "oa-bus"), "#!/bin/sh\n", { mode: 0o755 });
    expect(
      shimState({ ...w, env: { PATH: `${proj}:${w.local}:/usr/bin` } }),
    ).toMatchObject({ kind: "other", path: join(proj, "oa-bus") });
  });

  it("install never replaces our shim that names another bus home", () => {
    const w = world();
    const env = { PATH: `${w.local}:/usr/bin` };
    installShim({ ...w, env });
    const x = world({ busHome: join(tmp(), "x") });
    const r = installShim({ ...x, userHome: w.userHome, env });
    expect(r).toMatchObject({
      kind: "other-home",
      path: join(w.local, "oa-bus"),
    });
    expect(readFileSync(join(w.local, "oa-bus"), "utf8")).not.toContain("/x/");
    // Uninstalling /x leaves the default home's shim alone.
    expect(removeShim({ ...x, userHome: w.userHome })).toBeUndefined();
    expect(existsSync(join(w.local, "oa-bus"))).toBe(true);
  });

  it("macOS: install refreshes our shim in the other candidate dir; uninstall removes both", () => {
    const w = world({ platform: "darwin" });
    installShim({ ...w, env: { PATH: `${w.bin}:/usr/bin` } });
    expect(existsSync(join(w.bin, "oa-bus"))).toBe(true);
    const moved = [w.argv[0] as string, "/new/index.js"];
    installShim({
      ...w,
      argv: moved,
      env: { PATH: `${w.local}:${w.bin}:/usr/bin` },
    });
    for (const d of [w.local, w.bin])
      expect(readFileSync(join(d, "oa-bus"), "utf8")).toContain(
        "/new/index.js",
      );
    expect(removeShim(w)).toBeDefined();
    expect(existsSync(join(w.local, "oa-bus"))).toBe(false);
    expect(existsSync(join(w.bin, "oa-bus"))).toBe(false);
  });

  it("a stale predictable tmp file is replaced, and the shim is executable", () => {
    const w = world();
    mkdirSync(w.local, { recursive: true });
    const stale = join(w.local, `oa-bus.${process.pid}.tmp`);
    writeFileSync(stale, "evil", { mode: 0o666 });
    installShim({ ...w, env: { PATH: `${w.local}:/usr/bin` } });
    expect(existsSync(stale)).toBe(false);
    expect(lstatSync(join(w.local, "oa-bus")).mode & 0o777).toBe(0o755);
    // A symlink planted at the tmp name is not written through.
    const target = join(tmp(), "victim");
    writeFileSync(target, "keep");
    symlinkSync(target, stale);
    installShim({ ...w, env: { PATH: `${w.local}:/usr/bin` } });
    expect(readFileSync(target, "utf8")).toBe("keep");
  });
});

describe("the commands (#1626)", () => {
  const withService = (w: ReturnType<typeof world>) => ({
    ...({} as object),
    cli: () => w.argv,
    argv: () => w.argv,
    ensure: async () => ({}),
    remove: async () => ({}),
  });

  it("doctor reports the shim and the fix", async () => {
    const w = world({ platform: "linux" });
    const ctx = fakeCtx({
      userHome: w.userHome,
      home: w.busHome,
      platform: "linux x64",
      env: { PATH: "/usr/bin" },
      service: withService(w) as never,
    });
    await doctor(ctx);
    expect(ctx.all().join("\n")).toMatch(/oa-bus is not on your PATH/);
    expect(ctx.all().join("\n")).toContain("install to add it");
  });

  it("doctor gives the PATH line when the shim exists but its dir is off PATH", async () => {
    const w = world();
    installShim({ ...w, env: { PATH: "/usr/bin" } });
    const ctx = fakeCtx({
      userHome: w.userHome,
      home: w.busHome,
      platform: "linux x64",
      env: { PATH: "/usr/bin" },
      service: withService(w) as never,
    });
    await doctor(ctx);
    expect(ctx.all().join("\n")).toContain(
      'To fix it, add this line to your shell profile: export PATH="$HOME/.local/bin:$PATH"',
    );
  });

  it("doctor passes when PATH resolves to this install", async () => {
    const w = world();
    installShim({ ...w, env: { PATH: `${w.local}:/usr/bin` } });
    const ctx = fakeCtx({
      userHome: w.userHome,
      home: w.busHome,
      platform: "linux x64",
      env: { PATH: `${w.local}:/usr/bin` },
      service: withService(w) as never,
    });
    await doctor(ctx);
    expect(ctx.all().join("\n")).toMatch(
      /oa-bus on your PATH runs this install/,
    );
  });

  it("install writes the shim and prints the lines; uninstall removes it", async () => {
    const w = world();
    mkdirSync(w.local, { recursive: true });
    const ctx = fakeCtx({
      userHome: w.userHome,
      home: w.busHome,
      platform: "linux x64",
      env: { PATH: `${w.local}:/usr/bin` },
      service: withService(w) as never,
    });
    mkdirSync(w.busHome, { recursive: true });
    const file = join(w.busHome, "machine.json");
    writeFileSync(
      file,
      JSON.stringify({
        hub: HUB,
        machine_id: "m",
        label: LABEL,
        machine_token: TOKEN,
      }),
    );
    chmodSync(file, 0o600);
    ctx.status = (async () => status()) as never;
    await install({ noOpen: true }, ctx);
    expect(ctx.all().join("\n")).toContain("Installed the oa-bus command");
    expect(existsSync(join(w.local, "oa-bus"))).toBe(true);
    const un = fakeCtx({
      userHome: w.userHome,
      home: w.busHome,
      platform: "linux x64",
      env: { PATH: `${w.local}:/usr/bin` },
      service: withService(w) as never,
    });
    await uninstall({ purge: false }, un);
    expect(un.all().join("\n")).toContain(
      "Removed the oa-bus command: ~/.local/bin/oa-bus",
    );
    expect(existsSync(join(w.local, "oa-bus"))).toBe(false);
  });
});
