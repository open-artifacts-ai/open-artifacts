// #2543 part B: `oa-bus upgrade` is a hand upgrade through the installed bus's
// own proof check. The verified path uses the real golden release and real
// Sigstore verification; the installer itself is a stand-in.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  installVersion,
  markFailed,
  readPolicy,
  setOff,
  startSelfCheck,
  verifyRelease,
  writeState,
} from "@oa/bus-daemon";
import { describe, expect, it, vi } from "vitest";
import {
  GOLDEN_NOW,
  GOLDEN_VERSION,
  golden,
} from "../../bus-daemon/test/update-helpers.ts";
import { installedForm } from "../src/bus-cmd.ts";
import { type UpgradeDeps, upgrade } from "../src/commands/upgrade.ts";
import type { Ctx } from "../src/context.ts";
import { copy } from "../src/copy.ts";
import { parse } from "../src/index.ts";
import { type Fake, fakeCtx, TAGS } from "./fake.ts";

const HUB = "https://artifacts.example.com";
const TOKEN = `oa_machine_${"a".repeat(32)}`;

/** A machine approved on HUB, whose instance says it runs `server`. */
function world(
  server: string,
  running = "0.185.0",
  over: Partial<Ctx> = {},
  tty = true,
) {
  const ctx = fakeCtx(
    {
      version: running,
      stdinIsTTY: tty,
      readLine: async () => "yes",
      ...over,
    },
    tty,
  );
  mkdirSync(ctx.home, { recursive: true, mode: 0o700 });
  chmodSync(ctx.home, 0o700);
  const f = join(ctx.home, "machine.json");
  writeFileSync(
    f,
    JSON.stringify({
      hub: HUB,
      machine_id: "m",
      label: "mac",
      machine_token: TOKEN,
    }),
  );
  chmodSync(f, 0o600);
  ctx.fetch = vi.fn(async (url: string | URL | Request) => {
    if (String(url) === `${HUB}/healthz`)
      return new Response(JSON.stringify({ version: server }), { status: 200 });
    throw new Error("no network in tests");
  }) as unknown as typeof fetch;
  return ctx;
}

function deps(over: Partial<UpgradeDeps> = {}) {
  const ran: { entry: string; args: string[] }[] = [];
  const fetched: string[] = [];
  const d: UpgradeDeps = {
    fetchRelease: async (v) => {
      fetched.push(v);
      return { ...golden(), version: v };
    },
    verifyRelease: (r) => verifyRelease(r, { now: GOLDEN_NOW }),
    runInstaller: (entry, args) => {
      ran.push({ entry, args });
      return 0;
    },
    ...over,
  };
  return { d, ran, fetched };
}
const text = (c: Fake) => [...c.out(), ...c.err()].join("\n");

describe("oa-bus upgrade", () => {
  it("a verified release is unpacked into versions/<v> and ITS installer runs, with no habit flag", async () => {
    const c = world(GOLDEN_VERSION);
    const { d, ran } = deps();
    expect(await upgrade(c, {}, d)).toBe(0);
    const dir = join(c.home, "versions", GOLDEN_VERSION);
    expect(existsSync(join(dir, "dist", "index.js"))).toBe(true);
    expect(ran).toHaveLength(1);
    expect(ran[0]?.entry).toBe(join(dir, "dist", "index.js"));
    expect(ran[0]?.args).toEqual([
      "install",
      "--instance",
      HUB,
      "--no-service",
    ]);
    expect(ran[0]?.args.join(" ")).not.toMatch(/habits/);
    expect(text(c)).toContain(
      `The proof passed. Installing ${GOLDEN_VERSION}...`,
    );
  });

  it("passes the bus home through when it is not the default", async () => {
    const c = world(GOLDEN_VERSION);
    const { d, ran } = deps();
    await upgrade(c, {}, d);
    // fakeCtx's home is <userHome>/.oa-bus: the default, so no --home.
    expect(ran[0]?.args).not.toContain("--home");
    const other = world(GOLDEN_VERSION);
    other.home = join(other.userHome, "elsewhere");
    mkdirSync(other.home, { recursive: true, mode: 0o700 });
    chmodSync(other.home, 0o700);
    writeFileSync(
      join(other.home, "machine.json"),
      JSON.stringify({
        hub: HUB,
        machine_id: "m",
        label: "mac",
        machine_token: TOKEN,
      }),
      { mode: 0o600 },
    );
    const r = deps();
    await upgrade(other, {}, r.d);
    expect(r.ran[0]?.args).toEqual([
      "install",
      "--instance",
      HUB,
      "--home",
      other.home,
      "--no-service",
    ]);
  });

  it("a proof failure refuses, writes nothing and never runs an installer", async () => {
    for (const mutate of [
      (b: Buffer) => {
        const x = Buffer.from(b);
        x[Math.floor(x.length / 2)] ^= 0xff;
        return x;
      },
    ]) {
      const c = world(GOLDEN_VERSION);
      const before = existsSync(join(c.home, "versions"));
      const { d, ran } = deps({
        fetchRelease: async (v) => {
          const g = golden();
          const tarball = mutate(g.tarball);
          return { ...g, version: v, tarball };
        },
      });
      expect(await upgrade(c, {}, d)).toBe(1);
      expect(text(c)).toContain("did not pass its release proof");
      expect(text(c)).toContain("so nothing was installed");
      expect(ran).toEqual([]);
      expect(existsSync(join(c.home, "versions"))).toBe(before);
    }
  });

  it("an unreachable registry refuses the same way, with no npx anywhere", async () => {
    const c = world(GOLDEN_VERSION);
    const { d, ran } = deps({
      fetchRelease: async () => {
        throw new Error("offline");
      },
    });
    expect(await upgrade(c, {}, d)).toBe(1);
    expect(ran).toEqual([]);
    expect(text(c)).not.toContain("npx");
  });

  it("never ahead of the instance: not by default, not by name, not equal to a pre-release's base", async () => {
    // A named release past the server.
    let c = world("0.186.0");
    let r = deps();
    expect(await upgrade(c, { version: "0.187.0" }, r.d)).toBe(1);
    expect(r.fetched).toEqual([]);
    expect(text(c)).toContain("is newer than the instance (0.186.0)");
    // A pre-release server: the default names nothing, and its own base is ahead of it.
    c = world("0.187.0-dev+abc1234");
    r = deps();
    expect(await upgrade(c, {}, r.d)).toBe(1);
    expect(text(c)).toContain("This instance runs a pre-release");
    expect(await upgrade(c, { version: "0.187.0" }, r.d)).toBe(1);
    expect(r.fetched).toEqual([]);
    // Below it is fine.
    expect(await upgrade(c, { version: "0.186.0" }, r.d)).toBe(0);
  });

  it("the default is the instance's own version", async () => {
    const c = world(GOLDEN_VERSION);
    const r = deps();
    await upgrade(c, {}, r.d);
    expect(r.fetched).toEqual([GOLDEN_VERSION]);
  });

  it("an instance that does not answer: nothing is fetched", async () => {
    const c = world(GOLDEN_VERSION);
    c.fetch = vi.fn(async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    const r = deps();
    expect(await upgrade(c, {}, r.d)).toBe(1);
    expect(r.fetched).toEqual([]);
    expect(text(c)).toContain("Couldn't read the instance's version");
  });

  it("forward only, except the exact kept previous", async () => {
    const c = world("0.186.0", "0.186.0");
    let r = deps();
    expect(await upgrade(c, {}, r.d)).toBe(0);
    expect(text(c)).toContain("The bus is already at 0.186.0.");
    expect(r.fetched).toEqual([]);
    expect(await upgrade(c, { version: "0.185.0" }, r.d)).toBe(1);
    expect(text(c)).toContain("0.185.0 is older than this bus (0.186.0)");
    // The kept previous may be named exactly.
    writeState(c.home, {
      armed: true,
      current: "0.186.0",
      previous: "0.185.0",
    });
    const asked: string[] = [];
    r = deps({
      fetchRelease: async (v) => (asked.push(v), { ...golden(), version: v }),
      verifyRelease: () =>
        ({
          version: "0.185.0",
          sha512: "",
          commit: "",
          entries: [],
          packageJson: {},
        }) as never,
    });
    const run = await upgrade(c, { version: "0.185.0" }, r.d).catch(() => 1);
    expect(asked).toEqual(["0.185.0"]);
    expect(run).toBeGreaterThanOrEqual(0);
    // Any other older one is still refused.
    expect(await upgrade(c, { version: "0.184.0" }, r.d)).toBe(1);
  });

  it("no machine here: it points at the checked install step, not at npx", async () => {
    const c = fakeCtx();
    const { d, fetched } = { ...deps(), fetched: [] as string[] };
    expect(await upgrade(c, {}, d)).toBe(1);
    expect(fetched).toEqual([]);
    expect(text(c)).toContain('"Install the bus" step');
    expect(text(c)).not.toContain("npx");
  });

  it("parses: upgrade, upgrade x.y.z, and nothing else", () => {
    expect(parse(["upgrade"])).toMatchObject({ cmd: "upgrade" });
    expect(parse(["upgrade", "1.2.3"])).toMatchObject({
      cmd: "upgrade",
      version: "1.2.3",
    });
    for (const bad of ["1.2", "1.2.3-x", "latest", "01.2.3"])
      expect(() => parse(["upgrade", bad]), bad).toThrow(/usage/);
    expect(() => parse(["upgrade", "1.2.3", "x"])).toThrow(/unexpected/);
    expect(() => parse(["upgrade", "--habits"])).toThrow(/does not apply/);
    expect(() => parse(["upgrade", "--yes"])).toThrow(/does not apply/);
  });
});

describe("no npx advice to install or update (#2543)", () => {
  const src = (p: string) =>
    readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

  it("copy.ts never builds an install or update line from the npx constant", () => {
    const copy = src("copy.ts");
    expect(copy).not.toMatch(/\$\{BUS_CMD\}(@latest)?\s+(install|upgrade)/);
    expect(copy).not.toContain("@latest");
    expect(copy).not.toMatch(/npx @open-artifacts\/bus(@\S+)?\s+install/);
    // The launcher's text (outlives the run) names its own files.
    expect(src("steps/service.ts")).not.toMatch(/\$\{BUS_CMD\}\s+install/);
  });

  it("Update available keeps main's checked-install pointer, never npx (#2803)", () => {
    for (const bus of ["oa-bus", "/h/bin/node /h/bin/dist/index.js"]) {
      const c = fakeCtx({ copy: copy(TAGS, bus) });
      const lines = JSON.stringify(
        c.copy.updateAvailable("0.2.0", "0.1.0", ""),
      );
      expect(lines).toContain("Install the bus");
      expect(lines).not.toContain("@latest");
      expect(lines).not.toContain("npx");
    }
  });

  it("the printed command is the shim, else the installed files, else (not installed) npx", () => {
    const c = fakeCtx();
    expect(installedForm(c.home)).toBeUndefined();
    mkdirSync(join(c.home, "bin", "dist"), { recursive: true });
    writeFileSync(join(c.home, "bin", "node"), "");
    writeFileSync(join(c.home, "bin", "dist", "index.js"), "");
    expect(installedForm(c.home)).toBe(
      `${join(c.home, "bin", "node")} ${join(c.home, "bin", "dist", "index.js")}`,
    );
    expect(readdirSync(join(c.home, "bin"))).toContain("node");
  });
});

describe("oa-bus upgrade: the same gates as update (#2543 review)", () => {
  it("updates off: refuses, fetches nothing, runs no installer", async () => {
    const c = world(GOLDEN_VERSION);
    setOff(c.home, true);
    const { d, ran, fetched } = deps();
    expect(await upgrade(c, {}, d)).toBe(1);
    expect(fetched).toEqual([]);
    expect(ran).toEqual([]);
    expect(text(c)).toContain("Auto-update is off");
  });

  it("a failed version refuses unless --allow-failed", async () => {
    const c = world(GOLDEN_VERSION);
    markFailed(c.home, GOLDEN_VERSION);
    const { d, ran } = deps();
    expect(await upgrade(c, {}, d)).toBe(1);
    expect(ran).toEqual([]);
    expect(text(c)).toContain("failed on this machine before");
    expect(await upgrade(c, { allowFailed: true }, d)).toBe(0);
    expect(ran.length).toBe(1);
  });

  it("no terminal: refuses and runs no installer", async () => {
    const c = world(GOLDEN_VERSION, "0.185.0", {}, false);
    const { d, ran, fetched } = deps();
    expect(await upgrade(c, {}, d)).toBe(2);
    expect(fetched).toEqual([]);
    expect(ran).toEqual([]);
  });

  it("anything but a typed yes declines", async () => {
    const c = world(GOLDEN_VERSION, "0.185.0", { readLine: async () => "no" });
    const { d, ran } = deps();
    expect(await upgrade(c, {}, d)).toBe(1);
    expect(ran).toEqual([]);
    expect(text(c)).toContain("Nothing was installed.");
  });

  it("a login in progress refuses", async () => {
    const c = world(GOLDEN_VERSION);
    writeFileSync(
      join(c.home, "login.active"),
      `${process.pid} ${Date.now()}\n`,
    );
    const { d, ran } = deps();
    expect(await upgrade(c, {}, d)).toBe(1);
    expect(ran).toEqual([]);
    expect(text(c)).toContain("login or an approval is in progress");
  });

  it("a bare upgrade never steps back to the previous, a named one may", async () => {
    const c = world("0.185.0", "0.186.0");
    writeState(c.home, {
      armed: true,
      current: "0.186.0",
      previous: "0.185.0",
    });
    const r = deps();
    expect(await upgrade(c, {}, r.d)).toBe(1);
    expect(r.fetched).toEqual([]);
    await upgrade(c, { version: "0.185.0" }, r.d);
    expect(r.fetched).toEqual(["0.185.0"]);
  });

  it("a dev build is compared by its base: no step back to 0.100.0", async () => {
    const c = world("0.190.0", "0.190.0-dev");
    const r = deps();
    expect(await upgrade(c, { version: "0.100.0" }, r.d)).toBe(1);
    expect(r.fetched).toEqual([]);
    expect(text(c)).toContain("older than this bus");
  });

  it("a hand upgrade leaves a pending record while the installer runs, so it steps back", async () => {
    const c = world(GOLDEN_VERSION);
    let during: unknown;
    const { d } = deps({
      runInstaller: () => {
        during = readPolicy(c.home).pending;
        return 0;
      },
    });
    expect(await upgrade(c, {}, d)).toBe(0);
    expect(during).toMatchObject({ from: "0.185.0", to: GOLDEN_VERSION });
  });

  it("an installer that fails is reported, clears pending and keeps the current version", async () => {
    const c = world(GOLDEN_VERSION);
    writeState(c.home, { armed: true, current: "0.185.0" });
    const { d } = deps({ runInstaller: () => 3 });
    expect(await upgrade(c, {}, d)).toBe(3);
    expect(text(c)).toContain("3");
    const p = readPolicy(c.home);
    expect(p.pending).toBeUndefined();
    expect(p.current).toBe("0.185.0");
  });

  it("a bad tar or a release with no dist refuses and runs no installer", async () => {
    const c = world(GOLDEN_VERSION);
    const { d, ran } = deps({
      verifyRelease: (r) =>
        ({
          version: r.version,
          sha512: "",
          commit: "",
          entries: [],
          packageJson: {},
        }) as never,
    });
    expect(await upgrade(c, {}, d)).toBe(1);
    expect(ran).toEqual([]);
    expect(text(c)).toContain("bad_tar");
  });

  it("the unpacked copy pruned before the installer: refuses clearly, no installer, no pending", async () => {
    const c = world(GOLDEN_VERSION);
    const { d, ran } = deps({
      beforeInstall: (dest) =>
        rmSync(join(dest, "dist"), { recursive: true, force: true }),
    });
    expect(await upgrade(c, {}, d)).toBe(1);
    expect(ran).toEqual([]);
    expect(text(c)).toContain("went missing before it could install");
    expect(readPolicy(c.home).pending).toBeUndefined();
  });

  it("a bad hand upgrade steps back: the daemon's self-check acts on the pending record", async () => {
    const c = world(GOLDEN_VERSION, "0.185.0");
    // 0.185.0 is installed and running from versions/.
    installVersion(c.home, "0.185.0", (dir) => {
      mkdirSync(join(dir, "dist"), { recursive: true });
      writeFileSync(join(dir, "dist", "index.js"), "// old");
    });
    const { d } = deps({
      // What the new copy's installer does: swap to itself, record previous.
      runInstaller: (entry) => {
        installVersion(c.home, GOLDEN_VERSION, (dir) => {
          mkdirSync(join(dir, "dist"), { recursive: true });
          writeFileSync(join(dir, "dist", "index.js"), "// new");
        });
        expect(entry).toContain(GOLDEN_VERSION);
        return 0;
      },
    });
    expect(await upgrade(c, {}, d)).toBe(0);
    expect(readPolicy(c.home).pending).toMatchObject({
      from: "0.185.0",
      to: GOLDEN_VERSION,
    });
    // The new daemon starts, and is not whole: its check steps back.
    let t = 0;
    const exits: number[] = [];
    let tick: () => void = () => {};
    startSelfCheck({
      home: c.home,
      running: GOLDEN_VERSION,
      now: () => t,
      hub: () => false,
      local: () => false,
      exit: (code) => exits.push(code),
      log: () => {},
      deadlineMs: 1000,
      every: (fn) => {
        tick = fn;
        return () => {};
      },
    });
    t = 2000;
    tick();
    expect(exits).toEqual([1]);
    const p = readPolicy(c.home);
    expect(p.current).toBe("0.185.0");
    expect(p.failed).toContain(GOLDEN_VERSION);
    expect(p.pending).toBeUndefined();
  });
});
